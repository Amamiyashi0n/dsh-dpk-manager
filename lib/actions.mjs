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
import { readFile, readdir, rename, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { packDirectory } from './pack.mjs'
import { archiveFileName } from './dpk-manifest.mjs'
import { describeManifest, verifyArchive } from './verify.mjs'
import { DpkInstallError, applyToRunning, installArchive } from './install.mjs'
import { applyProfileRemove, installedState, profileDir, readProfileManifest, referencedDigests } from './profile-install.mjs'
import { dpkRoot, readIndex, removeStoreDir, storeDir, updateIndex, defaultDshHome } from './store.mjs'
import { latestByName, latestEntry } from './versions.mjs'
import { planUpgrades } from './upgrade.mjs'
import { cacheDir, staleStagingPid, staleStagingsIn, stagingPid } from './staging.mjs'
import { PACKAGE_NAME, PACKAGE_NAME_MAX_LENGTH, localizeName, registryName } from './dsh-package.mjs'
import { dataRoot, describeVolumes, exportVolumes, importDataVolumes, parseDataDeclaration, purgeVolumes } from './data.mjs'
import { buildDataFile, countClasses, formOf, readDataFile } from './data-file.mjs'

/**
 * Actions the in-session tool exposes, named after the apt/dpkg verb for the
 * same operation so the surface needs no separate vocabulary to learn:
 * `info` = `dpkg-deb -I`, `build` = `dpkg-deb -b`, `install` = `dpkg -i`,
 * `remove` = `dpkg -r` / `apt remove`, `purge` = `dpkg -P` / `apt purge`,
 * `list` = `dpkg -l`, `autoremove` = `apt autoremove`.
 * `verify`, `data`, `export` and `import` keep dpk's own names: apt has no verb
 * for "check this archive before trusting it", for managed data volumes, or for
 * carrying config (its nearest is debconf-get/set-selections, which is a
 * different spelling of the same idea).
 */
export const DPK_ACTIONS = ['update', 'upgrade', 'install', 'remove', 'purge', 'autoremove', 'list', 'show', 'verify', 'build', 'export', 'snap', 'import', 'pkg']

/**
 * The file `export`/`snap` write when the caller names no `output`.
 *
 * One source for the convention, because the panel needs the same name for the
 * file it hands to the browser: `all` scope gives an archive (`dpks.dpks` /
 * `snap.dpks`), one package gives `<package>-data.json` / `<package>-snap.json`.
 * The verb is in the name so that taking an export and then a snapshot cannot
 * land on one file.
 *
 * @param verb - `'export'` or `'snap'`.
 * @param packageName - the package, or omitted for the `all` scope.
 */
export function defaultExportName(verb, packageName) {
  if (packageName === undefined) return verb === 'snap' ? 'snap.dpks' : 'dpks.dpks'
  return `${packageName.replace(/^@[^/]+\//u, '')}-${verb === 'snap' ? 'snap' : 'data'}.json`
}

/** A store directory is named by its content digest, always. */
const STORE_DIGEST = /^[0-9a-f]{64}$/

/**
 * Where `build` writes its archive.
 *
 * No `output` means the package's own `dpk-dist/` directory — the build output
 * next to the source it came from, not in whatever directory the caller happened
 * to stand in. An `output` may name a file, or a **directory** — either an
 * existing one or a path written with a trailing separator — and then the
 * standard name goes inside it.
 *
 * Both `dpk-dist/` and `dist/` are never-packed directories, so an archive left
 * there is not package content and cannot make the next pack refuse itself.
 *
 * @param requested - the raw `output` argument, if any.
 * @param packed - the packer's result (`manifest` names the file).
 * @param packageDir - the resolved package directory that was packed.
 * @returns the absolute path to write.
 */
async function resolveBuildOutput(requested, packed, packageDir) {
  const standard = archiveFileName(packed.manifest.name, packed.manifest.version)
  if (typeof requested !== 'string' || requested === '') return join(packageDir, 'dpk-dist', standard)
  // resolve() drops a trailing separator, so notice it before resolving.
  const trailing = /[\\/]$/.test(requested)
  const absolute = resolve(requested)
  if (trailing) return join(absolute, standard)
  try {
    if ((await stat(absolute)).isDirectory()) return join(absolute, standard)
  } catch (_absent) {
    // Not an existing directory: treat it as the file to write.
  }
  return absolute
}

/**
 * One package's carried volumes, bytes included — the unit every data-file
 * verb works in: `export`/`snap` write one or many of these, and `pkg` merges
 * them into a file on disk.
 *
 * @param home - DSH home.
 * @param root - the dpk root (for the store copy).
 * @param entry - a ledger row.
 * @param options - `classes`: which volume classes travel; omitted means all.
 */
async function carryVolumes(home, root, entry, options = {}) {
  const packageDir = join(storeDir(root, entry.digest), 'package')
  const declaration = parseDataDeclaration(
    JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).dsh?.data,
    `${entry.name}: package.json`,
  )
  return { package: entry.name, files: await exportVolumes(home, entry.name, declaration, options) }
}

/** Human-readable byte count for the reports. */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * The ledger entry a user request names.
 *
 * Install stores the localized name (`@local/example-provider`), but a user
 * types the package's own (`example-provider`, or `example-provider@1.0.0`) —
 * both resolve here instead of the tool answering "no match" for one spelling.
 * A bare name answers with the newest version the ledger records: two profiles
 * can hold different versions of one package, and the ledger is written in
 * name-then-version order, so reading its first match would silently pick the
 * older one.
 *
 * @param entries - ledger entries.
 * @param request - a package name, optionally `name@version`.
 * @returns the matching entry, or undefined.
 */
function ledgerEntry(entries, request) {
  const exact = latestEntry(entries, request)
  if (exact !== undefined) return exact
  // The same request against the localized spelling. A name that already
  // carries a scope is taken as written — guessing another scope's package
  // would turn a typo into an unrelated match.
  const at = request.startsWith('@') ? request.indexOf('@', 1) : request.indexOf('@')
  const name = at === -1 ? request : request.slice(0, at)
  const version = at === -1 ? '' : request.slice(at)
  if (name.startsWith('@')) return undefined
  return latestEntry(entries, `${localizeName(name)}${version}`)
}

function splitPackageRequest(request) {
  const at = request.startsWith('@') ? request.indexOf('@', 1) : request.indexOf('@')
  return at === -1
    ? { name: request, version: undefined }
    : { name: request.slice(0, at), version: request.slice(at + 1) }
}

/** The package names one profile currently depends on. */
async function installedNames(options) {
  try {
    const manifest = await readProfileManifest(profileDir(options.home, options.profile))
    return Object.keys(manifest.dependencies ?? {}).sort()
  } catch (_unreadable) {
    return []
  }
}

/**
 * Everything dpk knows about one installed package: the provenance the ledger
 * holds, the store path, whether each profile that names it can still resolve
 * it, and the state of its managed data volumes.
 *
 * The answer to `which` and `data` lives here now: apt has neither verb, and
 * `show` is where a package's details belong.
 */
