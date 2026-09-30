/**
 * Strict DSH package conformance, mirroring what the Harness itself reads.
 *
 * Every rule here has a counterpart in DSH source; the module never invents a
 * requirement and never executes package code (the same stance the Harness
 * takes when reading display metadata). Sources are cited per rule so the two
 * can be diffed when DSH moves.
 *
 * @module dpk/lib/dsh-package
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'

/** npm package-name grammar, copied from the Harness install-spec reader. */
export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
/** The registry's name length ceiling (`install-spec.ts:32`). */
export const PACKAGE_NAME_MAX_LENGTH = 214
/** Semver, permissive about prerelease/build but strict about the core. */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** Locale file language ids (`package-meta.ts:10`). */
export const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
/** Icon bytes admitted to plugin metadata (`package-meta.ts:15`). */
export const MAX_ICON_BYTES = 256 * 1024
/** Icon extensions and their media types (`package-meta.ts:16-19`). */
export const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
])
/** Directories a package never carries as content. */
export const NEVER_PACKED = new Set(['node_modules', '.git'])

/** A package that cannot be packed or installed. */
export class PackageError extends Error {
  constructor(message, code = 'PACKAGE_INVALID', detail = {}) {
    super(message)
    this.name = 'PackageError'
    this.code = code
    this.detail = detail
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(object, key) {
  const value = object[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function assertStringArray(value, subject) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new PackageError(`${subject} must be an array of strings`, 'PACKAGE_FIELD_TYPE')
  }
  return [...value]
}

/** Read one JSON file with a package-flavoured error. */
async function readJson(path, subject) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new PackageError(`${subject} cannot be read: ${String(error)}`, 'PACKAGE_MISSING')
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new PackageError(`${subject} is not valid JSON: ${String(error)}`, 'PACKAGE_JSON_INVALID')
  }
}

/**
 * Walk a package directory into a deterministic file list.
 * Symlinks are refused: a zip cannot carry them, and following one would pack
 * content from outside the package.
 * @param dir - absolute package root.
 * @returns `{ path, absolute, size, mode }`, sorted by posix path.
 */
export async function collectPackageFiles(dir) {
  const root = resolve(dir)
  const files = []
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new PackageError(`symlinks are not supported in a package: ${relative(root, absolute)}`, 'PACKAGE_SYMLINK')
      }
      if (entry.isDirectory()) {
        if (NEVER_PACKED.has(entry.name)) continue
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) {
        throw new PackageError(`unsupported file type: ${relative(root, absolute)}`, 'PACKAGE_FILE_TYPE')
      }
      const info = await stat(absolute)
      files.push({
        path: relative(root, absolute).split(sep).join('/'),
        absolute,
        size: info.size,
        mode: info.mode & 0o777,
      })
    }
  }
  await walk(root)
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
  return files
}

/** SHA-256 of a buffer as lowercase hex. */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Hash every collected file (content only; the bytes are re-read when packing). */
export async function hashFiles(files) {
  const hashed = []
  for (const file of files) {
    const data = await readFile(file.absolute)
    hashed.push({ path: file.path, absolute: file.absolute, size: data.length, sha256: sha256(data) })
  }
  return hashed
}

/** `package-meta.ts:24-28` — the icon must be a relative path with an allowed extension. */
function checkIconPath(icon, manifestPath) {
  if (isAbsolute(icon) || win32.isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) {
    throw new PackageError(`${manifestPath}: icon must be a relative file path`, 'PACKAGE_ICON')
  }
  const mediaType = ICON_MEDIA_TYPES.get(extname(icon).toLowerCase())
  if (mediaType === undefined) {
    throw new PackageError(`${manifestPath}: icon must be SVG, PNG, JPEG, or WebP`, 'PACKAGE_ICON')
  }
  return mediaType
}

/** `package-meta.ts:29-39` — realpath containment, regular file, size ceiling. */
async function checkIconFile(icon, directory) {
  let file
  try {
    file = await realpath(resolve(directory, icon))
  } catch {
    throw new PackageError(`${icon}: icon must exist inside its manifest directory`, 'PACKAGE_ICON')
  }
  const inside = relative(directory, file)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new PackageError(`${icon}: icon must remain inside its manifest directory`, 'PACKAGE_ICON')
  }
  const info = await stat(file)
  if (!info.isFile()) throw new PackageError(`${icon}: icon must be a regular file`, 'PACKAGE_ICON')
  if (info.size > MAX_ICON_BYTES) {
    throw new PackageError(`${icon}: icon exceeds 256 KiB`, 'PACKAGE_ICON')
  }
  return { file, size: info.size }
}

