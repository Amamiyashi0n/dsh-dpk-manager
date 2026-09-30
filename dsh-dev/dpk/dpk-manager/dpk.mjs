#!/usr/bin/env node
/**
 * dpk — pack, verify, and install DSH plugin packages.
 *
 * A `.dpk` is a zip that carries exactly one standard DSH package (SPEC.md).
 * `dpk` never installs anything by itself: it verifies the archive, extracts it
 * into a content-addressed local store, and hands that directory to DSH's own
 * installer, so the profile ends up with an ordinary local dependency.
 *
 * @module dpk/cli
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { packDirectory, archiveFileName } from './lib/pack.mjs'
import { verifyArchive, describeManifest } from './lib/verify.mjs'
import { installArchive } from './lib/install.mjs'
import { dpkRoot, readIndex, matchEntries, forgetProfile, removeStoreDir, storeDir } from './lib/store.mjs'
import { DPK_FORMAT_VERSION, DPK_GENERATOR } from './lib/dpk-manifest.mjs'

const USAGE = `dpk ${DPK_GENERATOR} — DSH plugin packages

usage: dpk <command> [options]

commands
  pack <dir>             validate a DSH package directory and write a .dpk
  verify <file.dpk>      verify structure, integrity, and DSH conformance
  inspect <file.dpk>     print the manifest without extracting
  install <file.dpk>     verify, unpack into the local store, install via DSH
  list                   list packages in the local store
  which <name[@version]> print stored directories for a package
  uninstall <name>       remove a package from a profile (delegates to DSH)
  version                print format and tool version

options
  -o, --output <file>    pack: output path (default <name>-<version>.dpk)
      --timestamp <iso>  pack: zip timestamp (default 1980-01-01, reproducible)
      --created-at <iso> pack: manifest createdAt; pass "now" for build provenance
                         (default 1980-01-01, so identical input packs identically)
      --no-compress      pack: store entries uncompressed
      --no-deep          verify: skip the DSH conformance re-validation
  -p, --profile <name>   install/uninstall: profile (default $DSH_PROFILE or "default")
      --home <dir>       store root's DSH home (default $DSH_HOME)
      --dry-run          install: verify and unpack, but do not touch the profile
      --force            install: re-extract even if the digest is already stored
      --keep-archive     install: also copy the .dpk into <home>/dpk/archives
      --prune            uninstall: delete the stored copy as well
      --dsh <cmd>        how to invoke the DSH CLI (default: PATH, else the checkout)
      --json             machine-readable output
  -h, --help             this text
`

/** A usage problem: reported without a stack trace. */
class UsageError extends Error {}

