/**
 * Installation: verify → materialise into the local store → hand the extracted
 * directory to the official installer.
 *
 * The division of labour is the point of the format: dpk owns transport and
 * integrity, DSH owns installation and activation. Every caller — the in-session
 * tool and the Plugins-page panel — passes `installer`, the very plugin manager
 * service the official page drives (`installBundle`): it runs pnpm in the
 * profile, writes the dependency, and appends the newly installed bundle to
 * `dsh.profile.bundles`. dpk never writes a profile itself and injects no
 * command into the system.
 *
 * @module dpk/lib/install
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NEVER_PACKED, localizeName } from './dsh-package.mjs'
import { verifyArchive, extractPackageTree } from './verify.mjs'
import { retainArchive, recordInstall, storeDir, dpkRoot, defaultDshHome } from './store.mjs'
import { archiveFileName } from './dpk-manifest.mjs'
import { detectProfileName, disableReleaseAgeCooldown } from './profile-policy.mjs'

/** An install that could not complete. */
export class DpkInstallError extends Error {
  constructor(message, code = 'DPK_INSTALL_FAILED', detail = {}) {
    super(message)
    this.name = 'DpkInstallError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Drive one install through the official manager, retrying as remove+install
 * when the manager cannot see a change: re-importing the very same digest
 * leaves the dependency row identical, and the official installer's diff then
 * answers `ambiguous-install` instead of installing. Removing the bundle first
 * turns the re-import into an ordinary install, so importing over an existing
 * installation — same version or newer — always succeeds.
 * @param manager - the plugin manager service (`installBundle`/`removeBundle`).
 * @param packageDir - the absolute store directory to install.
 * @param packageName - the bundle name the manager knows the package by.
 * @returns the last install outcome; throws nothing the caller would not.
 */
export async function installOverwriting(manager, packageDir, packageName) {
  const isAmbiguous = outcome => outcome?.application === 'failed'
    && [outcome.error?.diagnostic, outcome.error?.code]
      .some(field => typeof field === 'string' && field.includes('ambiguous-install'))
  let outcome = await manager.installBundle(packageDir, {})
  if (isAmbiguous(outcome)) {
    const removed = await manager.removeBundle(packageName)
    if (removed?.application === 'failed') {
      throw new Error(`dpk: removing the previous installation failed: ${removed.error?.diagnostic ?? removed.error?.code ?? 'unknown failure'}`)
    }
    outcome = await manager.installBundle(packageDir, {})
  }
  return outcome
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
    await stripNeverPacked(join(staging, 'package'))
    await localizeStoredPackage(join(staging, 'package'), manifest)
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
 * The caller passes `installer`, the official plugin manager service; there is
 * no other path, so an install always runs exactly what the Plugins page runs.
 *
 * @param options - `file`, `profile`, `home`, `dryRun`, `force`, `keepArchive`,
 * `installer` (async `(packageDir) => void`, throwing on failure), `log`.
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
  const home = options.home ?? process.env.DSH_HOME ?? defaultDshHome()
  const profile = options.profile
    ?? process.env.DSH_PROFILE
    ?? detectProfileName(home)
    ?? 'default'

  // A dry run is read-only: it reports the deterministic paths without writing.
  if (options.dryRun === true) {
    log(`dry-run  would unpack to ${packageDir}`)
    log('dry-run  no profile change, no ledger entry, no files written')
    return {
      ...verified, digest, packageDir, created: false, profile, dryRun: true,
      command: null,
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

  if (typeof options.installer !== 'function') {
    throw new DpkInstallError(
      'no installer was provided; the official plugin manager service must install this package.\n'
      + `Equivalent call: plugin_manager action=install_bundle target=${placed.packageDir}`,
      'DPK_NO_INSTALLER',
      { packageDir: placed.packageDir, profile },
    )
  }

  // The official installer runs pnpm in the profile, which revalidates every
  // registry dependency there; the release-age cooldown could refuse freshly
  // published ones (this manager included). The import is deliberate and
  // digest-verified, so opt the profile out before pnpm starts. A policy we
  // cannot write only risks the cooldown, never the install itself.
  const profileDir = process.env.DSH_PROFILE_DIR ?? join(home, 'profiles', profile)
  try {
    if (await disableReleaseAgeCooldown(profileDir)) {
      log(`policy   minimumReleaseAge: 0 -> ${join(profileDir, 'pnpm-workspace.yaml')}`)
    }
  } catch (error) {
    log(`policy   could not update ${join(profileDir, 'pnpm-workspace.yaml')}: ${String(error instanceof Error ? error.message : error)}`)
  }

  log(`install  plugin manager service -> ${placed.packageDir}`)
  await options.installer(placed.packageDir, {
    name: manifest.name,
    version: manifest.version,
    digest: placed.digest,
  })

  await recordInstall(root, {
    // The store copy was localized, so the ledger carries the same name the
    // profile dependency does — a legacy unscoped archive lands as @local/….
    name: localizeName(manifest.name),
    version: manifest.version,
    digest: placed.digest,
    path: join('store', placed.digest, 'package'),
    source: options.file,
    profile,
  })
  log(`record   ${join(root, 'index.json')}`)
  return {
    ...verified, ...placed, profile, dryRun: false, via: 'service', command: null,
    created: placed.created,
  }
}

/**
 * Keep the stored package to the package alone. Older archives still carry
 * directories the packer has since stopped writing — a `dist/` of nested
 * archives, a checked-in `node_modules` — and importing one must not stack
 * that cargo into the store. Verification saw the full tree in its own
 * staging area; only the stored copy is trimmed.
 * @param packageDir - the freshly extracted store copy, trimmed in place.
 */
async function stripNeverPacked(packageDir) {
  for (const name of NEVER_PACKED) {
    await rm(join(packageDir, name), { recursive: true, force: true })
  }
}

/**
 * Re-scope the stored package copy: a source package whose name lacks the
 * local scope is installed under `@local/…`, so the profile dependency, the
 * ledger, and the panel all carry one name. The loader matches bundle rows by
 * `name`, so the patch rows naming the package follow; row ids and the
 * module's own registration id stay as built (the working
 * `@local/dsh-reverse-skill` layout), which means a package with a client
 * half must already ship scoped client ids (see `@local/zcode-provider`).
 * @param packageDir - the freshly extracted store copy, rewritten in place.
 * @param manifest - the verified dpk manifest whose `name` is already localized.
 */
async function localizeStoredPackage(packageDir, manifest) {
  const manifestPath = join(packageDir, 'package.json')
  const raw = JSON.parse(await readFile(manifestPath, 'utf8'))
  const original = raw.name
  const local = localizeName(original)
  if (local === original) return
  raw.name = local
  await writeFile(manifestPath, `${JSON.stringify(raw, undefined, 2)}\n`)
  const patchPath = join(packageDir, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    // Loader rows match the package by `name`; retarget every row that names
    // the package. Ids, configs, and other values are left untouched.
    const pattern = new RegExp(`(name\\s*:\\s*['"]?)${escapeRegExp(original)}(['"]?\\s*)$`, 'gm')
    const patch = await readFile(patchPath, 'utf8')
    await writeFile(patchPath, patch.replace(pattern, `$1${local}$2`))
  }
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Read a file with a dpk-flavoured error. */
async function readFileBytes(file) {
  try {
    return await readFile(file)
  } catch (error) {
    throw new DpkInstallError(`cannot read ${file}: ${String(error)}`, 'DPK_READ_FAILED')
  }
}
