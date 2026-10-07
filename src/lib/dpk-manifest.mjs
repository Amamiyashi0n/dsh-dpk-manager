/**
 * The `dpk.json` manifest: construction, strict validation, and the integrity
 * digest defined by SPEC.md §4 and §7.
 *
 * Strictness rule: unknown fields are refused rather than ignored, so a typo can
 * never pass as a valid manifest. Older readers therefore fail loudly on newer
 * archives instead of silently dropping what they do not understand.
 *
 * @module dpk/lib/dpk-manifest
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { validateArchivePath } from './zip.mjs'
import { SEMVER, PACKAGE_NAME, PACKAGE_NAME_MAX_LENGTH } from './dsh-package.mjs'
import { parseDataDeclaration } from './data.mjs'

/** The format version this implementation writes and understands. */
export const DPK_FORMAT_VERSION = 1
/**
 * The manager version this build reports. It is part of the archive's identity,
 * not decoration: `generator` is how a reader names the packer whose semantics
 * an archive follows when a verification fails, so it has to track the release
 * rather than stay a constant. A test holds it equal to `package.json`.
 */
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
if (typeof PACKAGE_VERSION !== 'string' || PACKAGE_VERSION === '') {
  throw new Error('package.json must declare a non-empty version')
}
const DPK_TOOL_VERSION = PACKAGE_VERSION
/** Generator identity written into every manifest. */
export const DPK_GENERATOR = `dpk/${DPK_TOOL_VERSION}`
/** The one path a manifest's `entry` may name. */
export const DPK_ENTRY = 'package/package.json'
/** Every package file lives under this prefix. */
export const PACKAGE_PREFIX = 'package/'
/** The only integrity algorithm defined by v1. */
const INTEGRITY_ALGORITHM = 'sha256'
/** Roles derived from a package's own manifest. */
const ROLES = new Set(['bundle', 'client', 'plain'])
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * The top-level fields format 1 accepts, and nothing else.
 *
 * Exported because `schemas/dpk-1.schema.json` describes the same format for
 * readers: with no code validating against the schema, the two descriptions
 * drifted (the schema still offered a top-level `data` the validator refuses),
 * so the schema test compares its property names against these sets.
 */
export const MANIFEST_KEYS = new Set([
  'dpk', 'name', 'version', 'createdAt', 'generator', 'entry', 'roles',
  'dsh', 'engines', 'peerDependencies', 'files', 'integrity',
])
/** The fields one `files[]` entry carries. */
export const FILE_KEYS = new Set(['path', 'size', 'sha256'])
/** The fields `integrity` carries. */
export const INTEGRITY_KEYS = new Set(['algorithm', 'digest'])