/** Parse argv into `{ command, positional, flags }`. */
function parseArgs(argv) {
  const flags = { positional: [] }
  const takesValue = new Map([
    ['-o', 'output'], ['--output', 'output'],
    ['--timestamp', 'timestamp'], ['--created-at', 'createdAt'],
    ['-p', 'profile'], ['--profile', 'profile'],
    ['--home', 'home'], ['--dsh', 'dsh'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-h' || token === '--help') { flags.help = true; continue }
    if (token === '--json') { flags.json = true; continue }
    if (token === '--dry-run') { flags.dryRun = true; continue }
    if (token === '--force') { flags.force = true; continue }
    if (token === '--keep-archive') { flags.keepArchive = true; continue }
    if (token === '--prune') { flags.prune = true; continue }
    if (token === '--no-compress') { flags.compress = false; continue }
    if (token === '--no-deep') { flags.deep = false; continue }
    const mapped = takesValue.get(token)
    if (mapped !== undefined) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new UsageError(`${token} needs a value`)
      flags[mapped] = value
      index += 1
      continue
    }
    if (token.startsWith('-')) throw new UsageError(`unknown option ${token}`)
    flags.positional.push(token)
  }
  const [command, ...rest] = flags.positional
  return { command, positional: rest, flags }
}

function line(label, value) {
  return `${label.padEnd(9)}${value}`
}

function report(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      name: result.manifest.name,
      version: result.manifest.version,
      digest: result.manifest.integrity.digest,
      roles: result.manifest.roles,
      dpk: result.manifest.dpk,
      generator: result.manifest.generator,
      createdAt: result.manifest.createdAt,
      files: result.manifest.files.length,
      checks: result.checks,
      warnings: result.warnings,
      notes: result.notes,
      ...result.packageDir === undefined ? {} : { packageDir: result.packageDir, storePath: result.packageDir },
      ...result.profile === undefined ? {} : { profile: result.profile },
      ...result.command === undefined ? {} : { command: result.command },
    }, undefined, 2)}\n`)
    return
  }
  process.stdout.write(`${line('package', describeManifest(result.manifest))}\n`)
  process.stdout.write(`${line('digest', result.manifest.integrity.digest)}\n`)
  for (const check of result.checks ?? []) process.stdout.write(`${line('ok', check)}\n`)
  for (const note of result.notes ?? []) process.stdout.write(`${line('note', note)}\n`)
  for (const warning of result.warnings ?? []) process.stdout.write(`${line('warn', warning)}\n`)
}

async function commandPack(positional, flags) {
  const directory = positional[0]
  if (directory === undefined) throw new UsageError('pack needs a package directory')
  const result = await packDirectory(resolve(directory), {
    ...flags.timestamp === undefined ? {} : { timestamp: flags.timestamp },
    createdAt: flags.createdAt === 'now' ? new Date().toISOString() : flags.createdAt,
    compress: flags.compress,
  })
  const output = resolve(flags.output ?? archiveFileName(result.manifest.name, result.manifest.version))
  await writeFile(output, result.buffer)
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      output,
      name: result.manifest.name,
      version: result.manifest.version,
      digest: result.manifest.integrity.digest,
      roles: result.manifest.roles,
      bytes: result.buffer.length,
      files: result.manifest.files.length,
      warnings: result.source.warnings,
      notes: result.source.checkNotes,
    }, undefined, 2)}\n`)
    return
  }
  process.stdout.write(`${line('wrote', output)}\n`)
  process.stdout.write(`${line('package', describeManifest(result.manifest))}\n`)
  process.stdout.write(`${line('digest', result.manifest.integrity.digest)}\n`)
  process.stdout.write(`${line('bytes', `${result.buffer.length} (${result.manifest.files.length} files)`)}\n`)
  for (const note of result.source.checkNotes) process.stdout.write(`${line('note', note)}\n`)
  for (const warning of result.source.warnings) process.stdout.write(`${line('warn', warning)}\n`)
}

async function readArchive(file) {
  if (file === undefined) throw new UsageError('this command needs a .dpk file')
  const path = resolve(file)
  if (!existsSync(path)) throw new UsageError(`no such file: ${path}`)
  return { path, buffer: await readFile(path) }
}

async function commandVerify(positional, flags) {
  const { buffer } = await readArchive(positional[0])
  const result = await verifyArchive(buffer, { deep: flags.deep })
  report(result, flags.json)
  if (!flags.json) process.stdout.write(`${line('verdict', 'valid: this archive installs as a DSH plugin')}\n`)
}

async function commandInspect(positional, flags) {
  const { buffer } = await readArchive(positional[0])
  const result = await verifyArchive(buffer, { deep: false })
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result.manifest, undefined, 2)}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(result.manifest, undefined, 2)}\n`)
  for (const warning of result.warnings) process.stdout.write(`${line('warn', warning)}\n`)
}

async function commandInstall(positional, flags) {
  const { path, buffer } = await readArchive(positional[0])
  const result = await installArchive({
    file: path,
    buffer,
    profile: flags.profile,
    home: flags.home,
    dryRun: flags.dryRun,
    force: flags.force,
    keepArchive: flags.keepArchive,
    dsh: flags.dsh,
    log: flags.json ? () => {} : (message => process.stderr.write(`${line('', message)}\n`)),
  })
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      name: result.manifest.name,
      version: result.manifest.version,
      digest: result.digest,
      storePath: result.packageDir,
      created: result.created,
      profile: result.profile,
      dryRun: result.dryRun ?? false,
      dsh: result.dsh,
      command: result.command,
      toolCall: result.toolCall ?? null,
    }, undefined, 2)}\n`)
    return
  }
  process.stdout.write(`${line('package', describeManifest(result.manifest))}\n`)
  process.stdout.write(`${line('store', result.packageDir)}\n`)
  if (result.dryRun === true) {
    process.stdout.write(`${line('dry-run', 'nothing was changed')}\n`)
    if (result.command === null) {
      process.stdout.write(`${line('next', `plugin_manager action=install_bundle target=${result.packageDir}`)}\n`)
    } else {
      process.stdout.write(`${line('next', result.command.map(part => (part.includes(' ') ? `"${part}"` : part)).join(' '))}\n`)
    }
    return
  }
  process.stdout.write(`${line('profile', `${result.profile} (installed by DSH)`)}\n`)
  if (!result.created) process.stdout.write(`${line('reuse', 'this digest was already in the store')}\n`)
}

