/**
 * Managed data volumes, dpkg-style (SPEC.md §13).
 *
 * A package declares its durable files once (`dsh.data.volumes` in
 * package.json). dpk materialises, upgrades, and removes them by that
 * declaration alone — it never executes package code, and the plugin reads and
 * writes its own files at the paths dpk owns. The lifecycle follows dpkg:
 *
 *   install (first time)  seed files appear            (like a new conffile)
 *   install (upgrade)     unmodified seeds refresh,
 *                         user-modified seeds keep the
 *                         local copy, the new seed lands
 *                         next to it as .dpk-new       (like conffile prompt)
 *   remove                volumes stay                 (like dpkg remove)
 *   purge                 volumes are deleted          (like dpkg purge)
 *
 * Two classes, exactly two names:
 *   data  the package's declared settings — a seed the package ships produces
 *         them, and the declaration travels with the package (dpkg conffile)
 *   app   everything the package persists at runtime: sessions, credentials,
 *         derived data — this is what an export carries between machines
 *
 * @module dpk/lib/data
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Volume classes and their root directory under <home>/data/<package>/. */
const VOLUME_CLASSES = new Set(['data', 'app'])

/** A declaration or volume that cannot be used as written. */
export class DpkDataError extends Error {
  constructor(message, code = 'DPK_DATA_INVALID', detail = {}) {
    super(message)
    this.name = 'DpkDataError'
    this.code = code
    this.detail = detail
  }
}

const VOLUME_KEYS = new Set(['id', 'class', 'path', 'seed'])
const VOLUME_ID = /^[a-z][a-z0-9-]*$/
const MAX_VOLUMES = 64
const MAX_SEED_BYTES = 1024 * 1024

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a `dsh.data` declaration copied out of a package.json.
 * Strict like every other dpk layer: unknown fields and vague shapes are
 * refused, never guessed at.
 * @param value - the `dsh.data` field, `undefined` when absent.
 * @param subject - where the value came from, for error text.
 * @returns the normalized volumes (a fresh array), or `[]` when absent.
 */
export function parseDataDeclaration(value, subject = 'package.json') {
  if (value === undefined) return []
  if (!isPlainObject(value)) throw new DpkDataError(`${subject}: dsh.data must be an object`, 'DPK_DATA_INVALID')
  const volumes = value.volumes
  if (!Array.isArray(volumes)) throw new DpkDataError(`${subject}: dsh.data.volumes must be an array`, 'DPK_DATA_INVALID')
  if (volumes.length > MAX_VOLUMES) {
    throw new DpkDataError(`${subject}: dsh.data.volumes declares more than ${MAX_VOLUMES} volumes`, 'DPK_DATA_INVALID')
  }
  const seenIds = new Set()
  const seenPaths = new Map()
  const normalized = []
  for (const [index, volume] of volumes.entries()) {
    const where = `${subject}: dsh.data.volumes[${index}]`
    if (!isPlainObject(volume)) throw new DpkDataError(`${where} must be an object`, 'DPK_DATA_INVALID')
    for (const key of Object.keys(volume)) {
      if (!VOLUME_KEYS.has(key)) throw new DpkDataError(`${where} has an unknown field: ${key}`, 'DPK_DATA_UNKNOWN_FIELD')
    }
    const id = volume.id
    if (typeof id !== 'string' || !VOLUME_ID.test(id)) {
      throw new DpkDataError(`${where}.id must match ${VOLUME_ID}`, 'DPK_DATA_INVALID')
    }
    if (seenIds.has(id)) throw new DpkDataError(`${where}.id duplicates ${id}`, 'DPK_DATA_INVALID')
    seenIds.add(id)
    const klass = volume.class
    // Two classes, and no migration hint for the names older generations used:
    // those generations are not served, so there is nothing to point at.
    if (typeof klass !== 'string' || !VOLUME_CLASSES.has(klass)) {
      throw new DpkDataError(`${where}.class must be one of ${[...VOLUME_CLASSES].join(', ')}`, 'DPK_DATA_INVALID')
    }
    const path = volume.path
    if (typeof path !== 'string' || path === '') {
      throw new DpkDataError(`${where}.path must be a non-empty relative path`, 'DPK_DATA_INVALID')
    }
    if (path.includes('\\') || /^[a-z]:/i.test(path) || path.startsWith('/') || path.split('/').includes('..') || path.split('/').includes('.')) {
      throw new DpkDataError(`${where}.path must be a clean relative path: ${path}`, 'DPK_DATA_INVALID')
    }
    const normalizedPath = path.replace(/\/+$/, '') || path
    const classPaths = seenPaths.get(klass) ?? []
    const conflict = classPaths.find(previousPath =>
      normalizedPath === previousPath
      || normalizedPath.startsWith(`${previousPath}/`)
      || previousPath.startsWith(`${normalizedPath}/`))
    if (conflict !== undefined) {
      throw new DpkDataError(`${where}.path conflicts with ${klass}/${conflict}`, 'DPK_DATA_PATH_CONFLICT')
    }
    classPaths.push(normalizedPath)
    seenPaths.set(klass, classPaths)
    const seed = volume.seed
    if (seed !== undefined && (typeof seed !== 'string' || seed === '')) {
      throw new DpkDataError(`${where}.seed must be a package-relative path or absent`, 'DPK_DATA_INVALID')
    }
    if (seed !== undefined && (
      seed.includes('\\') || /^[a-z]:/i.test(seed) || seed.startsWith('/')
      || seed.split('/').includes('..') || seed.split('/').includes('.')
    )) {
      throw new DpkDataError(`${where}.seed must be a clean package-relative path: ${seed}`, 'DPK_DATA_INVALID')
    }
    normalized.push({ id, class: klass, path: normalizedPath, ...(seed === undefined ? {} : { seed }) })
  }
  return normalized
}