async function describeInstalled(options) {
  const root = dpkRoot(options.home)
  const index = await readIndex(root)
  const entry = ledgerEntry(index.entries, options.name)
  const { rows } = await referencedDigests({ home: options.home, root })
  const name = entry?.name ?? localizeName(options.name)
  const users = [...new Set(rows.filter(row => row.name === name).map(row => row.profile))]
  if (entry === undefined && users.length === 0) {
    throw new DpkActionError(`nothing matches ${options.name}: not in the ledger and no profile names it`)
  }

  const digest = entry?.digest ?? rows.find(row => row.name === name)?.digest
  const packageDir = digest === undefined ? undefined : join(storeDir(root, digest), 'package')
  const lines = [`package  ${name}`]
  if (entry !== undefined) {
    lines.push(`version  ${entry.version}`)
    lines.push(`digest   ${digest}`)
    if (entry.installedAt !== undefined) lines.push(`at       ${entry.installedAt}`)
    if (entry.source !== null && entry.source !== undefined) lines.push(`source   ${entry.source}`)
  }
  lines.push(`store    ${packageDir ?? '(unknown: the ledger has no digest for this name)'}`)

  const broken = []
  if (packageDir !== undefined && !existsSync(join(packageDir, 'package.json'))) {
    broken.push(`${packageDir} is gone (the store copy was deleted)`)
  } else if (packageDir !== undefined) {
    for (const profile of users) {
      const state = await installedState({ home: options.home, profile, packageName: name, packageDir })
      lines.push(`used by  ${profile}  ${state.installed ? 'ok' : 'BROKEN'}`)
      for (const detail of state.reasons) broken.push(`${profile}: ${detail}`)
    }
  }
  if (users.length === 0) lines.push('used by  (no profile references it; `dpk autoremove` reclaims it)')

  let volumes = []
  if (packageDir !== undefined && existsSync(join(packageDir, 'package.json'))) {
    const declared = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).dsh?.data
    try {
      volumes = await describeVolumes(options.home, name, parseDataDeclaration(declared, `${name}: package.json`), packageDir)
    } catch (error) {
      // `show` is exactly where a user diagnoses a package whose stored copy
      // predates a declaration format change (the pre-2.1.30 class names). A
      // stack trace would hide everything this command already learned; the
      // report keeps the identity, store path and reference state above and
      // names the declaration as the broken part.
      broken.push(`declaration unreadable: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`)
    }
    lines.push(`data     ${dataRoot(options.home, name)}`)
    if (broken.at(-1)?.startsWith('declaration unreadable')) lines.push('         (declaration unreadable; see the broken line above)')
    else if (volumes.length === 0) lines.push('         no data volumes declared')
    for (const volume of volumes) {
      // 无种子的卷不参与种子代际管理:存在即 present,不误标 seeded
      const state = !volume.exists ? 'missing'
        : !('seeded' in volume) ? 'present'
          : volume.pendingSeed !== undefined ? 'pending-seed'
            : volume.seeded ? 'seeded' : 'user-owned'
      lines.push(`${volume.id}  ${volume.class}  ${state}  ${volume.path}`)
    }
  }
  lines.push(...broken.map(detail => `broken   ${detail}`))

  return {
    action: 'show',
    text: lines.join('\n'),
    data: { name, entry, digest, packageDir, profiles: users, broken, volumes },
  }
}

/** Directory-entry names under `store/` that are not content digests. */
async function nonDigestStoreNames(storeRoot) {
  try {
    return (await readdir(storeRoot, { withFileTypes: true })).map(entry => entry.name).filter(name => !STORE_DIGEST.test(name))
  } catch (_noStore) {
    return []
  }
}

/** Directory size, for the collection report. */
async function directoryBytes(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (_missing) {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(path)
    else if (entry.isFile()) {
      try {
        total += (await stat(path)).size
      } catch (_vanished) {
        // A concurrent collector removed it; its bytes are gone either way.
      }
    }
  }
  return total
}

/**
 * The store-wide collector: `autoremove`, and only `autoremove`.
 *
 * It enforces the store's one invariant — a stored digest exists exactly while
 * a profile resolves it — by reading every profile (both its dependency rows
 * and its `node_modules` links) and dropping everything nobody references, plus
 * the ledger rows and legacy `store/<digest>/dpk.json` copies that go with them.
 *
 * It collects only when every profile can be examined. A profile directory
 * that cannot be examined at all may still resolve a store copy, so collection
 * is deferred until that profile can be read again and the condition is reported.
 *
 * `upgrade` and `remove` deliberately do **not** call this: each of them
 * orphans one digest it knows by name, and collecting that one is
 * `reclaimDisplaced`'s job. A whole-store collection belongs to the verb whose
 * entire meaning is "collect", so that installing a package can never delete
 * copies of packages the user never mentioned.
 *
 * @param options - `{ home, root }`.
 * @returns `{ digests, bytes, referenced, profiles, unreadable, cache, cacheRemoved, stagings, stagingBytes }`.
 */
async function sweepUnreferenced(options) {
  const root = options.root
  const storeRoot = join(root, 'store')
  const { profiles, references, unreadable } = await referencedDigests({ home: options.home, root })
  const cache = cacheDir(root)
  if (unreadable.length > 0) {
    return {
      digests: [],
      bytes: 0,
      referenced: references.size,
      profiles,
      unreadable,
      cache,
      cacheRemoved: false,
      stagings: [],
      stagingBytes: 0,
    }
  }
  const index = await readIndex(root)
  const byDigest = new Map(index.entries.map(entry => [entry.digest, entry]))

  // `store/` holds digests and nothing else. A non-digest name is either residue
  // an older generation left there (dpk ≤ 2.1.43 staged beside its target, so an
  // interrupted install left `<digest>.tmp-…` inside `store/`) or somebody
  // else's file. Older generations are not supported — their residue is deleted
  // on sight, with no question of whether their writer still runs — while a name
  // that is not dpk's staging convention is left alone.
  let present = []
  try {
    present = await readdir(storeRoot, { withFileTypes: true })
  } catch (_noStore) {
    present = []
  }
  const staleResidue = []
  const digestDirs = []
  for (const entry of present) {
    if (entry.isDirectory() && STORE_DIGEST.test(entry.name)) {
      digestDirs.push(entry.name)
      continue
    }
    if (stagingPid(entry.name) === undefined) continue
    const path = join(storeRoot, entry.name)
    staleResidue.push({ name: entry.name, path, pid: stagingPid(entry.name), bytes: await directoryBytes(path) })
    await rm(path, { recursive: true, force: true })
  }

  const collected = []
  for (const digest of digestDirs) {
    const directory = storeDir(root, digest)
    // The `dpk.json` sidecar is a pre-2.0.3 leftover, read by nothing: deleting
    // it is all the handling it gets.
    await rm(join(directory, 'dpk.json'), { force: true })
    if (references.has(digest)) continue
    const entry = byDigest.get(digest)
    collected.push({
      digest,
      name: entry === undefined ? null : entry.name,
      version: entry === undefined ? null : entry.version,
      bytes: await directoryBytes(directory),
    })
    await removeStoreDir(root, digest)
  }

  // dpk's own staging lives in one directory, so the collector cleans that
  // directory instead of hunting staging names through the store, the dpk root
  // and every profile.
  const stagings = [...staleResidue]
  for (const staging of await staleStagingsIn(cache)) {
    stagings.push(staging)
    await rm(staging.path, { recursive: true, force: true })
  }

  // The ledger write stages in the cache too, so it has to happen before the
  // empty-cache check: otherwise it recreates the directory this is about to
  // remove.
  const kept = index.entries.filter(entry => references.has(entry.digest))
  if (kept.length !== index.entries.length) {
    await updateIndex(root, current => ({ ...current, entries: current.entries.filter(entry => references.has(entry.digest)) }))
  }
  // Rule 1 for the collector's side: an empty cache is not worth keeping. `rmdir`
  // is the tool — `rm` refuses a directory without `recursive`, and `recursive`
  // would take a live writer's staging with it.
  try {
    await rmdir(cache)
  } catch (_notEmptyOrAbsent) {
    // Still holding a live writer's staging, or already gone.
  }
  const cacheRemoved = !existsSync(cache)
  return {
    digests: collected,
    bytes: collected.reduce((sum, item) => sum + item.bytes, 0),
    referenced: references.size,
    profiles,
    unreadable,
    cache,
    cacheRemoved,
    stagings,
    stagingBytes: stagings.reduce((sum, item) => sum + item.bytes, 0),
  }
}