/** `package-meta.ts:101-122` — locale dictionaries and their display fields. */
async function checkLocales(directory, warnings) {
  const localeDir = join(directory, 'locale')
  let entries
  try {
    entries = await readdir(localeDir, { withFileTypes: true })
  } catch {
    warnings.push('no locale/ directory: the plugin card falls back to package.json name and description')
    return
  }
  let sawEnglish = false
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const language = entry.name.slice(0, -5)
    if (!LANGUAGE_ID.test(language)) {
      throw new PackageError(`locale/${entry.name}: filename must be a language id`, 'PACKAGE_LOCALE')
    }
    if (language.toLowerCase() === 'en') sawEnglish = true
    const path = join(localeDir, entry.name)
    const document = await readJson(path, `locale/${entry.name}`)
    if (!isPlainObject(document)) throw new PackageError(`locale/${entry.name} must be a JSON object`, 'PACKAGE_LOCALE')
    const meta = document.meta
    if (meta === undefined) continue
    if (!isPlainObject(meta)) throw new PackageError(`locale/${entry.name}: meta must be an object`, 'PACKAGE_LOCALE')
    for (const field of ['title', 'description']) {
      const value = meta[field]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.trim() === '') {
        throw new PackageError(`locale/${entry.name}: meta.${field} must be a non-empty string`, 'PACKAGE_LOCALE')
      }
    }
  }
  if (!sawEnglish) warnings.push('no locale/en.json: non-English cards fall back to package.json')
}

/**
 * Structural check of a loader patch file.
 * DPK does not implement a YAML parser; this only proves the file looks like the
 * top-level array the Loader requires, and says so in the verify output.
 * @returns the structural findings as warnings.
 */
async function checkPatchFile(absolute, subject) {
  const text = await readFile(absolute, 'utf8')
  if (text.trim() === '') throw new PackageError(`${subject} is empty`, 'PACKAGE_PATCH')
  const lines = text.split(/\r?\n/)
  let sawItem = false
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (line.startsWith('-')) { sawItem = true; continue }
    if (/^[^\s-]/.test(line)) {
      throw new PackageError(`${subject} must be a top-level YAML array; found ${JSON.stringify(line.slice(0, 40))}`, 'PACKAGE_PATCH')
    }
  }
  if (!sawItem) throw new PackageError(`${subject} declares no patch entries`, 'PACKAGE_PATCH')
  return `${subject}: structurally a top-level YAML array (full Loader semantics are checked when DSH mounts it)`
}

/**
 * Validate one DSH package directory.
 * @param directory - absolute package root.
 * @returns identity, roles, copied manifest fields, the file list, and warnings.
 * @throws {PackageError} for every rule violation, in the order the Harness would meet them.
 */
