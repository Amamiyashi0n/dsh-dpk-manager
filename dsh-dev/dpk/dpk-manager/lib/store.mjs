/**
 * The local DPK store: content-addressed extraction plus a provenance ledger.
 *
 * Layout (SPEC.md §8.2):
 *   <home>/dpk/index.json                 ledger, owned by dpk (DSH never reads it)
 *   <home>/dpk/store/<digest>/package/    the extracted package root handed to DSH
 *   <home>/dpk/archives/<name>-<ver>.dpk  optional retained archive
 *
 * @module dpk/lib/store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Ledger format version. */
export const INDEX_VERSION = 1

/** An unusable store or ledger. */
export class DpkStoreError extends Error {
  constructor(message, code = 'DPK_STORE_INVALID') {
    super(message)
    this.name = 'DpkStoreError'
    this.code = code
  }
}

/** The default DSH home: $DSH_HOME, else ~/.dsh (where the DSH desktop/web profiles live). */
export function defaultDshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The dpk root under a DSH home. */
export function dpkRoot(home = defaultDshHome()) {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new DpkStoreError('DSH_HOME is not set; pass --home <dir>', 'DPK_NO_HOME')
  }
  return join(resolve(home), 'dpk')
}

/** The extraction directory for one digest. */
export function storeDir(root, digest) {
  return join(root, 'store', digest)
}

/** The ledger path. */
export function indexFile(root) {
  return join(root, 'index.json')
}

/** Read the ledger, tolerating absence. */
export async function readIndex(root) {
  let text
  try {
    text = await readFile(indexFile(root), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: INDEX_VERSION, entries: [] }
    throw new DpkStoreError(`cannot read ${indexFile(root)}: ${String(error)}`, 'DPK_STORE_IO')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DpkStoreError(`index.json is not valid JSON: ${String(error)}`, 'DPK_STORE_INVALID')
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.entries)) {
    throw new DpkStoreError('index.json must be an object with an entries array', 'DPK_STORE_INVALID')
  }
  return { version: parsed.version ?? INDEX_VERSION, entries: parsed.entries }
}

/**
 * Write the ledger atomically: a crash mid-write can never leave a half-written
 * `index.json`, because the content lands in a sibling temp file that only a
 * successful rename promotes.
 *
 * On Windows the rename can still lose a transient race — a concurrent reader
 * in another DSH instance (the ledger is shared by every profile's manager)
 * or a real-time scanner holding the fresh temp file — and surfaces as EPERM.
 * The old ledger stays intact when that happens, so retrying shortly is both
 * safe and sufficient; only a persistent loss cleans up the temp and throws.
 */
export async function writeIndex(root, index) {
  await mkdir(root, { recursive: true })
  const path = indexFile(root)
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify({ version: INDEX_VERSION, entries: index.entries }, undefined, 2)}\n`)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path)
      return
    } catch (error) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code ?? '')) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 60 * 2 ** attempt))
    }
  }
}

/**
 * Record one installed package, merging profiles for the same identity.
 * @param root - dpk root.
 * @param entry - `{ name, version, digest, path, source, profile }`.
 */
export async function recordInstall(root, entry) {
  const index = await readIndex(root)
  const existing = index.entries.find(item => item.name === entry.name
    && item.version === entry.version && item.digest === entry.digest)
  if (existing === undefined) {
    index.entries.push({
      name: entry.name,
      version: entry.version,
      digest: entry.digest,
      path: entry.path,
      installedAt: entry.installedAt ?? new Date().toISOString(),
      source: entry.source ?? null,
      profiles: entry.profile === undefined ? [] : [entry.profile],
    })
  } else if (entry.profile !== undefined && !existing.profiles.includes(entry.profile)) {
    existing.profiles.push(entry.profile)
    existing.installedAt = entry.installedAt ?? new Date().toISOString()
  }
  index.entries.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
  await writeIndex(root, index)
  return index.entries
}

/** Find ledger entries matching `name` or `name@version`. */
export function matchEntries(entries, request) {
  const at = request.startsWith('@') ? request.indexOf('@', 1) : request.indexOf('@')
  const name = at === -1 ? request : request.slice(0, at)
  const version = at === -1 ? undefined : request.slice(at + 1)
  return entries.filter(entry => entry.name === name && (version === undefined || entry.version === version))
}

/**
 * Order two dotted numeric versions. A `-prerelease` tail sorts below its
 * release; unparsable segments count as zero so a malformed version never
 * outranks a well-formed one by accident.
 */
export function compareVersions(a, b) {
  const split = value => {
    const [core, pre] = String(value).split('-', 2)
    return { core: core.split('.').map(Number), pre }
  }
  const left = split(a)
  const right = split(b)
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i += 1) {
    const x = Number.isFinite(left.core[i]) ? left.core[i] : 0
    const y = Number.isFinite(right.core[i]) ? right.core[i] : 0
    if (x !== y) return x - y
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre < right.pre ? -1 : 1
}

/**
 * The newest entry per package name. Ledger order is insertion order, not
 * version order, so callers that want "what this package is now" must rank by
 * version instead of trusting the last row.
 */
export function latestByName(entries) {
  const latest = new Map()
  for (const entry of entries) {
    const current = latest.get(entry.name)
    if (current === undefined || compareVersions(entry.version, current.version) >= 0) latest.set(entry.name, entry)
  }
  return [...latest.values()]
}

/** The newest entry matching `name` or `name@version`, or undefined. */
export function latestEntry(entries, request) {
  const matches = matchEntries(entries, request)
  if (matches.length === 0) return undefined
  return matches.reduce((best, entry) => (compareVersions(entry.version, best.version) >= 0 ? entry : best))
}

/** Copy a retained archive into the store. */
export async function retainArchive(root, fileName, buffer) {
  const path = join(root, 'archives', fileName)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buffer)
  return path
}

/** Remove one store directory (used by `--force` re-materialisation). */
export async function removeStoreDir(root, digest) {
  await rm(storeDir(root, digest), { recursive: true, force: true })
}