/**
 * Reclaim exactly the digests one operation displaced.
 *
 * `upgrade` and `remove` each orphan a known, named set of store directories:
 * the digest a profile resolved before the operation repointed it. Only those
 * are candidates here — a store-wide sweep inside them would delete copies
 * belonging to packages the user never mentioned (measured: an `upgrade` of one
 * package collected an unrelated unreferenced one), and that is `autoremove`'s
 * explicit job, not a side effect of installing something.
 *
 * Deletion is conservative: a profile directory that cannot be examined at all
 * may be the one resolving a candidate digest, so nothing is collected and the
 * report names it. These two verbs are not the collector, so deferring is free —
 * the copy is `autoremove`'s to collect once the profile can be read again.
 * Leaving a directory behind is recoverable; deleting the copy a profile loads
 * is not.
 *
 * @param options - `{ home, root, digests }`; nulls and repeats are ignored.
 * @returns `{ digests, bytes, kept, unreadable }`; `kept` names candidates a
 * profile still resolves, `unreadable` the profiles that blocked collection.
 */
async function reclaimDisplaced(options) {
  const root = options.root
  const wanted = [...new Set((options.digests ?? []).filter(digest => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)))]
  if (wanted.length === 0) return { digests: [], bytes: 0, kept: [], unreadable: [] }
  const { references, unreadable } = await referencedDigests({ home: options.home, root })
  if (unreadable.length > 0) {
    return { digests: [], bytes: 0, kept: wanted, unreadable }
  }
  const index = await readIndex(root)
  const collected = []
  for (const digest of wanted) {
    if (references.has(digest)) continue
    const directory = storeDir(root, digest)
    if (!existsSync(directory)) continue
    const entry = index.entries.find(item => item.digest === digest)
    collected.push({
      digest,
      name: entry?.name ?? null,
      version: entry?.version ?? null,
      bytes: await directoryBytes(directory),
    })
    await removeStoreDir(root, digest)
  }
  if (collected.length > 0) {
    const gone = new Set(collected.map(item => item.digest))
    const kept = index.entries.filter(entry => !gone.has(entry.digest))
    if (kept.length !== index.entries.length) {
      await updateIndex(root, current => ({ ...current, entries: current.entries.filter(entry => !gone.has(entry.digest)) }))
    }
  }
  return {
    digests: collected,
    bytes: collected.reduce((sum, item) => sum + item.bytes, 0),
    kept: wanted.filter(digest => references.has(digest)),
    unreadable: [],
  }
}

/** The one line every caller reports about a reclaim, or nothing when it collected none. */
function reclaimLine(reclaimed) {
  if (reclaimed.unreadable.length > 0) {
    return `kept     ${reclaimed.kept.length} displaced digest(s): ${reclaimed.unreadable.map(name => `profile ${name}`).join(', ')} could not be read, so nothing was collected`
  }
  const lines = []
  if (reclaimed.digests.length > 0) {
    lines.push(`reclaimed ${reclaimed.digests.length} displaced digest(s), ${formatBytes(reclaimed.bytes)}`)
  }
  if (reclaimed.kept.length > 0) {
    lines.push(`kept     ${reclaimed.kept.length} displaced digest(s): a profile still references the stored copy`)
  }
  return lines.join('\n')
}

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
 * `profile`, `reinstall`).
 * @param context - `{ home, profile, installer, log }`; `installer(packageDir)`
 * is the official plugin manager service every caller passes.
 * @returns `{ action, text, data }`.
 * @throws {DpkActionError} for a caller mistake; archive/package errors otherwise.
 */
