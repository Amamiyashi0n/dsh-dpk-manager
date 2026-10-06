/**
 * The local DPK store: content-addressed extraction plus a provenance ledger.
 *
 * Layout (SPEC.md §8.2):
 *   <home>/dpk/index.json                 ledger, owned by dpk (DSH never reads it)
 *   <home>/dpk/store/<digest>/package/    the extracted package root handed to DSH
 *
 * @module dpk/lib/store
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { cacheDir, pruneCache, stageIn } from './staging.mjs'
import { dirname, join, resolve } from 'node:path'

/** Ledger format version. */
const INDEX_VERSION = 1

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
function indexFile(root) {
  return join(root, 'index.json')
}

/**
 * Read the ledger, tolerating absence.
 *
 * The entries are returned as written: the ledger is dpk's own file, so a row
 * carrying fields this version does not know belongs to a generation this
 * version does not serve, and quietly rewriting it would only hide that.
 */
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
 * Two hardenings keep the rename honest under real usage:
 * - Every write gets its own temp name and writes are serialized in-process.
 *   Uninstalling and importing in quick succession both rewrite the ledger
 *   from the same host process; a shared `tmp-<pid>` name let one flow rename
 *   a file the other was still writing (EPERM), and interleaved writes could
 *   last-writer-win between concurrent flows. A unique name plus a chain
 *   removes that entire class.
 * - On Windows the rename can still lose a transient race — a concurrent
 *   reader in another DSH instance (the ledger is shared by every profile's
 *   manager) or a real-time scanner holding the fresh temp file — which also
 *   surfaces as EPERM while the old ledger stays intact. Retrying shortly is
 *   both safe and sufficient; only a persistent loss cleans up and throws.
 */
let indexWriteChain = Promise.resolve()

export function writeIndex(root, index) {
  const run = () => writeIndexSerialized(root, index)
  const next = indexWriteChain.then(run, run)
  indexWriteChain = next.catch(() => {})
  return next
}

/** Serialize a read-modify-write of the shared ledger across processes. */
export async function updateIndex(root, update) {
  return withIndexLock(root, async () => {
    const index = await readIndex(root)
    const next = await update(index)
    await writeIndex(root, next)
    return next
  })
}

async function withIndexLock(root, operation) {
  await mkdir(root, { recursive: true })
  const lock = join(root, 'index.lock')
  for (let attempt = 0; ; attempt += 1) {
    let acquired = false
    try {
      await mkdir(lock)
      acquired = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const age = Date.now() - (await stat(lock)).mtimeMs
        if (age > 120_000) {
          await rm(lock, { recursive: true, force: true })
          continue
        }
      } catch (_vanished) {
        continue
      }
      if (attempt >= 300) throw new DpkStoreError(`timed out waiting for ${lock}`, 'DPK_STORE_BUSY')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (acquired) {
      try {
        return await operation()
      } finally {
        await rm(lock, { recursive: true, force: true })
      }
    }
  }
}

async function writeIndexSerialized(root, index) {
  await mkdir(root, { recursive: true })
  const path = indexFile(root)
  const cache = cacheDir(root)
  const temporary = await stageIn(cache, 'index.json', 'tmp')
  await writeFile(temporary, `${JSON.stringify({ version: INDEX_VERSION, entries: index.entries }, undefined, 2)}\n`)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path)
      await pruneCache(cache)
      return
    } catch (error) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code ?? '')) {
        await rm(temporary, { force: true }).catch(() => {})
        await pruneCache(cache)
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 60 * 2 ** attempt))
    }
  }
}

/**
 * Record one installed package in the provenance ledger.
 *
 * The ledger answers "dpk placed this digest, from this source, at this time".
 * It deliberately does **not** answer "which profile uses it": that is a fact
 * about the profiles, read from them when it is needed.
 *
 * @param root - dpk root.
 * @param entry - `{ name, version, digest, source, installedAt, refresh, live }`.
 * `refresh: false` on an existing row keeps its `installedAt`: a run that
 * changed nothing is not a new install, and the panel turns "installed after
 * this process started" into a restart prompt. `live: true` records that the
 * running Harness already loaded this one — the official service applied it —
 * so that prompt does not appear for it; it is cleared by any run that does not
 * apply.
 */
export async function recordInstall(root, entry) {
  const index = await updateIndex(root, (current) => {
    const existing = current.entries.find(item => item.name === entry.name
      && item.version === entry.version && item.digest === entry.digest)
    const installedAt = entry.installedAt ?? new Date().toISOString()
    // `live` describes this process, not the package: it must never survive a
    // run that did not apply, or a restart would look unnecessary forever.
    const live = entry.live === true
    if (existing === undefined) {
      current.entries.push({
        name: entry.name,
        version: entry.version,
        digest: entry.digest,
        installedAt,
        source: entry.source ?? null,
        ...(live ? { live: true } : {}),
      })
    } else {
      if (entry.refresh !== false) existing.installedAt = installedAt
      existing.source = entry.source ?? existing.source
      if (live) existing.live = true
      else delete existing.live
    }
    current.entries.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
    return current
  })
  return index.entries
}

/**
 * Find ledger entries matching `name` or `name@version`.
 * Version ranking lives in `versions.mjs`; this is the raw filter.
 */
export function matchEntries(entries, request) {
  const at = request.startsWith('@') ? request.indexOf('@', 1) : request.indexOf('@')
  const name = at === -1 ? request : request.slice(0, at)
  const version = at === -1 ? undefined : request.slice(at + 1)
  return entries.filter(entry => entry.name === name && (version === undefined || entry.version === version))
}

/**
 * The recorded installs the running Harness has **not** loaded: newer than this
 * process started, and not applied to it (`live: true`). These are the packages
 * that arrive at the next start, so both the panel and the actions name them.
 *
 * This replaces a one-shot marker file under the dpk root: the same question,
 * answered from the ledger that already exists, with no second copy of the
 * answer to keep in step.
 *
 * @param entries - ledger entries.
 * @param startedAt - process start in ms; defaults to this process's start.
 * @returns the entries a restart would load.
 */
export function pendingRestarts(entries, startedAt = Date.now() - process.uptime() * 1000) {
  return entries.filter((entry) => {
    if (entry?.live === true) return false
    const at = Date.parse(String(entry?.installedAt ?? ''))
    return Number.isFinite(at) && at >= startedAt
  })
}

/**
 * Whether any recorded install is waiting for a restart, i.e. whether the panel
 * has something to remind the user about.
 *
 * @param entries - ledger entries.
 * @param startedAt - process start in ms; defaults to this process's start.
 * @returns true when a restart is needed to load something installed since then.
 */
export function restartPending(entries, startedAt = Date.now() - process.uptime() * 1000) {
  return pendingRestarts(entries, startedAt).length > 0
}

/** Remove one store directory (used by `--reinstall` re-materialisation). */
export async function removeStoreDir(root, digest) {
  await rm(storeDir(root, digest), { recursive: true, force: true })
}
