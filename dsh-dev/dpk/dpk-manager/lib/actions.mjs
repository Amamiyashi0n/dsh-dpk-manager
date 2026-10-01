/**
 * The `dpk` actions, independent of the tool registration layer.
 *
 * Keeping the behaviour here means the same code serves the in-session `dpk`
 * tool and the Plugins-page panel, and that both are testable without a
 * Harness runtime.
 *
 * @module dpk/lib/actions
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { archiveFileName, packDirectory } from './pack.mjs'
import { describeManifest, verifyArchive } from './verify.mjs'
import { installArchive } from './install.mjs'
import { dpkRoot, matchEntries, readIndex, storeDir, defaultDshHome} from './store.mjs'
import { dataRoot, describeVolumes, exportConfigVolumes, importConfigVolumes, parseDataDeclaration, purgeVolumes } from './data.mjs'

/** Actions the in-session tool exposes. */
export const DPK_ACTIONS = ['inspect', 'verify', 'pack', 'install', 'list', 'which', 'data', 'purge']

/** A caller mistake: reported as text, never as a stack trace. */
export class DpkActionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DpkActionError'
  }
}

async function readArchive(args) {
  if (typeof args.file !== 'string' || args.file === '') throw new DpkActionError('this action needs `file`: the path of a .dpk archive')
  const path = resolve(args.file)
  if (!existsSync(path)) throw new DpkActionError(`no such file: ${path}`)
  return { path, buffer: await readFile(path) }
}

function summarise(result) {
  const lines = [
    `package  ${describeManifest(result.manifest)}`,
    `digest   ${result.manifest.integrity.digest}`,
  ]
  for (const check of result.checks ?? []) lines.push(`ok       ${check}`)
  for (const note of result.notes ?? []) lines.push(`note     ${note}`)
  for (const warning of result.warnings ?? []) lines.push(`warn     ${warning}`)
  return lines.join('\n')
}

/**
 * Run one action.
 * @param action - one of {@link DPK_ACTIONS}.
 * @param args - action arguments (`file`, `directory`, `output`, `name`,
 * `profile`, `dryRun`, `force`, `keepArchive`).
 * @param context - `{ home, profile, installer, log }`; `installer(packageDir)`
 * is the official plugin manager service every caller passes.
 * @returns `{ action, text, data }`.
 * @throws {DpkActionError} for a caller mistake; archive/package errors otherwise.
 */