export async function runDpkAction(action, args = {}, context = {}) {
  const home = context.home ?? defaultDshHome()

  switch (action) {
    case 'show': {
      // apt's `show` answers "tell me about this" for either a package file or an
      // installed package; the two shapes are one verb on purpose.
      const hasName = typeof args.name === 'string' && args.name !== ''
      const hasFile = typeof args.file === 'string' && args.file !== ''
      if (hasName === hasFile) {
        throw new DpkActionError('show needs exactly one of `file` (a .dpk archive to describe) or `name` (an installed package)')
      }
      if (hasFile) {
        const { buffer } = await readArchive(args)
        const result = await verifyArchive(buffer, { deep: false })
        return {
          action,
          text: `${JSON.stringify(result.manifest, undefined, 2)}${result.warnings.length === 0 ? '' : `\n${result.warnings.map(w => `warn     ${w}`).join('\n')}`}`,
          data: { manifest: result.manifest },
        }
      }
      return await describeInstalled({ home, name: args.name })
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
    case 'build': {
      if (typeof args.directory !== 'string' || args.directory === '') {
        throw new DpkActionError('build needs `directory`: the DSH package directory to pack')
      }
      const packageDir = resolve(args.directory)
      const packed = await packDirectory(packageDir, {
        ...args.createdAt === undefined ? {} : { createdAt: args.createdAt === 'now' ? new Date().toISOString() : args.createdAt },
        ...args.timestamp === undefined ? {} : { timestamp: args.timestamp },
      })
      const output = await resolveBuildOutput(args.output, packed, packageDir)
      const { mkdir, writeFile } = await import('node:fs/promises')
      // The archive's directory is dpk's to create: a caller naming
      // `…/dpk-dist/x.dpk` should not have to mkdir it first, and a build that
      // fails after packing would otherwise lose the work.
      await mkdir(dirname(output), { recursive: true })
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
        reinstall: args.reinstall === true,
        installMode: context.installMode,
        profileByDefault: context.profileByDefault === true,
        currentProfile: context.currentProfile,
        installer: context.installer,
        apply: context.apply,
         requireLive: context.requireLive === true,
        log: context.log,
      })
      const lines = [
        `package  ${describeManifest(result.manifest)}`,
        `store    ${result.packageDir}`,
        `profile  ${result.profile} (${result.via === 'service'
          ? 'installed by the plugin manager service'
          : 'written by dpk'})`,
      ]
      lines.push(result.live === true
        ? 'live     applied to the running Harness'
        : `live     ${result.manifest.name}@${result.manifest.version} will be loaded at the next DeepSeek Harness start${result.via === 'service' ? '' : ' (the plugin manager service did not apply it)'}`)
      if (!result.created) lines.push('reuse    this digest was already in the store')
      if (result.unchanged === true) {
        lines.push(`unchanged ${result.via === 'service'
          ? 'the profile already resolves this exact package; the manager was not run'
          : 'the profile already resolves this exact package'}`)
      }
      for (const warning of result.warnings ?? []) lines.push(`warn     ${warning}`)
      for (const volume of result.volumes ?? []) {
        if (volume.action === 'seeded') lines.push(`data     ${volume.class}/${volume.path.split(sep).pop()} seeded`)
        if (volume.action === 'refreshed') lines.push(`data     ${volume.class}/${volume.path.split(sep).pop()} refreshed`)
        if (volume.action === 'kept-local') lines.push(`data     ${volume.path}: kept the local copy; new seed staged as .dpk-new`)
        if (volume.action === 'adopted') lines.push(`data     ${volume.path}: adopted a pre-existing file`)
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
          via: result.via,
          created: result.created,
          unchanged: result.unchanged === true,
          live: result.live === true,
          volumes: result.volumes ?? [],
        },
      }
    }
    case 'update': {
      // apt's `update` refreshes the index it then upgrades from. dpk asks two
      // upstreams, each for its own kind of package: the npm registry (through
      // the official manager's `inspect`, wired as `view` by the tool) for
      // packages no local .dpk answers for, and the directories packages came
      // from for the rest. Nothing is cached — a scan is milliseconds, and a
      // stale "newest version" would be worse than no answer.
      const plan = await planUpgrades({ home, root: dpkRoot(home), directory: args.directory, view: context.view })
      const lines = [
        `update   scanned ${plan.directories.length} directory(ies)`,
        ...plan.directories.map(directory => `scan     ${directory}`),
      ]
      if (plan.plan.length === 0) lines.push('         no package is installed through dpk')
      for (const row of plan.plan) {
        // A registry-only row (an official-page package) has no digest and no
        // local file: the report names its upstream instead.
        const source = row.from === 'registry' ? '(npm)' : row.file
        lines.push(row.upgrade
          ? `${row.name}  ${row.current} -> ${row.available}  [${row.profile}]  ${source}`
          : `${row.name}  ${row.current}  [${row.profile}]  ${row.available === null ? `no newer version found${context.view === undefined ? ' (registry unavailable)' : ''}` : 'already newest'}`)
      }
      lines.push(...plan.warnings.map(warning => `warn     ${warning}`))
      lines.push(plan.upgradable.length === 0
        ? 'note     nothing to upgrade'
        : `note     ${plan.upgradable.length} upgrade(s) available; \`dpk upgrade\` installs them`)
      return {
        action,
        text: lines.join('\n'),
        data: { directories: plan.directories, plan: plan.plan, upgradable: plan.upgradable.length, warnings: plan.warnings },
      }
    }
    case 'upgrade': {
      const root = dpkRoot(home)
      const plan = await planUpgrades({ home, root, directory: args.directory, view: context.view })
      if (plan.upgradable.length === 0) {
        return {
          action,
          text: [`upgrade  ${plan.plan.length} package(s) checked in ${plan.directories.length} directory(ies)`,
            '         everything installed is already the newest available version'].join('\n'),
          data: { upgraded: [], plan: plan.plan },
        }
      }
      const lines = []
      const upgraded = []
      const failed = []
      const displaced = []
      for (const row of plan.upgradable) {
        // The digest this profile resolves *before* the attempt is a reclaim
        // candidate whatever the outcome: an install that repointed the profile
        // and then failed (a volume that would not materialise) has already
        // orphaned it, while a failure before the repoint leaves it referenced —
        // and `reclaimDisplaced` collects candidates only when no profile
        // resolves them. Registering it only on success is what would leave that
        // copy behind for `autoremove` to find.
        displaced.push(row.digest)
        try {
          let result
          if (row.from === 'registry') {
            if (context.requireLive === true) {
              throw new DpkInstallError(
                `dpk: registry upgrade of ${row.name} cannot guarantee a live swap; upgrade was refused`,
                'DPK_LIVE_REQUIRED',
                { packageName: row.name, profile: row.profile },
              )
            }
            // A registry package installs through the official plugin manager:
            // its name is what pnpm resolves, and pnpm is the only way to get
            // the registry tree the package needs. That installer revalidates
            // every registry dependency, so the release-age cooldown could
            // refuse freshly published ones — opt the profile out first,
            // exactly as the install path does for `via: "service"`.
            if (context.beforeRegistryUpgrade !== undefined) await context.beforeRegistryUpgrade(row.profile)
            if (context.registryInstaller === undefined) {
              throw new Error('the plugin manager service is not composed, so a registry upgrade cannot run pnpm')
            }
            const outcome = await context.registryInstaller(`${registryName(row.name)}@${row.available}`, {
              name: registryName(row.name),
              version: row.available,
              profile: row.profile,
              isSatisfied: async () => false,
            })
            if (outcome?.application === 'failed') {
              throw new Error(outcome.error?.diagnostic ?? outcome.error?.code ?? 'unknown failure')
            }
            if (context.requireLive === true && outcome?.application !== 'applied' && outcome?.application !== 'unchanged') {
              throw new DpkInstallError(
                `dpk: ${row.name} was not applied to the running Harness; refusing a restart-only upgrade`,
                'DPK_LIVE_REQUIRED',
                { packageName: row.name, application: outcome?.application },
              )
            }
            result = {
              digest: row.digest,
              version: row.available,
              live: outcome?.application === 'applied' || outcome?.application === 'unchanged',
            }
          } else {
            const installed = await installArchive({
              file: row.file,
              home,
              profile: row.profile,
              installer: context.installer,
              apply: context.apply,
               requireLive: context.requireLive === true,
              installMode: context.installMode,
              profileByDefault: context.profileByDefault === true,
              currentProfile: context.currentProfile,
              log: (message) => { context.log?.(message) },
            })
            // installArchive answers with the archive's manifest, not a bare
            // version: reading `installed.version` here printed "-> undefined"
            // for every `.dpk` upgrade.
            result = { digest: installed.digest, version: installed.manifest.version, live: installed.live === true }
          }
          lines.push(`upgraded ${row.name}  ${row.current} -> ${result.version}  in ${row.profile}${row.from === 'registry' ? '  (npm)' : `  store/${result.digest.slice(0, 12)}`}`)
          upgraded.push({ ...row, to: result.version, digest: result.digest, live: result.live === true })
        } catch (error) {
          const message = String(error instanceof Error ? error.message : error)
          lines.push(`failed   ${row.name}  ${row.current} -> ${row.available}: ${message}`)
          failed.push({ ...row, error: message })
        }
      }
      lines.push(...plan.warnings.map(warning => `warn     ${warning}`))
      const reclaimed = await reclaimDisplaced({ home, root, digests: displaced })
      const reclaimReport = reclaimLine(reclaimed)
      if (reclaimReport !== '') lines.push(reclaimReport)
      // An upgrade replaces code the running Harness has already loaded, which
      // no service can hot-swap: say which packages, and when they arrive.
      const awaitingRestart = upgraded.filter(item => item.live !== true)
      if (awaitingRestart.length > 0) {
        lines.push(`note     ${awaitingRestart.map(item => `${item.name}@${item.to}`).join(', ')} will be updated at the next DeepSeek Harness start`)
      }
      return {
        action,
        text: lines.join('\n'),
        data: {
          upgraded,
          failed,
          plan: plan.plan,
          reclaimed: reclaimed.digests.map(item => item.digest),
        },
      }
    }
    case 'export':
    case 'snap': {
      // Two verb families, one axis apart — **which classes travel**:
      //
      //   export   `app` volumes only
      //   snap     `app` and `data` volumes
      //
      // Each family takes either scope — one named package (`name=`, a
      // single-package JSON file) or the machine (`all=true`, a `.dpks` archive)
      // — so the four combinations are one axis each, not four code paths.
      const snapshot = action === 'snap'
      const classes = snapshot ? undefined : ['app']
      const root = dpkRoot(home)
      const index = await readIndex(root)
      /** How a carried set of volumes reads in the report, classes named. */
      const scopeNote = snapshot
        ? 'note     carries app and data volumes'
        : 'note     carries app volumes only; `dpk snap` carries data volumes too'

      if (args.all === true) {
        // The newest version per name: the ledger keeps one row per
        // (name, version, digest), and two profiles can resolve two versions of
        // one package. Ranking by version (not by the ledger's own order) is
        // what makes "the snapshot" mean the current one.
        const chosen = latestByName(index.entries)
          .sort((left, right) => left.name.localeCompare(right.name))
        const carried = []
        const skipped = []
        for (const entry of chosen) {
          try {
            carried.push(await carryVolumes(home, root, entry, { classes }))
          } catch (error) {
            // A stored copy whose declaration cannot be read — the pre-2.1.30
            // class spelling, a hand-edited package.json — is not a reason to
            // refuse the whole archive: every other package is still worth
            // carrying, and the row names the one thing that fixes this one.
            // The single-package scope stays loud about it, because there the
            // user asked for exactly that package.
            skipped.push({
              package: entry.name,
              reason: String(error instanceof Error ? error.message : error).split('\n')[0],
            })
          }
        }
        // The whole-machine scope always writes the archive form, even when the
        // machine holds one package: that is what the verb promises, and what
        // the default name says. Form-follows-content belongs to `pkg`, whose
        // whole job is changing how many packages a file holds.
        const built = buildDataFile(carried, { form: 'dpks' })
        const output = typeof args.output === 'string' && args.output !== ''
          ? resolve(args.output)
          : join(process.cwd(), defaultExportName(action))
        await writeFile(output, built.buffer)
        const volumeCount = carried.reduce((sum, pkg) => sum + pkg.files.length, 0)
        const counts = countClasses(carried.flatMap(pkg => pkg.files))
        const lines = [
          `${snapshot ? 'snapshotted' : 'exported'} ${carried.length} package(s), ${volumeCount} volume(s) (data: ${counts.data}, app: ${counts.app}) → ${output}`,
          ...carried.map(pkg => `data     ${pkg.package}  ${pkg.files.length} volume(s)`),
        ]
        for (const item of skipped) lines.push(`skip     ${item.package}: ${item.reason}`)
        if (skipped.length > 0) {
          lines.push(`note     ${skipped.length} package(s) skipped; repack and reinstall each, then run it again`)
        }
        if (volumeCount === 0) lines.push('note     no volume exists on disk yet; the archive carries empty lists')
        else lines.push(scopeNote)
        return {
          action,
          text: lines.join('\n'),
          data: { output, packages: carried.map(pkg => pkg.package), skipped, all: true },
        }
      }

      const verb = snapshot ? 'snap' : 'export'
      if (typeof args.name !== 'string' || args.name === '') {
        throw new DpkActionError(`${verb} needs \`name\` (one package) or \`all: true\` (every recorded package)`)
      }
      const entry = ledgerEntry(index.entries, args.name)
      if (entry === undefined) throw new DpkActionError(`no stored package matches ${args.name}`)
      const single = await carryVolumes(home, root, entry, { classes })
      const output = typeof args.output === 'string' && args.output !== ''
        ? resolve(args.output)
        : join(process.cwd(), defaultExportName(action, single.package))
      // The one-package scope always writes the document form: it carries
      // exactly one package by construction.
      await writeFile(output, buildDataFile([single], { form: 'dpk' }).buffer)
      const counts = countClasses(single.files)
      const lines = [
        snapshot
          ? `snapshotted ${single.files.length} volume(s) (data: ${counts.data}, app: ${counts.app}) → ${output}`
          : `exported ${single.files.length} app volume(s) → ${output}`,
      ]
      if (single.files.length === 0) lines.push(`note     no ${snapshot ? '' : 'app '}volume exists on disk yet; the file carries an empty list`)
      for (const file of single.files) lines.push(`data     ${file.path}`)
      lines.push(scopeNote)
      return { action, text: lines.join('\n'), data: { output, files: single.files.map(file => file.path) } }
    }
    case 'import': {
      // Overwrites data volumes in place (user data, destructive), so the
      // tool gates it exactly like install/purge; the gate itself lives in
      // index.js next to the others. The container is read by content, not by
      // name: a JSON document, a zip archive, and a hand-made document listing
      // entries for several packages are all just packages with volumes.
      const dataPath = resolve(String(args.file ?? ''))
      if (!existsSync(dataPath)) throw new DpkActionError(`no such file: ${dataPath}`)
      const buffer = await readFile(dataPath)
      const root = dpkRoot(home)
      const index = await readIndex(root)
      const packages = readDataFile(buffer, { where: dataPath })
      const single = packages.length === 1
      const importTransaction = {}

      // Landing one carried package: the declaration says which volume each
      // file belongs to, so nothing about the file's own spelling matters here.
      const importOne = async (carried) => {
        const entry = ledgerEntry(index.entries, carried.package)
        if (entry === undefined) {
          throw new DpkActionError(`no stored package matches ${carried.package} (install it first, then re-import)`)
        }
        const packageDir = join(storeDir(root, entry.digest), 'package')
        const declaration = parseDataDeclaration(
          JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).dsh?.data,
          `${entry.name}: package.json`,
        )
        return importDataVolumes(home, entry.name, declaration, carried.files, {
          log: (message) => { context.log?.(message) },
          transaction: importTransaction,
        })
      }

      if (typeof args.name === 'string' && args.name !== '') {
        // A name selects one package inside the file. Against a one-package file
        // it must be that package: naming another one is a caller mistake, not a
        // redirect.
        const carried = packages.find(pkg => pkg.package === args.name
          || pkg.package === `@local/${args.name}`
          || registryName(pkg.package) === args.name)
        if (carried === undefined) {
          throw new DpkActionError(single
            ? `the data file was exported for ${packages[0].package}, not ${args.name}`
            : `the data file carries none of ${args.name}`)
        }
        const applied = await importOne(carried)
        const lines = [`imported ${applied.length} volume(s) for ${carried.package} from ${dataPath}`]
        for (const path of applied) lines.push(`data     ${path}`)
        return { action, text: lines.join('\n'), data: { applied } }
      }

      const lines = []
      const applied = []
      const skipped = []
      try {
        for (const carried of packages) {
          if (ledgerEntry(index.entries, carried.package) === undefined) {
            // A one-package file that names a package this machine does not have
            // is an error the caller asked for by pointing at it; inside a bundle
            // the other packages are still worth landing, so that one is skipped
            // with a line that says why.
            if (single) throw new DpkActionError(`no stored package matches ${carried.package} (install it first, then re-import)`)
            skipped.push(carried.package)
            lines.push(`skip     ${carried.package}: not recorded here (install it first, then re-import)`)
            continue
          }
          const done = await importOne(carried)
          applied.push(...done.map(path => ({ package: carried.package, path })))
          lines.push(single
            ? `imported ${done.length} volume(s) from ${dataPath}`
            : `imported ${done.length} volume(s) for ${carried.package}`)
          for (const path of done) lines.push(`data     ${path}`)
        }
      } catch (error) {
        await importTransaction.rollback?.()
        throw error
      }
      if (single) {
        if (applied.length === 0) {
          // The mirror of export's note: an import that lands nothing must say so,
          // or "imported" reads as "your config is back".
          lines.push('note     the file carried no volume for this package; nothing was written')
        }
      } else if (skipped.length > 0) {
        lines.push(`note     ${skipped.length} package(s) skipped: not recorded in this machine's ledger`)
      }
      return { action, text: lines.join('\n'), data: single ? { applied } : { applied, skipped } }
    }
    case 'pkg': {
      // Read and adjust one data file on disk: which packages it carries and
      // what each of them holds. The file's form follows its content — one
      // package is the JSON document, several are the `.dpks` archive — so
      // adding a second package promotes it and removing back down to one
      // demotes it, name and all.
      const dataPath = resolve(String(args.file ?? ''))
      if (!existsSync(dataPath)) throw new DpkActionError(`no such file: ${dataPath}`)
      const op = args.op
      if (!['list', 'add', 'remove', 'set'].includes(op)) {
        throw new DpkActionError('pkg needs `op`: list, add, remove or set')
      }
      const buffer = await readFile(dataPath)
      const packages = readDataFile(buffer, { where: dataPath })
      const counts = (files) => {
        const { data, app } = countClasses(files)
        return `data: ${data}, app: ${app}`
      }
      const describe = () => packages.map(pkg => `data     ${pkg.package}  ${pkg.files.length} volume(s) (${counts(pkg.files)})`)

      if (op === 'list') {
        const form = formOf(packages)
        const volumeCount = packages.reduce((sum, pkg) => sum + pkg.files.length, 0)
        const lines = [
          `${dataPath}  ${form === 'dpk' ? 'one package (json document)' : `${packages.length} packages (dpks archive)`}, ${volumeCount} volume(s)`,
          ...describe(),
        ]
        return {
          action,
          text: lines.join('\n'),
          data: {
            file: dataPath,
            form,
            packages: packages.map(pkg => ({ package: pkg.package, files: pkg.files.map(file => file.path) })),
          },
        }
      }

      if (typeof args.name !== 'string' || args.name === '') {
        throw new DpkActionError(`pkg ${op} needs \`name\`: the package to ${op === 'set' ? 'rename' : op}`)
      }
      const root = dpkRoot(home)
      const index = await readIndex(root)
      // Which entry of the file the caller means. `name` may spell it scoped or
      // not, the way every other verb accepts a package name.
      const samePackage = candidate => candidate === args.name
        || candidate === localizeName(args.name)
        || candidate === registryName(args.name)
      // `remove` and `set` adjust the file, so they name what the *file* carries:
      // a file made on another machine holds packages this one never installed,
      // and those are exactly the files worth tidying. `add` is the one that
      // reads this machine, so it resolves through the ledger.
      const at = op === 'add'
        ? packages.findIndex(pkg => pkg.package === (ledgerEntry(index.entries, args.name)?.name ?? args.name))
        : packages.findIndex(pkg => samePackage(pkg.package))
      let form = formOf(packages)
      let refreshed = false
      let renamed

      if (op === 'remove' || op === 'set') {
        // Both act on an entry that is already there: `add` is the way in for a
        // package the file does not carry, and saying which one you meant keeps
        // a typo from silently inserting a second package.
        if (at === -1) {
          throw new DpkActionError(`${dataPath} does not carry ${args.name}; use op=add to put it there`)
        }
      }

      if (op === 'remove') {
        packages.splice(at, 1)
      } else if (op === 'set') {
        // `set` adjusts what the file says about a package — its name. The bytes
        // are not touched: a renamed entry keeps every volume it had, and the
        // archive entries that carry them are written under the new name.
        const to = typeof args.to === 'string' ? args.to.trim() : ''
        if (to === '') throw new DpkActionError('pkg set needs `to`: the package name the file should carry')
        if (!PACKAGE_NAME.test(to) || to.length > PACKAGE_NAME_MAX_LENGTH) {
          throw new DpkActionError(`pkg set: ${to} is not a package name`)
        }
        const from = packages[at].package
        if (to === from) throw new DpkActionError(`${dataPath} already names it ${to}; nothing to rename`)
        if (packages.some(pkg => pkg.package === to)) {
          throw new DpkActionError(`${dataPath} already carries ${to}; two entries cannot share a name`)
        }
        packages[at] = { ...packages[at], package: to }
        renamed = { from, to }
      } else {
        // `add` brings this machine's install of the package into the file: the
        // same volumes `export`/`snap` would carry. An entry already there is
        // refreshed rather than refused, because that is the only way a file
        // follows what is installed now.
        const entry = ledgerEntry(index.entries, args.name)
        if (entry === undefined) throw new DpkActionError(`no stored package matches ${args.name}`)
        refreshed = at !== -1
        // Which classes travel: a snapshot by default, app only when the caller
        // says `verb=export` — the same axis the two verbs carry.
        if (args.verb !== undefined && args.verb !== 'snap' && args.verb !== 'export') {
          throw new DpkActionError('pkg needs `verb`: export (app volumes) or snap (app and data volumes)')
        }
        const classes = args.verb === 'export' ? ['app'] : undefined
        const carried = await carryVolumes(home, root, entry, { classes })
        if (refreshed) packages[at] = carried
        else packages.push(carried)
      }

      form = formOf(packages)
      const built = buildDataFile(packages, { form })
      // Write beside the file and rename over it, then drop the old name when
      // the form changed the extension: a reader never sees a half-written file.
      const target = dataPath.slice(0, dataPath.length - extname(dataPath).length) + built.extension
      const staging = `${target}.tmp-${process.pid}-1`
      await writeFile(staging, built.buffer)
      if (existsSync(target)) await rm(target, { force: true })
      await rename(staging, target)
      if (target !== dataPath) await rm(dataPath, { force: true })
      const lines = []
      const label = `${op === 'add' && refreshed ? 'refresh' : op === 'add' ? 'add' : op}`.padEnd(7) + ' '
      if (renamed !== undefined) {
        lines.push(`${label}${renamed.from} → ${renamed.to}  (${target})`)
        // A name this machine does not have is a legitimate thing for a file to
        // carry (that is what handing one to another machine looks like), so it
        // is a note rather than a refusal.
        if (ledgerEntry(index.entries, renamed.to) === undefined) {
          lines.push(`note     ${renamed.to} is not installed here, so \`dpk import\` would skip it on this machine`)
        }
      } else {
        const named = packages[at]?.package ?? args.name
        lines.push(`${label}${named}  → ${target}  (${form === 'dpk' ? 'one package (json document)' : `${packages.length} packages (dpks archive)`})`)
      }
      lines.push(...describe())
      if (target !== dataPath) lines.push(`moved    ${dataPath} was removed: its content now lives in ${target}`)
      return {
        action,
        text: lines.join('\n'),
        data: {
          file: target,
          previous: target === dataPath ? undefined : dataPath,
          form,
          refreshed,
          renamed,
          packages: packages.map(pkg => ({ package: pkg.package, files: pkg.files.map(file => file.path) })),
        },
      }
    }
    case 'purge': {
      if (typeof args.name !== 'string' || args.name === '') throw new DpkActionError('purge needs `name`: the package whose data volumes to delete')
      const root = dpkRoot(home)
      const entry = ledgerEntry((await readIndex(root)).entries, args.name)
      // `remove` deliberately drops the last ledger row but keeps data volumes.
      // Purge must still be able to finish that two-step uninstall, so fall back
      // to the localized name when the data root itself proves the package was
      // previously managed.
      const packageName = entry?.name ?? localizeName(splitPackageRequest(args.name).name)
      const dataPath = dataRoot(home, packageName)
      if (entry === undefined && !existsSync(dataPath)) throw new DpkActionError(`no stored package matches ${args.name}`)
      const result = await purgeVolumes(home, packageName)
      const lines = result.purged
        ? [`purged   ${result.root} (data and app volumes deleted)`]
        : [`purge    ${result.root} did not exist; nothing to delete`]
      for (const path of result.volumes) lines.push(`data     ${path}`)
      return { action, text: lines.join('\n'), data: result }
    }
    case 'remove': {
      const name = typeof args.name === 'string' ? args.name : ''
      if (name === '') throw new DpkActionError('remove needs `name`: the package to drop from the profile')
      const root = dpkRoot(home)
      const profile = context.profile ?? args.profile ?? 'default'
      const requested = splitPackageRequest(name)
      const index = await readIndex(root)
      // The profile's own row is the authority for the name and the digest; the
      // ledger only says whether dpk ever placed this package.
      const { rows } = await referencedDigests({ home, root })
      const row = rows.find(candidate => candidate.profile === profile
        && (candidate.name === requested.name || candidate.name === localizeName(requested.name))
        && (requested.version === undefined
          || index.entries.some(entry => entry.digest === candidate.digest && entry.version === requested.version)))
      const packageName = row?.name ?? localizeName(requested.name)
      const requestedLabel = requested.version === undefined ? packageName : `${packageName}@${requested.version}`
      if (row === undefined) {
        const held = await installedNames({ home, profile })
        throw new DpkActionError(
          `profile ${profile} does not hold ${requestedLabel}; nothing was removed`
          + (held.length === 0 ? '' : ` (it holds ${held.join(', ')})`),
        )
      }
      // The running Harness must see the complete profile while it resolves the
      // bundle. Unload first; deleting the dependency first makes the official
      // manager answer `not-bundle` and leaves the old code running.
      const removeTransaction = {}
      const unloadedLive = await applyToRunning(context.apply, packageName, false, context.log, profile)
      const restoreLiveSelection = async () => {
        if (unloadedLive?.application === 'applied' || unloadedLive?.changed === true) {
          await applyToRunning(context.apply, packageName, true, context.log, profile)
        }
      }
      if (context.requireLive === true && unloadedLive?.application !== 'applied') {
        await restoreLiveSelection()
        throw new DpkActionError(
          `live unload of ${packageName} was not applied; the local uninstall was not performed`,
        )
      }

      let removed
      try {
        removed = await applyProfileRemove({ home, profile, packageName, transaction: removeTransaction })
      } catch (error) {
        await restoreLiveSelection()
        throw error
      }
      if (!removed.changed) {
        await restoreLiveSelection()
        // Saying "removed" for a profile that never held the package is worse
        // than saying nothing: say what this profile actually holds.
        const held = await installedNames({ home, profile })
        throw new DpkActionError(
          `profile ${profile} does not hold ${packageName}; nothing was removed`
          + (held.length === 0 ? '' : ` (it holds ${held.join(', ')})`),
        )
      }
      let reclaimed
      try {
        // The only copy this operation may collect is the one the profile
        // resolved for the package it just dropped. A store-wide sweep here would
        // delete copies of packages the user never named.
        reclaimed = await reclaimDisplaced({ home, root, digests: [row?.digest] })
      } catch (error) {
        try { await removeTransaction.rollback?.() } catch (rollbackError) {
          context.log?.(`warn     could not restore profile ${profile}: ${String(rollbackError instanceof Error ? rollbackError.message : rollbackError)}`)
        }
        await restoreLiveSelection()
        throw error
      }
      const storeLine = reclaimed.unreadable.length > 0
        ? `kept: ${reclaimed.unreadable.map(name => `profile ${name}`).join(', ')} could not be read, so nothing was collected`
        : reclaimed.digests.length === 0
          ? row === undefined
            ? 'nothing to collect: this profile linked outside the store'
            : 'kept: another profile still references the stored copy'
          : `dropped ${reclaimed.digests.length} unreferenced digest(s), ${formatBytes(reclaimed.bytes)}`
      const lines = [
        `removed  ${packageName} from profile ${profile}`,
        `link     ${join(home, 'profiles', profile, 'node_modules', ...packageName.split('/'))}`,
        `lockfile ${removed.lockfile}`,
        `store    ${storeLine}`,
        unloadedLive?.application === 'applied'
          ? 'live     unloaded from the running Harness'
          : `live     ${packageName} will be unloaded at the next DeepSeek Harness start${context.apply === undefined ? ' (the plugin manager service did not apply it)' : ''}`,
      ]
      return {
        action,
        text: lines.join('\n'),
        // No `changed` field: reaching here means the profile really did hold it
        // (otherwise the throw above fired), so the field could only ever be true.
        data: {
          name: packageName,
          profile,
          dropped: reclaimed.digests.map(item => item.digest),
          bytes: reclaimed.bytes,
          lockfile: removed.lockfile,
          live: unloadedLive?.application === 'applied',
        },
      }
    }
    case 'autoremove': {
      const root = dpkRoot(home)
      const sweep = await sweepUnreferenced({ home, root })
      const lines = [`store    ${root}`]
      if (sweep.digests.length === 0) {
        lines.push('autoremove nothing to collect: every stored digest is referenced by a profile')
      } else {
        for (const item of sweep.digests) lines.push(`drop     ${item.digest.slice(0, 12)}  ${item.name ?? '(untracked)'}  ${formatBytes(item.bytes)}`)
        lines.push(`freed   ${sweep.digests.length} digest(s), ${formatBytes(sweep.bytes)}`)
      }
      if (sweep.stagings.length > 0) {
        for (const staging of sweep.stagings) lines.push(`stale    ${staging.path}  ${formatBytes(staging.bytes)} (pid ${staging.pid} is gone)`)
        lines.push(`freed   ${sweep.stagings.length} staging leftover(s), ${formatBytes(sweep.stagingBytes)}`)
      }
      lines.push(sweep.cacheRemoved
        ? `clean    ${sweep.cache} removed (nothing staged there any more)`
        : `cache    ${sweep.cache} kept (a live writer is staging there)`)
      lines.push(`kept     ${sweep.referenced} digest(s) referenced by profile(s): ${sweep.profiles.join(', ') || '(none)'}`)
      if (sweep.unreadable.length > 0) {
        // Collection went ahead: a profile that cannot be examined cannot be
        // loaded by the Harness either. Say so, because a copy it referenced
        // would have been collected — the .dpk is the way back.
        lines.push(`caveat   ${sweep.unreadable.map(name => `profile ${name}`).join(', ')} could not be examined at all; copies only they referenced were treated as garbage`)
      }
      return {
        action,
        text: lines.join('\n'),
        data: {
          root,
          digests: sweep.digests,
          bytes: sweep.bytes,
          referenced: sweep.referenced,
          profiles: sweep.profiles,
          unreadable: sweep.unreadable,
          cache: sweep.cache,
          cacheRemoved: sweep.cacheRemoved,
          stagings: sweep.stagings,
        },
      }
    }
    case 'list': {
      const root = dpkRoot(home)
      const index = await readIndex(root)
      const { references } = await referencedDigests({ home, root })
      const lines = [`store    ${root}`]
      if (index.entries.length === 0) lines.push('         no packages installed through dpk')
      const broken = []
      for (const entry of index.entries) {
        const users = references.get(entry.digest) ?? []
        const packageDir = join(storeDir(root, entry.digest), 'package')
        lines.push(`${entry.name}@${entry.version}  ${entry.digest.slice(0, 12)}  [${users.join(',') || 'unused'}]  ${packageDir}`)
        if (users.length === 0) continue
        // The half of `dpkg --audit` that is derivable here: does what the
        // profiles name still resolve? Every disagreement is a reason the
        // Harness cannot load the bundle at the next start, so it is reported
        // where a user looks instead of only surfacing as a boot error.
        if (!existsSync(join(packageDir, 'package.json'))) {
          broken.push(`${entry.name} in ${users.join(',')}: ${packageDir} is gone (the store copy was deleted)`)
          continue
        }
        for (const profile of users) {
          const state = await installedState({ home, profile, packageName: entry.name, packageDir })
          for (const reason of state.reasons) broken.push(`${entry.name} in ${profile}: ${reason}`)
        }
      }
      // A profile can reference a digest dpk never recorded: a run killed between
      // the profile write and the ledger write leaves exactly that. The profiles
      // are the authority for what runs, so the inventory lists it too — an
      // inventory that only reads its own bookkeeping would omit a live package.
      const recorded = new Set(index.entries.map(entry => entry.digest))
      const untracked = []
      for (const [digest, users] of references) {
        if (recorded.has(digest)) continue
        const packageDir = join(storeDir(root, digest), 'package')
        let name = '(unreadable)'
        let version = '(unreadable)'
        try {
          const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
          name = typeof manifest.name === 'string' ? manifest.name : name
          version = typeof manifest.version === 'string' ? manifest.version : version
        } catch (_unreadable) {
          // Reported as such rather than hidden; the loadability check below
          // names the missing store copy in full.
        }
        untracked.push({ name, version, digest, profiles: users })
        lines.push(`${name}@${version}  ${digest.slice(0, 12)}  [${users.join(',')}]  ${packageDir}  (untracked)`)
        if (!existsSync(join(packageDir, 'package.json'))) {
          broken.push(`${name} in ${users.join(',')}: ${packageDir} is gone (the store copy was deleted)`)
          continue
        }
        for (const profile of users) {
          const state = await installedState({ home, profile, packageName: name, packageDir })
          for (const reason of state.reasons) broken.push(`${name} in ${profile}: ${reason}`)
        }
      }
      if (untracked.length > 0) {
        lines.push(`note     ${untracked.length} package(s) a profile references but the ledger never recorded; a re-install records them`)
      }
      if (broken.length > 0) {
        lines.push(...broken.map(line => `broken   ${line}`))
        lines.push('fix      re-install its .dpk, or `dpk remove name=<package>` to drop the row')
      }
      const unused = index.entries.filter(entry => !references.has(entry.digest)).length
      if (unused > 0) lines.push(`note     ${unused} stored digest(s) no profile references; \`dpk autoremove\` reclaims them`)
      // `list` is the read-only preview of what `autoremove` would collect, and
      // that includes the scratch area: staging left by writers that are gone.
      const cache = cacheDir(root)
      const stale = await staleStagingsIn(cache)
      for (const name of await nonDigestStoreNames(join(root, 'store'))) {
        const pid = staleStagingPid(name)
        if (pid !== undefined) stale.push({ name, path: join(root, 'store', name), pid, bytes: 0 })
      }
      if (stale.length > 0) {
        lines.push(`note     ${stale.length} staging leftover(s) from writers that are gone; \`dpk autoremove\` reclaims them`)
      }
      return {
        action,
        text: lines.join('\n'),
        data: {
          root,
          broken,
          untracked,
          stagings: stale,
          entries: index.entries.map(entry => ({ ...entry, profiles: references.get(entry.digest) ?? [] })),
        },
      }
    }
    default:
      throw new DpkActionError(`unknown action ${JSON.stringify(action)}; expected one of ${DPK_ACTIONS.join(', ')}`)
  }
}
