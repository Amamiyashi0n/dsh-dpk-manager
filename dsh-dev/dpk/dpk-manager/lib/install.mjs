/**
 * Installation: verify → materialise into the local store → hand the extracted
 * directory to DSH's own installer.
 *
 * The division of labour is the point of the format: dpk owns transport and
 * integrity, DSH owns installation and activation. `dsh plugin --profile <p>
 * install <abs path>` runs pnpm in the profile, writes the dependency, and
 * appends a newly installed bundle to `dsh.profile.bundles`
 * (`packages/boot/plugin-manager/src/operations.ts:160,78-96`) — exactly the
 * behaviour an ordinary local path install has, which is why a DPK install
 * leaves nothing exotic behind.
 *
 * @module dpk/lib/install
 */

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { verifyArchive, extractPackageTree } from './verify.mjs'
import { retainArchive, recordInstall, storeDir, dpkRoot } from './store.mjs'
import { archiveFileName } from './dpk-manifest.mjs'

/** An install that could not complete. */
export class DpkInstallError extends Error {
  constructor(message, code = 'DPK_INSTALL_FAILED', detail = {}) {
    super(message)
    this.name = 'DpkInstallError'
    this.code = code
    this.detail = detail
  }
}

/** Follow a junction/symlink chain to the checkout that owns a profile's Harness packages. */
function checkoutFromJunction(home) {
  for (const candidate of [
    join(home, 'node_modules', '@deepseek-ai'),
    ...(process.env.DSH_PROFILE_DIR === undefined
      ? []
      : [join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai')]),
  ]) {
    try {
      const target = realpathSync(candidate)
      // <checkout>/node_modules/@deepseek-ai
      const checkout = dirname(dirname(target))
      if (existsSync(join(checkout, 'apps', 'cli', 'lib', 'bin.js'))) return checkout
    } catch {
      // A missing junction is expected on machines without a checkout install.
    }
  }
  return undefined
}

/** Quote one token for the rare shell path (Windows `.cmd` shims). */
function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`
}

/**
 * Run a resolved CLI invocation.
 *
 * A Windows `.cmd`/`.bat` shim needs a shell, and Node deprecates `shell: true`
 * together with an argument array, so those are passed as one quoted command
 * line; every other invocation keeps the argument array.
 */
export function runCommand(argv, options = {}) {
  const stdio = options.stdio ?? 'inherit'
  const needsShell = process.platform === 'win32'
    && (argv[0] === 'dsh' || /\.(?:cmd|bat)$/i.test(argv[0]))
  if (needsShell) return spawnSync(argv.map(shellQuote).join(' '), { stdio, shell: true })
  return spawnSync(argv[0], argv.slice(1), { stdio })
}

/**
 * Resolve how to invoke the DSH CLI.
 * Order: explicit `dsh` option, `$DPK_DSH`, `dsh` on PATH, then the checkout
 * discovered through the Harness junctions. Every form is announced, so the
 * caller can always see which binary actually ran.
 * @returns `{ argv, label }`, or undefined when nothing was found.
 */
export function resolveDshCli(options = {}) {
  const explicit = options.dsh ?? process.env.DPK_DSH
  if (typeof explicit === 'string' && explicit !== '') {
    return { argv: [explicit], label: explicit }
  }
  if (explicit !== undefined) return { argv: explicit, label: explicit.join(' ') }

  const probe = process.platform === 'win32'
    ? spawnSync('dsh --version', { stdio: 'ignore', shell: true })
    : spawnSync('dsh', ['--version'], { stdio: 'ignore' })
  if (probe.error === undefined && probe.status === 0) return { argv: ['dsh'], label: 'dsh (PATH)' }

  const home = options.home ?? process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    const checkout = options.checkout ?? process.env.DSH_CHECKOUT ?? checkoutFromJunction(home)
    if (checkout !== undefined) {
      const bin = join(checkout, 'apps', 'cli', 'lib', 'bin.js')
      if (existsSync(bin)) return { argv: [process.execPath, bin], label: `node ${bin}` }
    }
  }
  return undefined
}

/**
 * Extract a verified archive into the content-addressed store.
 * @returns `{ digest, packageDir, created }`; `created: false` means the digest was already present.
 */
export async function materialize(buffer, manifest, options) {
  const root = options.root ?? dpkRoot(options.home)
  const digest = manifest.integrity.digest
  const target = storeDir(root, digest)
  const packageDir = join(target, 'package')
  if (existsSync(join(packageDir, 'package.json')) && options.force !== true) {
    return { digest, packageDir, created: false, root }
  }

  const staging = `${target}.tmp-${process.pid}-${Date.now()}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(join(staging, 'package'), { recursive: true })
  try {
    await extractPackageTree(buffer, manifest, join(staging, 'package'))
    await writeFile(join(staging, 'dpk.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    if (existsSync(target)) await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  if (options.keepArchive === true) {
    await retainArchive(root, options.archiveName ?? archiveFileName(manifest.name, manifest.version), buffer)
  }
  return { digest, packageDir, created: true, root }
}

/**
 * Install a `.dpk` file into a profile.
 *
 * Two installers exist and both are official: the in-session tool passes
 * `installer` (the plugin manager service, the same one `plugin_manager`
 * drives), while the CLI spawns `dsh plugin --profile <p> install <abs path>`.
 * dpk never writes the profile itself.
 *
 * @param options - `file`, `profile`, `home`, `dryRun`, `force`, `keepArchive`,
 * `installer` (async `(packageDir) => void`, throwing on failure), `dsh` (CLI
 * override), `run` (executor override, for tests), `log`.
 * @returns a structured result describing every step.
 */
export async function installArchive(options) {
  const log = options.log ?? (() => {})
  const bytes = options.buffer ?? await readFileBytes(options.file)
  log(`verify   ${options.file}`)
  const verified = await verifyArchive(bytes, { deep: true })
  const { manifest } = verified

  const root = options.root ?? dpkRoot(options.home)
  const digest = manifest.integrity.digest
  const packageDir = join(storeDir(root, digest), 'package')
  const profile = options.profile ?? process.env.DSH_PROFILE ?? 'default'
  const useService = typeof options.installer === 'function'
  const dsh = useService ? undefined : resolveDshCli({ dsh: options.dsh, home: options.home, checkout: options.checkout })
  const argv = ['plugin', '--profile', profile, 'install', packageDir]
  const command = useService ? null : (dsh === undefined ? undefined : [...dsh.argv, ...argv])

  // A dry run is read-only: it reports the deterministic paths without writing.
  if (options.dryRun === true) {
    log(`dry-run  would unpack to ${packageDir}`)
    log('dry-run  no profile change, no ledger entry, no files written')
    return {
      ...verified, digest, packageDir, created: false, profile, dryRun: true,
      dsh: dsh?.label ?? null,
      command: command ?? null,
      toolCall: `plugin_manager action=install_bundle target=${packageDir}`,
    }
  }

  const placed = await materialize(bytes, manifest, {
    root,
    force: options.force === true,
    keepArchive: options.keepArchive === true,
    archiveName: options.archiveName,
  })
  log(`${placed.created ? 'unpack  ' : 'reuse   '} store/${placed.digest}/package`)

  if (command === undefined && !useService) {
    throw new DpkInstallError(
      'the DSH CLI was not found; install with one of:\n'
      + `  dsh plugin --profile ${profile} install "${placed.packageDir}"\n`
      + `  plugin_manager action=install_bundle target=${placed.packageDir}`,
      'DPK_NO_DSH',
      { packageDir: placed.packageDir, profile },
    )
  }

  let via = 'service'
  if (useService) {
    log(`install  plugin manager service -> ${placed.packageDir}`)
    await options.installer(placed.packageDir)
  } else {
    via = 'cli'
    log(`install  ${command.map(part => (part.includes(' ') ? `"${part}"` : part)).join(' ')}`)
    const run = options.run ?? ((argv) => runCommand(argv, { stdio: 'inherit' }))
    const result = run(command)
    if (result.status !== 0) {
      throw new DpkInstallError(
        `DSH install failed with exit code ${result.status}; the profile was not modified by dpk.`
        + `\nRetry manually: ${command.join(' ')}`
        + `\nThe extracted package is at ${placed.packageDir}`,
        'DPK_DSH_FAILED',
        { exitCode: result.status, packageDir: placed.packageDir },
      )
    }
  }

  await recordInstall(root, {
    name: manifest.name,
    version: manifest.version,
    digest: placed.digest,
    path: join('store', placed.digest, 'package'),
    source: options.file,
    profile,
  })
  log(`record   ${join(root, 'index.json')}`)
  return {
    ...verified, ...placed, profile, dryRun: false, via, command,
    dsh: dsh?.label ?? null, created: placed.created,
  }
}

/** Read a file with a dpk-flavoured error. */
async function readFileBytes(file) {
  try {
    return await readFile(file)
  } catch (error) {
    throw new DpkInstallError(`cannot read ${file}: ${String(error)}`, 'DPK_READ_FAILED')
  }
}