export async function runDpkAction(action, args = {}, context = {}) {
  const home = context.home ?? defaultDshHome()

  switch (action) {
    case 'inspect': {
      const { buffer } = await readArchive(args)
      const result = await verifyArchive(buffer, { deep: false })
      return {
        action,
        text: `${JSON.stringify(result.manifest, undefined, 2)}${result.warnings.length === 0 ? '' : `\n${result.warnings.map(w => `warn     ${w}`).join('\n')}`}`,
        data: { manifest: result.manifest },
      }
    }
    case 'verify': {
      const { buffer } = await readArchive(args)
      const result = await verifyArchive(buffer, { deep: args.deep !== false })
      return {
        action,
        text: `${summarise(result)}\nverdict  valid: this archive installs as a DSH plugin`,
        data: {
          name: result.manifest.name,
          version: result.manifest.version,
          digest: result.manifest.integrity.digest,
          roles: result.manifest.roles,
          files: result.manifest.files.length,
          checks: result.checks,
          warnings: result.warnings,
        },
      }
    }
    case 'pack': {
      if (typeof args.directory !== 'string' || args.directory === '') {
        throw new DpkActionError('pack needs `directory`: the DSH package directory to pack')
      }
      const packed = await packDirectory(resolve(args.directory), {
        ...args.createdAt === undefined ? {} : { createdAt: args.createdAt === 'now' ? new Date().toISOString() : args.createdAt },
        ...args.timestamp === undefined ? {} : { timestamp: args.timestamp },
      })
      const output = resolve(args.output ?? archiveFileName(packed.manifest.name, packed.manifest.version))
      const { writeFile } = await import('node:fs/promises')
      await writeFile(output, packed.buffer)
      return {
        action,
        text: [
          `wrote    ${output}`,
          `package  ${describeManifest(packed.manifest)}`,
          `digest   ${packed.manifest.integrity.digest}`,
          `bytes    ${packed.buffer.length} (${packed.manifest.files.length} files)`,
          ...packed.source.checkNotes.map(note => `note     ${note}`),
          ...packed.source.warnings.map(warning => `warn     ${warning}`),
        ].join('\n'),
        data: {
          output,
          name: packed.manifest.name,
          version: packed.manifest.version,
          digest: packed.manifest.integrity.digest,
          roles: packed.manifest.roles,
          bytes: packed.buffer.length,
        },
      }
    }
    case 'install': {
      const { path, buffer } = await readArchive(args)
      const result = await installArchive({
        file: path,
        buffer,
        home,
        profile: context.profile ?? args.profile,
        dryRun: args.dryRun === true,
        force: args.force === true,
        keepArchive: args.keepArchive === true,
        installer: context.installer,
        log: context.log,
      })
      const lines = [
        `package  ${describeManifest(result.manifest)}`,
        `store    ${result.packageDir}`,
      ]
      if (result.dryRun === true) {
        lines.push('dry-run  nothing was written')
        lines.push(`next     plugin_manager action=install_bundle target=${result.packageDir}`)
      } else {
        lines.push(`profile  ${result.profile} (installed by the plugin manager service)`)
        if (!result.created) lines.push('reuse    this digest was already in the store')
        for (const volume of result.volumes ?? []) {
          if (volume.action === 'seeded') lines.push(`data     ${volume.class}/${volume.path.split(sep).pop()} seeded`)
          if (volume.action === 'refreshed') lines.push(`data     ${volume.class}/${volume.path.split(sep).pop()} refreshed`)
          if (volume.action === 'kept-local') lines.push(`data     ${volume.path}: kept the local copy; new seed staged as .dpk-new`)
          if (volume.action === 'adopted') lines.push(`data     ${volume.path}: adopted a pre-existing file`)
        }
      }
      return {
        action,
        text: lines.join('\n'),
        data: {
          name: result.manifest.name,
          version: result.manifest.version,
          digest: result.digest,
          storePath: result.packageDir,
          profile: result.profile,
          dryRun: result.dryRun === true,
          created: result.created,
          volumes: result.volumes ?? [],
        },
      }
    }
    case 'data': {
      if (typeof args.name !== 'string' || args.name === '') throw new DpkActionError('data needs `name`: the package whose volumes to inspect')
      const root = dpkRoot(home)
      const entry = matchEntries((await readIndex(root)).entries, args.name)[0]
      if (entry === undefined) throw new DpkActionError(`no stored package matches ${args.name}`)
      const packageDir = join(storeDir(root, entry.digest), 'package')
      const declaration = parseDataDeclaration(
        JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).dsh?.data,
        `${entry.name}: package.json`,
      )
      const volumes = await describeVolumes(home, entry.name, declaration, packageDir)
      const lines = [`data     ${dataRoot(home, entry.name)}`]
      if (volumes.length === 0) lines.push('         this package declares no data volumes')
      for (const volume of volumes) {
        const state = !volume.exists ? 'missing'
          : volume.pendingSeed !== undefined ? 'pending-seed'
          : volume.seeded === false ? 'user-owned'
          : 'seeded'
        lines.push(`${volume.id}  ${volume.class}  ${state}  ${volume.path}`)
      }
      const missing = volumes.filter(volume => !volume.exists).length
      if (missing > 0) lines.push(`note     ${missing} declared volume(s) not on disk yet; the package initializes them on first activation or import`)
      return { action, text: lines.join('\n'), data: { root: dataRoot(home, entry.name), volumes } }
    }
    case 'purge': {
      if (typeof args.name !== 'string' || args.name === '') throw new DpkActionError('purge needs `name`: the package whose data volumes to delete')
      const root = dpkRoot(home)
      const matches = matchEntries((await readIndex(root)).entries, args.name)
      if (matches.length === 0) throw new DpkActionError(`no stored package matches ${args.name}`)
      const result = await purgeVolumes(home, matches[0].name)
      return {
        action,
        text: result.purged
          ? `purged   ${result.root} (config, state, and cache volumes deleted)`
          : `purge    ${result.root} did not exist; nothing to delete`,
        data: result,
      }
    }
    case 'list': {
      const root = dpkRoot(home)
      const index = await readIndex(root)
      const lines = [`store    ${root}`]
      if (index.entries.length === 0) lines.push('         no packages installed through dpk')
      for (const entry of index.entries) {
        lines.push(`${entry.name}@${entry.version}  ${entry.digest.slice(0, 12)}  [${entry.profiles.join(',') || '-'}]  ${entry.path}`)
      }
      return { action, text: lines.join('\n'), data: { root, entries: index.entries } }
    }
    case 'which': {
      if (typeof args.name !== 'string' || args.name === '') throw new DpkActionError('which needs `name`')
      const root = dpkRoot(home)
      const matches = matchEntries((await readIndex(root)).entries, args.name)
      if (matches.length === 0) throw new DpkActionError(`no stored package matches ${args.name}`)
      return {
        action,
        text: matches.map(entry => `${entry.name}@${entry.version}  ${storeDir(root, entry.digest)}/package`).join('\n'),
        data: { matches },
      }
    }
    default:
      throw new DpkActionError(`unknown action ${JSON.stringify(action)}; expected one of ${DPK_ACTIONS.join(', ')}`)
  }
}