async function commandList(flags) {
  const root = dpkRoot(flags.home)
  const index = await readIndex(root)
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ root, ...index }, undefined, 2)}\n`)
    return
  }
  process.stdout.write(`${line('store', root)}\n`)
  if (index.entries.length === 0) {
    process.stdout.write(`${line('', 'no packages installed through dpk')}\n`)
    return
  }
  for (const entry of index.entries) {
    const profiles = entry.profiles.length === 0 ? '-' : entry.profiles.join(',')
    process.stdout.write(`${entry.name}@${entry.version}  ${entry.digest.slice(0, 12)}  [${profiles}]  ${entry.path}\n`)
  }
}

async function commandWhich(positional, flags) {
  const request = positional[0]
  if (request === undefined) throw new UsageError('which needs a package name')
  const root = dpkRoot(flags.home)
  const matches = matchEntries((await readIndex(root)).entries, request)
  if (matches.length === 0) throw new UsageError(`no stored package matches ${request}`)
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(matches, undefined, 2)}\n`)
    return
  }
  for (const entry of matches) {
    process.stdout.write(`${entry.name}@${entry.version}  ${storeDir(root, entry.digest)}${entry.path === undefined ? '' : '/package'}\n`)
  }
}

async function commandUninstall(positional, flags) {
  const request = positional[0]
  if (request === undefined) throw new UsageError('uninstall needs a package name')
  const root = dpkRoot(flags.home)
  const matches = matchEntries((await readIndex(root)).entries, request)
  if (matches.length === 0) throw new UsageError(`no stored package matches ${request}`)
  const profile = flags.profile ?? process.env.DSH_PROFILE ?? 'default'
  const { resolveDshCli, runCommand } = await import('./lib/install.mjs')
  const dsh = resolveDshCli({ dsh: flags.dsh, home: flags.home, checkout: flags.checkout })
  for (const entry of matches) {
    if (dsh === undefined) {
      process.stderr.write(`${line('manual', `dsh plugin --profile ${profile} remove ${entry.name}`)}\n`)
    } else {
      const argv = [...dsh.argv, 'plugin', '--profile', profile, 'remove', entry.name]
      process.stderr.write(`${line('remove', argv.join(' '))}\n`)
      if (flags.dryRun !== true) {
        const result = runCommand(argv, { stdio: 'inherit' })
        if (result.status !== 0) throw new UsageError(`DSH remove failed with exit code ${result.status}`)
      }
    }
    if (flags.dryRun !== true) await forgetProfile(root, entry.name, profile)
    if (flags.prune === true && flags.dryRun !== true) {
      await removeStoreDir(root, entry.digest)
      process.stderr.write(`${line('pruned', `store/${entry.digest}`)}\n`)
    }
  }
}

const COMMANDS = {
  pack: commandPack,
  verify: commandVerify,
  inspect: commandInspect,
  install: commandInstall,
  list: (positional, flags) => commandList(flags),
  which: commandWhich,
  uninstall: commandUninstall,
  version: async () => {
    process.stdout.write(`${DPK_GENERATOR} (format ${DPK_FORMAT_VERSION})\n`)
  },
  help: async () => { process.stdout.write(USAGE) },
}

async function main() {
  const argv = process.argv.slice(2)
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`dpk: ${error.message}\n\n${USAGE}`)
    return 2
  }
  const { command, positional, flags } = parsed
  if (flags.help === true || command === undefined) {
    process.stdout.write(USAGE)
    return command === undefined && flags.help !== true ? 2 : 0
  }
  const handler = COMMANDS[command]
  if (handler === undefined) {
    process.stderr.write(`dpk: unknown command ${command}\n\n${USAGE}`)
    return 2
  }
  try {
    await handler(positional, flags)
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`dpk: ${error.message}\n`)
      return 2
    }
    process.stderr.write(`dpk: ${error.name ?? 'Error'}: ${error.message}\n`)
    if (process.env.DPK_DEBUG !== undefined && error.stack !== undefined) process.stderr.write(`${error.stack}\n`)
    return 1
  }
}

process.exitCode = await main()