/** A manifest that cannot be trusted as written. */
export class DpkManifestError extends Error {
  constructor(message, code = 'DPK_MANIFEST_INVALID', detail = {}) {
    super(message)
    this.name = 'DpkManifestError'
    this.code = code
    this.detail = detail
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Structural equality that never depends on how a value was spelled.
 *
 * Object key order is formatting, not content: a declaration whose keys were
 * reordered by an editor, a key-sorting formatter, or a differently built
 * packer still declares exactly the same thing. Array order stays significant,
 * because a list is a list. Every claim a manifest makes is checked with this
 * comparison — checking serialized text instead (the behaviour up to 2.1.10)
 * rejected archives over a whitespace choice, and reported a contradiction
 * where the two sides agreed on every value.
 *
 * @param left - first JSON value.
 * @param right - second JSON value.
 * @returns true when both carry the same values in the same shape.
 */
function sameStructure(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => sameStructure(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every(key =>
      Object.prototype.hasOwnProperty.call(right, key) && sameStructure(left[key], right[key]))
  }
  return false
}

function requireString(object, key, subject) {
  const value = object[key]
  if (typeof value !== 'string' || value === '') {
    throw new DpkManifestError(`${subject}.${key} must be a non-empty string`, 'DPK_MANIFEST_FIELD')
  }
  return value
}

/**
 * The canonical integrity digest (SPEC.md §7.2).
 * @param files - `{ path, size, sha256 }`, already sorted by path.
 * @returns lowercase hex sha256 over the joined canonical rows.
 */
export function computeIntegrity(files) {
  const rows = files.map(file => `${file.path}\0${file.size}\0${file.sha256}`)
  return createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex')
}

/** Sort file records into the canonical order the digest and the archive use. */
export function sortFiles(files) {
  return [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
}

/**
 * The conventional file name for a package (SPEC.md §2): `<name>@<version>.dpk`.
 *
 * `@` separates the two the way an npm spec does, so the boundary is never
 * ambiguous — `dsh-dpk-manager@2.1.53.dpk` cannot be misread as one hyphenated
 * name. The scope loses its `@` and `/` so the whole name stays one path segment.
 */
export function archiveFileName(name, version) {
  const short = name.startsWith('@') ? name.slice(1).replace('/', '-') : name
  return `${short}@${version}.dpk`
}

/** The fixed instant that makes an archive reproducible when the caller names no other. */
export const REPRODUCIBLE_EPOCH = '1980-01-01T00:00:00.000Z'

/**
 * Build a manifest from validated package facts.
 * @param input - identity, copied manifest fields, roles, and hashed files.
 * @returns the manifest object with `files` in canonical order and the digest set.
 */
export function buildManifest(input) {
  const files = sortFiles(input.files).map(file => ({
    // Package-relative input paths gain the archive prefix here, once.
    path: file.path.startsWith(PACKAGE_PREFIX) ? file.path : `${PACKAGE_PREFIX}${file.path}`,
    size: file.size,
    sha256: file.sha256,
  }))
  const manifest = {
    dpk: DPK_FORMAT_VERSION,
    name: input.name,
    version: input.version,
    createdAt: input.createdAt ?? new Date().toISOString(),
    generator: input.generator ?? DPK_GENERATOR,
    entry: DPK_ENTRY,
    roles: [...input.roles],
    ...input.dsh === undefined ? {} : { dsh: input.dsh },
    ...input.engines === undefined ? {} : { engines: input.engines },
    ...input.peerDependencies === undefined ? {} : { peerDependencies: input.peerDependencies },
    files,
    integrity: { algorithm: INTEGRITY_ALGORITHM, digest: computeIntegrity(files) },
  }
  // The archive carries the manifest as built — without the top-level `data`
  // copy — so pre-volumes whitelist readers accept it. Validation still runs
  // (it throws on any rule violation) but its normalized output, which always
  // spells volumes as `data`, is the caller's in-memory fact, not the bytes.
  validateManifest(manifest)
  return manifest
}

/**
 * Validate an untrusted manifest value.
 * @param value - parsed `dpk.json`.
 * @returns a normalized copy (never the input object).
 * @throws {DpkManifestError} with a code naming the violated rule.
 */
export function validateManifest(value) {
  if (!isPlainObject(value)) throw new DpkManifestError('dpk.json must be a JSON object', 'DPK_MANIFEST_INVALID')
  for (const key of Object.keys(value)) {
    if (MANIFEST_KEYS.has(key)) continue
    if (key === 'signatures') {
      throw new DpkManifestError('signatures are not defined by DPK v1; this archive needs a newer reader', 'DPK_VERSION')
    }
    throw new DpkManifestError(`dpk.json has an unknown field: ${key}`, 'DPK_MANIFEST_UNKNOWN_FIELD')
  }

  const format = value.dpk
  if (!Number.isInteger(format) || format < 1) {
    throw new DpkManifestError('dpk.json: dpk must be a positive integer format version', 'DPK_MANIFEST_FIELD')
  }
  if (format > DPK_FORMAT_VERSION) {
    throw new DpkManifestError(
      `dpk.json declares format ${format}; this reader understands up to ${DPK_FORMAT_VERSION}`,
      'DPK_VERSION',
    )
  }

  const name = requireString(value, 'name', 'dpk.json')
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) {
    throw new DpkManifestError(`dpk.json: name is not a package name the registry accepts: ${name}`, 'DPK_MANIFEST_FIELD')
  }
  const version = requireString(value, 'version', 'dpk.json')
  if (!SEMVER.test(version)) throw new DpkManifestError(`dpk.json: version is not semver: ${version}`, 'DPK_MANIFEST_FIELD')

  const createdAt = requireString(value, 'createdAt', 'dpk.json')
  if (!RFC3339_UTC.test(createdAt) || Number.isNaN(new Date(createdAt).getTime())) {
    throw new DpkManifestError('dpk.json: createdAt must be an RFC 3339 UTC timestamp', 'DPK_MANIFEST_FIELD')
  }
  const generator = requireString(value, 'generator', 'dpk.json')
  if (!/^[^/\s]+\/\S+$/.test(generator)) {
    throw new DpkManifestError('dpk.json: generator must read "<tool>/<version>"', 'DPK_MANIFEST_FIELD')
  }
  const entry = requireString(value, 'entry', 'dpk.json')
  if (entry !== DPK_ENTRY) {
    throw new DpkManifestError(`dpk.json: entry must be ${DPK_ENTRY}`, 'DPK_MANIFEST_FIELD')
  }

  const roles = value.roles
  if (!Array.isArray(roles) || roles.length === 0 || roles.some(role => typeof role !== 'string' || !ROLES.has(role))) {
    throw new DpkManifestError('dpk.json: roles must be a non-empty subset of bundle, client, plain', 'DPK_MANIFEST_FIELD')
  }
  if (new Set(roles).size !== roles.length) {
    throw new DpkManifestError('dpk.json: roles must not contain duplicates', 'DPK_MANIFEST_FIELD')
  }

  for (const key of ['dsh', 'engines', 'peerDependencies']) {
    const field = value[key]
    if (field === undefined) continue
    if (!isPlainObject(field)) throw new DpkManifestError(`dpk.json: ${key} must be an object`, 'DPK_MANIFEST_FIELD')
  }

  // Managed data volumes (SPEC §13): the declaration lives in exactly one
  // place, the verbatim `dsh` copy, and is revalidated on read so an
  // untrusted archive can never inject a volume the packer would have
  // refused. A top-level `data` key is rejected by the whitelist above.
  if (value.dsh !== undefined && value.dsh.data !== undefined) {
    parseDataDeclaration(value.dsh.data, 'dpk.json: dsh.data')
  }

  const files = value.files
  if (!Array.isArray(files) || files.length === 0) {
    throw new DpkManifestError('dpk.json: files must be a non-empty array', 'DPK_MANIFEST_FIELD')
  }
  const normalizedFiles = files.map((file, index) => {
    if (!isPlainObject(file)) throw new DpkManifestError(`dpk.json: files[${index}] must be an object`, 'DPK_MANIFEST_FIELD')
    for (const key of Object.keys(file)) {
      if (!FILE_KEYS.has(key)) {
        throw new DpkManifestError(`dpk.json: files[${index}] has an unknown field: ${key}`, 'DPK_MANIFEST_UNKNOWN_FIELD')
      }
    }
    const path = requireString(file, 'path', `dpk.json: files[${index}]`)
    validateArchivePath(path)
    if (!path.startsWith(PACKAGE_PREFIX)) {
      throw new DpkManifestError(`dpk.json: files[${index}].path must start with ${PACKAGE_PREFIX}`, 'DPK_MANIFEST_FIELD')
    }
    if (!Number.isInteger(file.size) || file.size < 0) {
      throw new DpkManifestError(`dpk.json: files[${index}].size must be a non-negative integer`, 'DPK_MANIFEST_FIELD')
    }
    if (typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256)) {
      throw new DpkManifestError(`dpk.json: files[${index}].sha256 must be 64 lowercase hex characters`, 'DPK_MANIFEST_FIELD')
    }
    return { path, size: file.size, sha256: file.sha256 }
  })
  const sorted = sortFiles(normalizedFiles)
  for (let index = 0; index < files.length; index += 1) {
    if (sorted[index].path !== normalizedFiles[index].path) {
      throw new DpkManifestError('dpk.json: files must be sorted by path', 'DPK_MANIFEST_ORDER')
    }
  }
  if (new Set(normalizedFiles.map(file => file.path)).size !== normalizedFiles.length) {
    throw new DpkManifestError('dpk.json: files lists a path twice', 'DPK_MANIFEST_FIELD')
  }

  const integrity = value.integrity
  if (!isPlainObject(integrity)) throw new DpkManifestError('dpk.json: integrity must be an object', 'DPK_MANIFEST_FIELD')
  for (const key of Object.keys(integrity)) {
    if (!INTEGRITY_KEYS.has(key)) {
      throw new DpkManifestError(`dpk.json: integrity has an unknown field: ${key}`, 'DPK_MANIFEST_UNKNOWN_FIELD')
    }
  }
  if (integrity.algorithm !== INTEGRITY_ALGORITHM) {
    throw new DpkManifestError(`dpk.json: integrity.algorithm must be ${INTEGRITY_ALGORITHM}`, 'DPK_MANIFEST_FIELD')
  }
  if (typeof integrity.digest !== 'string' || !SHA256_HEX.test(integrity.digest)) {
    throw new DpkManifestError('dpk.json: integrity.digest must be 64 lowercase hex characters', 'DPK_MANIFEST_FIELD')
  }
  const recomputed = computeIntegrity(normalizedFiles)
  if (recomputed !== integrity.digest) {
    throw new DpkManifestError(
      `dpk.json: integrity.digest does not match the file list (${recomputed} != ${integrity.digest})`,
      'DPK_INTEGRITY_MISMATCH',
    )
  }

  return {
    dpk: format,
    name,
    version,
    createdAt,
    generator,
    entry,
    roles: [...roles],
    ...value.dsh === undefined ? {} : { dsh: value.dsh },
    ...value.engines === undefined ? {} : { engines: { ...value.engines } },
    ...value.peerDependencies === undefined ? {} : { peerDependencies: { ...value.peerDependencies } },
    files: normalizedFiles,
    integrity: { algorithm: INTEGRITY_ALGORITHM, digest: integrity.digest },
  }
}

/**
 * Volumes in a canonical order, by id.
 *
 * The check below asks whether two declarations make the same claims, and a
 * claim does not depend on where in a list it was written: dpk materialises
 * every volume independently of the others. Sorting both sides removes the
 * last way a listing order could be mistaken for a contradiction (ids are
 * unique, so this is a total order).
 *
 * @param volumes - normalized volumes, already validated.
 * @returns a sorted copy.
 */
function canonicalVolumes(volumes) {
  return [...volumes].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * Name what actually differs between two volume declarations, by volume id.
 *
 * A mismatch is reported per volume instead of as two blobs of JSON, because
 * the reader's next move is to fix one of the declarations and the ids say
 * which one. Both sides arrive already normalized and canonically ordered.
 *
 * @param expected - volumes read from package.json.
 * @param claimed - volumes read from dpk.json.
 * @returns a parenthetical suffix for the problem line, empty when unnamed.
 */
function describeVolumeDifference(expected, claimed) {
  const idOf = volume => (typeof volume?.id === 'string' ? volume.id : JSON.stringify(volume))
  const expectedById = new Map(expected.map(volume => [idOf(volume), volume]))
  const claimedById = new Map(claimed.map(volume => [idOf(volume), volume]))
  const details = []
  const omitted = [...expectedById.keys()].filter(id => !claimedById.has(id))
  if (omitted.length > 0) details.push(`package.json declares ${omitted.join(', ')} but dpk.json omits it`)
  const added = [...claimedById.keys()].filter(id => !expectedById.has(id))
  if (added.length > 0) details.push(`dpk.json declares ${added.join(', ')} but package.json does not`)
  const changed = [...expectedById.keys()].filter(id =>
    claimedById.has(id) && !sameStructure(expectedById.get(id), claimedById.get(id)))
  if (changed.length > 0) details.push(`${changed.join(', ')} carries different fields on each side`)
  return details.length === 0 ? '' : ` (${details.join('; ')})`
}

/**
 * Cross-check a manifest against the package facts read from the archive.
 * @returns a list of human-readable mismatches (empty when consistent).
 */
export function compareManifestToPackage(manifest, source) {
  const problems = []
  // The name is compared as written. Archives carry the package's own bare name
  // and the scope is an install-time marking, so both sides read bare here; a
  // manifest that was localized at pack time belongs to a generation this reader
  // does not accept — say so instead of normalizing it into agreement.
  if (manifest.name !== source.name) problems.push(`name: dpk.json says ${manifest.name}, package.json says ${source.name}`)
  if (manifest.version !== source.version) {
    problems.push(`version: dpk.json says ${manifest.version}, package.json says ${source.version}`)
  }
  const roles = new Set(source.roles)
  for (const role of manifest.roles) {
    if (!roles.has(role)) problems.push(`roles: dpk.json claims ${role}, package.json does not declare it`)
  }
  for (const role of roles) {
    if (!manifest.roles.includes(role)) problems.push(`roles: package.json declares ${role}, dpk.json omits it`)
  }
  if (!sameStructure(source.dsh ?? null, manifest.dsh ?? null)) {
    problems.push('dsh: dpk.json copy differs from package.json')
  }
  // Both sides read the declaration through the same normalization, in the same
  // canonical order, so how the source spelled it — the order of a volume's
  // keys, the order of the volumes in the list, a trailing slash on a path —
  // decides nothing. Only a difference in the claims themselves can make this
  // line fail, which is what the message has always said.
  const expectedVolumes = canonicalVolumes(source.dataVolumes ?? [])
  const claimedVolumes = canonicalVolumes(parseDataDeclaration(manifest.dsh?.data, 'dpk.json: dsh.data'))
  if (!sameStructure(expectedVolumes, claimedVolumes)) {
    problems.push(`data: dpk.json volume declaration differs from package.json${describeVolumeDifference(expectedVolumes, claimedVolumes)}`)
  }
  for (const [key, actual] of [['engines', source.engines], ['peerDependencies', source.peerDependencies]]) {
    const declared = manifest[key]
    if (declared === undefined && actual === undefined) continue
    if (!sameStructure(declared ?? {}, actual ?? {})) {
      problems.push(`${key}: dpk.json copy differs from package.json`)
    }
  }
  const expectedFiles = new Map(source.files.map(file => [file.path, file]))
  for (const file of manifest.files) {
    const relative = file.path.startsWith(PACKAGE_PREFIX) ? file.path.slice(PACKAGE_PREFIX.length) : file.path
    // Every listed file must be a file of the package. An archive that lists a
    // never-packed directory (a `dist/` of nested archives, a checked-in
    // `node_modules`) was built by a generation this reader does not accept.
    const actual = expectedFiles.get(relative)
    if (actual === undefined) { problems.push(`files: ${file.path} is listed but absent from the package`); continue }
    if (actual.size !== file.size) problems.push(`files: ${file.path} size ${file.size} != ${actual.size}`)
    if (actual.sha256 !== file.sha256) problems.push(`files: ${file.path} sha256 differs from the package content`)
    expectedFiles.delete(relative)
  }
  for (const path of expectedFiles.keys()) problems.push(`files: ${path} is in the package but missing from dpk.json`)
  return problems
}
