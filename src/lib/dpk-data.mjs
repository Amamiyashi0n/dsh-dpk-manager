/**
 * Optional data payload carried by a DPK package archive.
 *
 * A normal DPK contains `dpk.json` and `package/*`.  An exported DPK may also
 * contain `dpk-data.json` and `data/<class>/<path>` entries.  The package
 * digest remains the digest of the package tree; the data payload is a
 * migration layer for the same installed package.
 *
 * @module dpk/lib/dpk-data
 */

import { createHash } from 'node:crypto'
import { readZipEntry, readZipIndex, writeZip } from './zip.mjs'

export const DPK_DATA_ENTRY = 'dpk-data.json'
export const DPK_DATA_FORMAT = 'dpk-data/1'
const DATA_PREFIX = 'data/'
const SHA256_HEX = /^[0-9a-f]{64}$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu

function malformed(message) {
  const error = new Error(message)
  error.code = 'DPK_DATA_ARCHIVE_INVALID'
  return error
}

function validateRelativePath(path, subject) {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.includes('\0')
    || path.startsWith('/') || /^[A-Za-z]:/u.test(path)
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw malformed(`${subject} must be a clean relative path: ${path}`)
  }
}

function validateVolumePath(path, subject) {
  validateRelativePath(path, subject)
  if (!/^(?:app|data)\//u.test(path)) {
    throw malformed(`${subject} must start with app/ or data/: ${path}`)
  }
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseManifest(buffer, index, expectedPackage) {
  const entry = index.entries.find(item => item.path === DPK_DATA_ENTRY && !item.path.endsWith('/'))
  const dataPaths = index.entries
    .filter(item => !item.path.endsWith('/') && item.path.startsWith(DATA_PREFIX))
    .map(item => item.path.slice(DATA_PREFIX.length))
  if (entry === undefined && dataPaths.length === 0) return undefined
  if (entry === undefined) throw malformed(`archive carries data entries but no ${DPK_DATA_ENTRY}`)

  let payload
  try {
    payload = JSON.parse(readZipEntry(buffer, entry).toString('utf8'))
  } catch (error) {
    throw malformed(`${DPK_DATA_ENTRY} is not valid JSON: ${String(error)}`)
  }
  if (payload?.format !== DPK_DATA_FORMAT) throw malformed(`${DPK_DATA_ENTRY}.format must be ${DPK_DATA_FORMAT}`)
  if (typeof payload.package !== 'string' || !PACKAGE_NAME.test(payload.package)) {
    throw malformed(`${DPK_DATA_ENTRY}.package must be a package name`)
  }
  if (expectedPackage !== undefined && payload.package !== expectedPackage) {
    throw malformed(`${DPK_DATA_ENTRY}.package ${payload.package} does not match ${expectedPackage}`)
  }
  if (!Array.isArray(payload.files)) throw malformed(`${DPK_DATA_ENTRY}.files must be an array`)

  const files = payload.files.map((file, indexInManifest) => {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw malformed(`${DPK_DATA_ENTRY}.files[${indexInManifest}] must be an object`)
    }
    const { path, size, sha256 } = file
    validateVolumePath(path, `${DPK_DATA_ENTRY}.files[${indexInManifest}].path`)
    if (!Number.isSafeInteger(size) || size < 0) throw malformed(`${DPK_DATA_ENTRY}.files[${indexInManifest}].size must be a non-negative integer`)
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) throw malformed(`${DPK_DATA_ENTRY}.files[${indexInManifest}].sha256 must be lowercase sha256`)
    return { path, size, sha256 }
  })
  files.sort((left, right) => left.path.localeCompare(right.path))
  const seen = new Set()
  for (const file of files) {
    if (seen.has(file.path)) throw malformed(`${DPK_DATA_ENTRY} lists ${file.path} more than once`)
    seen.add(file.path)
    const archivePath = `${DATA_PREFIX}${file.path}`
    if (!dataPaths.includes(file.path)) throw malformed(`archive is missing ${archivePath}`)
    const bytes = readZipEntry(buffer, index.entries.find(item => item.path === archivePath))
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) {
      throw malformed(`${archivePath} does not match its declared size or sha256`)
    }
  }
  for (const path of dataPaths) {
    if (!seen.has(path)) throw malformed(`archive contains unlisted data entry: ${DATA_PREFIX}${path}`)
  }

  return {
    format: DPK_DATA_FORMAT,
    package: payload.package,
    files: files.map(file => ({
      path: file.path,
      bytes: readZipEntry(buffer, index.entries.find(item => item.path === `${DATA_PREFIX}${file.path}`)),
    })),
  }
}

/** Read the optional data payload from a DPK buffer. */
export function readDpkData(buffer, options = {}) {
  const index = options.index ?? readZipIndex(buffer)
  return parseManifest(buffer, index, options.package)
}

/**
 * Append one package's current data volumes to an already packed DPK.
 * `files` use the same `<class>/<relative path>` labels as the import layer.
 */
export function appendDpkData(buffer, packageName, files) {
  if (typeof packageName !== 'string' || packageName === '') throw malformed('a package name is required for DPK data')
  if (!Array.isArray(files)) throw malformed('DPK data files must be an array')
  const index = readZipIndex(buffer)
  if (index.entries.some(entry => entry.path === DPK_DATA_ENTRY || entry.path.startsWith(DATA_PREFIX))) {
    throw malformed('the DPK already carries a data payload')
  }

  const normalized = files.map((file, indexInFiles) => {
    if (file === null || typeof file !== 'object' || Array.isArray(file) || !Buffer.isBuffer(file.bytes)) {
      throw malformed(`data file ${indexInFiles} must contain a Buffer`)
    }
    validateVolumePath(file.path, `data file ${indexInFiles}.path`)
    return { path: file.path, bytes: file.bytes }
  }).sort((left, right) => left.path.localeCompare(right.path))
  const seen = new Set()
  for (const file of normalized) {
    if (seen.has(file.path)) throw malformed(`DPK data carries ${file.path} more than once`)
    seen.add(file.path)
  }

  const manifest = {
    format: DPK_DATA_FORMAT,
    package: packageName,
    files: normalized.map(file => ({ path: file.path, size: file.bytes.length, sha256: hash(file.bytes) })),
  }
  const entries = index.entries.map(entry => ({
    path: entry.path,
    data: readZipEntry(buffer, entry),
    mode: 0o644,
  }))
  entries.push({
    path: DPK_DATA_ENTRY,
    data: Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8'),
    mode: 0o644,
  })
  for (const file of normalized) entries.push({ path: `${DATA_PREFIX}${file.path}`, data: file.bytes, mode: 0o644 })
  return {
    buffer: writeZip(entries, { compress: true }),
    manifest,
  }
}