export async function validateDshPackage(directory) {
  const root = await realpath(resolve(directory))
  const manifestPath = join(root, 'package.json')
  const manifest = await readJson(manifestPath, 'package.json')
  if (!isPlainObject(manifest)) throw new PackageError('package.json must be a JSON object', 'PACKAGE_JSON_INVALID')

  const name = stringField(manifest, 'name')
  if (name === undefined) throw new PackageError('package.json: name is required', 'PACKAGE_NAME')
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) {
    throw new PackageError(`package.json: name is not one the registry accepts: ${name}`, 'PACKAGE_NAME')
  }
  const version = stringField(manifest, 'version')
  if (version === undefined) throw new PackageError('package.json: version is required', 'PACKAGE_VERSION')
  if (!SEMVER.test(version)) throw new PackageError(`package.json: version is not semver: ${version}`, 'PACKAGE_VERSION')

  const warnings = []
  const checkNotes = []
  const roles = []

  const dsh = manifest.dsh
  if (dsh !== undefined && !isPlainObject(dsh)) throw new PackageError('package.json: dsh must be an object', 'PACKAGE_DSH')
  if (dsh !== undefined) {
    if (dsh.manifestVersion !== undefined && dsh.manifestVersion !== 1) {
      throw new PackageError(`package.json: dsh.manifestVersion must be 1, received ${JSON.stringify(dsh.manifestVersion)}`, 'PACKAGE_DSH')
    }
    const bundle = dsh.bundle
    if (bundle !== undefined) {
      if (!isPlainObject(bundle)) throw new PackageError('package.json: dsh.bundle must be an object', 'PACKAGE_BUNDLE')
      const patch = bundle.patch
      const patches = typeof patch === 'string' ? [patch] : patch
      if (!Array.isArray(patches) || patches.length === 0 || patches.some(entry => typeof entry !== 'string' || entry === '')) {
        throw new PackageError('package.json: dsh.bundle.patch must be a non-empty path or list of paths', 'PACKAGE_BUNDLE')
      }
      for (const entry of patches) {
        if (isAbsolute(entry) || win32.isAbsolute(entry)) {
          throw new PackageError(`dsh.bundle.patch must be relative to the package: ${entry}`, 'PACKAGE_BUNDLE')
        }
        const absolute = resolve(root, entry)
        const inside = relative(root, absolute)
        if (inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
          throw new PackageError(`dsh.bundle.patch escapes the package: ${entry}`, 'PACKAGE_BUNDLE')
        }
        let info
        try {
          info = await stat(absolute)
        } catch {
          throw new PackageError(`dsh.bundle.patch file does not exist: ${entry}`, 'PACKAGE_BUNDLE')
        }
        if (!info.isFile()) throw new PackageError(`dsh.bundle.patch is not a file: ${entry}`, 'PACKAGE_BUNDLE')
        if (!/\.ya?ml$/i.test(entry)) throw new PackageError(`dsh.bundle.patch must be .yml or .yaml: ${entry}`, 'PACKAGE_BUNDLE')
        checkNotes.push(await checkPatchFile(absolute, entry))
      }
      roles.push('bundle')
    }
    const client = dsh.client
    if (client !== undefined) {
      if (!isPlainObject(client)) throw new PackageError('package.json: dsh.client must be an object', 'PACKAGE_CLIENT')
      const platform = stringField(client, 'platform')
      if (platform === undefined) throw new PackageError('package.json: dsh.client.platform is required', 'PACKAGE_CLIENT')
      if (client.immediately !== undefined && typeof client.immediately !== 'boolean') {
        throw new PackageError('package.json: dsh.client.immediately must be a boolean', 'PACKAGE_CLIENT')
      }
      assertStringArray(client.inject, 'package.json: dsh.client.inject')
      assertStringArray(client.external, 'package.json: dsh.client.external')
      roles.push('client')
    }
  }
  if (roles.length === 0) roles.push('plain')

  let icon
  const iconValue = manifest.icon
  if (iconValue !== undefined) {
    if (typeof iconValue !== 'string' || iconValue === '') {
      throw new PackageError('package.json: icon must be a non-empty string', 'PACKAGE_ICON')
    }
    const mediaType = checkIconPath(iconValue, manifestPath)
    const checked = await checkIconFile(iconValue, root)
    icon = { path: iconValue, mediaType, size: checked.size }
  }

  const engines = manifest.engines
  if (engines !== undefined) {
    if (!isPlainObject(engines) || Object.values(engines).some(entry => typeof entry !== 'string')) {
      throw new PackageError('package.json: engines must be an object of strings', 'PACKAGE_FIELD_TYPE')
    }
  }
  const peerDependencies = manifest.peerDependencies
  if (peerDependencies !== undefined) {
    if (!isPlainObject(peerDependencies) || Object.values(peerDependencies).some(entry => typeof entry !== 'string')) {
      throw new PackageError('package.json: peerDependencies must be an object of strings', 'PACKAGE_FIELD_TYPE')
    }
  }
  if (manifest.private !== undefined && typeof manifest.private !== 'boolean') {
    throw new PackageError('package.json: private must be a boolean', 'PACKAGE_FIELD_TYPE')
  }
  if (manifest.description !== undefined && typeof manifest.description !== 'string') {
    throw new PackageError('package.json: description must be a string', 'PACKAGE_FIELD_TYPE')
  }
  if (manifest.exports !== undefined && !isPlainObject(manifest.exports) && typeof manifest.exports !== 'string') {
    throw new PackageError('package.json: exports must be an object or a string', 'PACKAGE_FIELD_TYPE')
  }
  if (roles.includes('bundle') && isPlainObject(manifest.exports) && manifest.exports['./package.json'] === undefined) {
    warnings.push('exports does not expose "./package.json"; DSH tolerates this, but metadata readers resolve it through the export map')
  }

  await checkLocales(root, warnings)

  const files = await hashFiles(await collectPackageFiles(root))
  return {
    root,
    name,
    version,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    private: manifest.private === true,
    roles,
    dsh: dsh === undefined ? undefined : dsh,
    engines: engines === undefined ? undefined : { ...engines },
    peerDependencies: peerDependencies === undefined ? undefined : { ...peerDependencies },
    icon,
    manifest,
    files,
    warnings,
    checkNotes,
  }
}
