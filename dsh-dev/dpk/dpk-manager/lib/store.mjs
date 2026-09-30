/**
 * The local DPK store: content-addressed extraction plus a provenance ledger.
 *
 * Layout (SPEC.md §8.2):
 *   <home>/dpk/index.json                 ledger, owned by dpk (DSH never reads it)
 *   <home>/dpk/store/<digest>/package/    the extracted package root handed to DSH
 *   <home>/dpk/store/<digest>/dpk.json    the archive manifest, kept for audit
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

/** Write the ledger atomically. */
export async function writeIndex(root, index) {
  await mkdir(root, { recursive: true })
  const path = indexFile(root)
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify({ version: INDEX_VERSION, entries: index.entries }, undefined, 2)}\n`)
  await rename(temporary, path)
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

/** Forget one profile's use of a package; the extracted content stays. */
export async function forgetProfile(root, name, profile) {
  const index = await readIndex(root)
  for (const entry of index.entries) {
    if (entry.name !== name) continue
    entry.profiles = entry.profiles.filter(item => item !== profile)
  }
  await writeIndex(root, index)
}

/** Find ledger entries matching `name` or `name@version`. */
export function matchEntries(entries, request) {
  const at = request.startsWith('@') ? request.indexOf('@', 1) : request.indexOf('@')
  const name = at === -1 ? request : request.slice(0, at)
  const version = at === -1 ? undefined : request.slice(at + 1)
  return entries.filter(entry => entry.name === name && (version === undefined || entry.version === version))
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
