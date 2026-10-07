/**
 * dpk's scratch area: one cache directory, and the lifecycle of everything in it.
 *
 * ## What lives here
 *
 * Every write dpk performs is "stage, then rename onto the target", and all four
 * of those staging artifacts live in `<dpk root>/cache/`:
 *
 *   store placement   `cache/<digest>.tmp-<pid>-<n>/`        → `store/<digest>/`
 *   displaced copy    `cache/displaced-<digest>.tmp-<pid>-<n>/` → deleted after the swap
 *   ledger            `cache/index.json.tmp-<pid>-<n>`       → `dpk/index.json`
 *   profile manifest  `cache/manifest-<profile>.dpk-<pid>-<n>` → `profiles/<p>/package.json`
 *
 * Centralising them is what makes collection trivial: the directory holds
 * nothing but dpk's own scratch, so `autoremove` cleans one directory instead of
 * hunting staging names through `store/`, the dpk root and every profile.
 *
 * ## The lifecycle
 *
 *  - **Created** lazily by whichever writer stages first (`stageIn`).
 *  - **Emptied** by its writer: a successful rename moves the artifact out, and
 *    the writer then drops the directory if nothing is left in it
 *    (`pruneCache`) — a steady-state dpk root holds `store/` and `index.json`
 *    and nothing else.
 *  - **Collected** by `autoremove` alone, and only for entries whose writer is
 *    gone. A live writer's staging is never touched by anybody: the pid in the
 *    name is the ownership record, and an unrecognised name is not dpk's to
 *    judge — every artifact dpk writes carries a pid.
 *
 * The rename crosses directories now, so `<dpk root>/cache` has to sit on the
 * same filesystem as `store/` and the profiles being published to. All three
 * live under one `<home>` by default, and a rename that cannot cross fails
 * loudly rather than degrading into a non-atomic copy.
 *
 * @module dpk/lib/staging
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

let counter = 0

/** The one directory dpk stages in: `<dpk root>/cache`. */
export function cacheDir(dpkRootDir) {
  return join(dpkRootDir, 'cache')
}

/** The staging path for `label`, unique within this process. */
export function stagePath(cache, label, suffix) {
  counter += 1
  return join(cache, `${label}.${suffix}-${process.pid}-${counter}`)
}

/**
 * Create the cache directory when it is not there yet and return a staging path
 * inside it. Writers rename *into* another directory, so the cache has to exist
 * before the first rename.
 */
export async function stageIn(cache, label, suffix) {
  await mkdir(cache, { recursive: true })
  return stagePath(cache, label, suffix)
}

/**
 * Drop the cache directory when nothing is staged in it, so a successful write
 * leaves no trace behind.
 *
 * Best effort by design: `rmdir` refuses a non-empty directory, and a live
 * writer's staging landing there between the rename and this call is exactly the
 * case that has to survive.
 */
export async function pruneCache(cache) {
  const { rmdir } = await import('node:fs/promises')
  try {
    await rmdir(cache)
  } catch (_notEmptyOrAbsent) {
    // Someone is staging, or there was nothing to remove.
  }
}

/** The pid recorded in a staging name, or undefined for any other name. */
export function stagingPid(name) {
  const matched = /\.(?:tmp|dpk)-(\d+)-\d+$/.exec(name)
  return matched === null ? undefined : Number(matched[1])
}

/**
 * Whether the process that staged something is still running.
 *
 * `EPERM` means the pid exists but belongs to another user: that is alive, never
 * garbage. A pid the OS has recycled reads as alive too, which costs one
 * uncollected leftover and never deletes a live writer's staging.
 */
export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * The pid of a staging entry whose writer is gone — the one test every
 * collector applies, to the cache and to staging residue left in `store/` by
 * older generations alike.
 *
 * @param name - the directory entry name.
 * @returns the dead pid, or undefined when the name is not dpk staging or its
 * writer is still running.
 */
export function staleStagingPid(name) {
  const pid = stagingPid(name)
  return pid !== undefined && !processAlive(pid) ? pid : undefined
}

/**
 * Staging leftovers in one directory whose writer is gone.
 * @returns `{ name, path, pid, bytes }[]`, directories measured recursively.
 */
export async function staleStagingsIn(directory) {
  const { readdir, stat } = await import('node:fs/promises')
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (_absent) {
    return []
  }
  const found = []
  for (const entry of entries) {
    const pid = staleStagingPid(entry.name)
    if (pid === undefined) continue
    const path = join(directory, entry.name)
    found.push({ name: entry.name, path, pid, bytes: await measure(path, entry.isDirectory(), stat) })
  }
  return found
}

/** Bytes of a staging entry, so the report can say what was reclaimed. */
async function measure(path, isDirectory, stat) {
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  try {
    if (!isDirectory) return (await stat(path)).size
  } catch (_vanished) {
    return 0
  }
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (_vanished) {
    return 0
  }
  for (const entry of entries) {
    total += await measure(join(path, entry.name), entry.isDirectory(), stat)
  }
  return total
}