/**
 * The managed-data root for one package: `<home>/data/<package>`.
 * The scope directory keeps `@local/pkg` from colliding with `pkg`.
 */
export function dataRoot(home, packageName) {
  if (typeof packageName !== 'string' || packageName === '') {
    throw new DpkDataError('a package name is required to derive its data root', 'DPK_DATA_INVALID')
  }
  if (packageName.includes('/')) {
    const [scope, rest] = packageName.split('/')
    return join(resolve(home), 'data', scope, rest)
  }
  return join(resolve(home), 'data', packageName)
}

/** The on-disk location of one declared volume. */
export function volumePath(home, packageName, volume) {
  return join(dataRoot(home, packageName), volume.class, volume.path)
}

/** The sidecar remembering which seed generation a volume was placed from. */
function markerPath(home, packageName, volume) {
  return join(dataRoot(home, packageName), '.dpk', `${volume.id}.seed.json`)
}

async function readMarker(home, packageName, volume) {
  const path = markerPath(home, packageName, volume)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    const digest = parsed?.seed
    return typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest) ? digest : undefined
  } catch {
    return undefined
  }
}

async function writeMarker(home, packageName, volume, seedDigest) {
  const path = markerPath(home, packageName, volume)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ seed: seedDigest }, undefined, 2)}\n`)
}

/**
 * Materialise one package's declared volumes under its data root, using the
 * dpkg conffile rule for upgrades.
 *
 * Seeded volumes (`seed` names a file inside the installed package): first
 * install copies the seed out; an upgrade refreshes it only when the user has
 * not modified the local copy, otherwise the new seed lands beside it as
 * `<name>.dpk-new` and the local copy stays untouched.
 *
 * Unseeded volumes: nothing is written at install time; the directory only
 * exists once the plugin itself writes there. That keeps first activation the
 * single init point (the plugin cannot rely on files dpk never promised).
 *
 * @param home - DSH home (`~/.dsh`).
 * @param packageName - the localized package name (`@local/…`).
 * @param volumes - parsed declarations from the installed package.
 * @param packageDir - the store directory the plugin manager installed.
 * @param options - `{ log }`.
 * @returns per-volume outcomes for the install report.
 */
export async function materializeVolumes(home, packageName, volumes, packageDir, options = {}) {
  const log = options.log ?? (() => {})
  // Pass 1 — resolve and validate every volume, writing nothing.
  //
  // The decisions are all made from what is on disk (does the file exist, which
  // seed generation placed it, has the user edited it), and every failure a
  // declaration can cause — a seed that escapes the package, is missing, or is
  // over the ceiling — is raised here. So a volume set that cannot be satisfied
  // leaves the data root exactly as it was, instead of refreshing the first
  // three volumes and then throwing on the fourth.
  const planned = []
  for (const volume of volumes) {
    const target = volumePath(home, packageName, volume)
    if (volume.seed === undefined) {
      planned.push({ volume, target, action: 'declared' })
      continue
    }
    const seedPath = join(packageDir, volume.seed)
    const insidePackage = relative(resolve(packageDir), resolve(packageDir, volume.seed))
    if (insidePackage.startsWith(`..${sep}`) || insidePackage === '..' || isAbsolute(insidePackage)) {
      throw new DpkDataError(`volume ${volume.id}: seed must stay inside the package: ${volume.seed}`, 'DPK_DATA_ESCAPE')
    }
    if (!existsSync(seedPath)) {
      throw new DpkDataError(`volume ${volume.id}: seed file missing from the package: ${volume.seed}`, 'DPK_DATA_SEED_MISSING')
    }
    const seedBytes = await readFile(seedPath)
    if (seedBytes.length > MAX_SEED_BYTES) {
      throw new DpkDataError(`volume ${volume.id}: seed exceeds ${MAX_SEED_BYTES} bytes`, 'DPK_DATA_INVALID')
    }
    const seedDigest = createHash('sha256').update(seedBytes).digest('hex')
    const placedDigest = await readMarker(home, packageName, volume)
    let action
    if (!existsSync(target)) {
      action = 'seeded'
    } else if (placedDigest === undefined) {
      // Pre-management file (the old layout). It is user data by definition:
      // never overwritten, flagged for attention.
      action = 'adopted'
    } else {
      const localDigest = createHash('sha256').update(await readFile(target)).digest('hex')
      if (localDigest === seedDigest && placedDigest === seedDigest) {
        // Already exactly this seed generation: rewriting the file and its marker
        // would be two writes that change nothing, and they would make a repeat
        // install look like work that needs a restart.
        action = 'unchanged'
      } else if (localDigest === placedDigest || localDigest === seedDigest) {
        // Unmodified (or already at the new seed): refresh in place.
        action = 'refreshed'
      } else {
        // User-modified: keep it, stage the new seed beside it (dpkg's .dpk-new).
        action = 'kept-local'
      }
    }
    planned.push({ volume, target, action, seedBytes, seedDigest })
  }

  // Pass 2 — apply what pass 1 decided.
  const outcomes = []
  for (const { volume, target, action, seedBytes, seedDigest } of planned) {
    if (action === 'declared') {
      outcomes.push({ id: volume.id, class: volume.class, path: target, action: 'declared' })
      continue
    }
    if (action === 'adopted') {
      outcomes.push({ id: volume.id, class: volume.class, path: target, action: 'adopted' })
      continue
    }
    if (action === 'unchanged') {
      outcomes.push({ id: volume.id, class: volume.class, path: target, action: 'unchanged' })
      continue
    }
    if (action === 'seeded') {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, seedBytes)
      await writeMarker(home, packageName, volume, seedDigest)
      log(`data     ${volume.class}/${volume.path} seeded`)
      outcomes.push({ id: volume.id, class: volume.class, path: target, action: 'seeded' })
      continue
    }
    if (action === 'refreshed') {
      await writeFile(target, seedBytes)
      await writeMarker(home, packageName, volume, seedDigest)
      outcomes.push({ id: volume.id, class: volume.class, path: target, action: 'refreshed' })
      continue
    }
    const staged = `${target}.dpk-new`
    await writeFile(staged, seedBytes)
    outcomes.push({ id: volume.id, class: volume.class, path: target, action: 'kept-local', staged })
  }
  return outcomes
}

/**
 * Report the managed-data state of one package: which volumes exist, which
 * seeds are pending, and which declared files a fresh machine still lacks.
 * `dpk list` and the panel render this; nothing is written.
 */
export async function describeVolumes(home, packageName, volumes, packageDir) {
  const entries = []
  for (const volume of volumes) {
    const path = volumePath(home, packageName, volume)
    const exists = existsSync(path)
    let seedDigest
    if (volume.seed !== undefined && packageDir !== undefined) {
      try {
        seedDigest = createHash('sha256')
          .update(await readFile(join(packageDir, volume.seed)))
          .digest('hex')
      } catch { seedDigest = undefined }
    }
    const placed = await readMarker(home, packageName, volume)
    let localDigest
    if (exists) {
      try {
        localDigest = createHash('sha256').update(await readFile(path)).digest('hex')
      } catch { localDigest = undefined }
    }
    entries.push({
      id: volume.id,
      class: volume.class,
      path,
      exists,
      ...(volume.seed === undefined ? {} : {
        // `seeded` means "byte-identical to a known seed generation"; any
        // other content (user-edited, imported, pre-management) is user-owned.
        seeded: exists && placed !== undefined && localDigest === placed,
        pendingSeed: existsSync(`${path}.dpk-new`) ? `${path}.dpk-new` : undefined,
      }),
    })
  }
  return entries
}

/**
 * Remove every declared volume plus the data root itself (dpkg purge).
 * @returns `{ purged, root, volumes }`; `volumes` are the files under the root.
 */
export async function purgeVolumes(home, packageName) {
  const root = dataRoot(home, packageName)
  if (!existsSync(root)) return { purged: false, root, volumes: [] }
  const volumes = await listFiles(root)
  await rm(root, { recursive: true, force: true })
  return { purged: true, root, volumes }
}

/** Every file under a directory, relative to it (sorted, for a stable report). */
async function listFiles(directory, prefix = '') {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (_missing) {
    return []
  }
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

/**
 * Export the declared volumes of one package that exist on disk.
 *
 * `options.classes` says which classes travel; omitted means all of them. The
 * caller decides: `export` passes `['app']`, `snap` passes nothing.
 *
 * @param home - DSH home (`~/.dsh`).
 * @param packageName - the localized package name (`@local/…`).
 * @param volumes - normalized declarations from the installed package.
 * @param options - `classes`: the classes to carry; omitted means all of them.
 * @returns `{ volume, path, bytes }[]`; `path` is `<class>/<volume path>`, the
 * label the export carries and the import maps back through the declaration the
 * package holds at that moment.
 */
export async function exportVolumes(home, packageName, volumes, options = {}) {
  const wanted = options.classes === undefined ? undefined : new Set(options.classes)
  const files = []
  for (const volume of volumes) {
    if (wanted !== undefined && !wanted.has(volume.class)) continue
    const path = volumePath(home, packageName, volume)
    if (!existsSync(path)) continue
    files.push({
      volume: volume.id,
      path: `${volume.class}/${volume.path}`,
      bytes: await readFile(path),
    })
  }
  return files
}

/**
 * Import volumes written by {@link exportVolumes}: each lands at the class
 * directory the package declares **now** — the entry's class prefix is only a
 * label from the export, not the destination. Files land as user-owned data
 * (any existing file is overwritten).
 *
 * @param options - `log`.
 */
export async function importDataVolumes(home, packageName, volumes, files, options = {}) {
  // A carried entry is named `<class>/<path>`, and the declaration is what
  // decides where it lands. The exact pair is tried first, because one relative
  // path may be declared in both classes at once (`data/x` and `app/x` are both
  // legal); the path alone is the fallback for a package that moved a volume
  // between classes since the export was taken.
  const allowed = new Map()
  for (const volume of volumes) {
    if (!allowed.has(`${volume.class}/${volume.path}`)) allowed.set(`${volume.class}/${volume.path}`, volume)
    if (!allowed.has(volume.path)) allowed.set(volume.path, volume)
  }
  const log = options.log ?? (() => {})
  const applied = []
  for (const file of files) {
    const volume = allowed.get(file.path) ?? allowed.get(file.path.replace(/^(?:data|app)\//, ''))
    if (volume === undefined) {
      throw new DpkDataError(`import carries ${file.path}, which the package does not declare as a data volume`, 'DPK_DATA_IMPORT_UNDECLARED')
    }
    const target = volumePath(home, packageName, volume)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.bytes)
    // Imported files are user data, not seed output: remove any old marker so
    // a later upgrade treats them as modified and never overwrites silently.
    await rm(markerPath(home, packageName, volume), { force: true })
    applied.push(target)
    log(`data     ${file.path} imported`)
  }
  return applied
}
