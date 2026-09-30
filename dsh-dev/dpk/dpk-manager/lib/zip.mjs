/**
 * Minimal, dependency-free zip reader/writer for the DPK container.
 *
 * The DPK format intentionally reuses ordinary zip so any archive tool can read
 * it; this module is the normative implementation of the归档层 rules in
 * SPEC.md §5 (store/deflate only, UTF-8 names, no zip64, no encryption, strict
 * path validation, four bomb guards, byte-reproducible output).
 *
 * @module dpk/lib/zip
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** A rejected archive: structure, path, or limit violation. */
export class ZipError extends Error {
  constructor(message, code = 'ZIP_INVALID') {
    super(message)
    this.name = 'ZipError'
    this.code = code
  }
}

/** Hard limits that make archive bombs and pathological inputs decidable. */
export const ZIP_LIMITS = {
  maxEntries: 20_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  /** EOCD search window: comment + fixed record. */
  eocdSearchBytes: 66_000,
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const FLAG_ENCRYPTED = 0b0000_0000_0001
const FLAG_UTF8 = 0b0000_1000_0000
/** 1980-01-01T00:00:00Z in MS-DOS format — the reproducible default. */
export const DOS_EPOCH = { date: 0x0021, time: 0 }

/** Windows device names a path segment must never be. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

let crcTable

/** CRC-32 (IEEE 802.3) of a buffer, as zip stores it. */
export function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Int32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      crcTable[index] = value
    }
  }
  let crc = -1
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  return (crc ^ -1) >>> 0
}

/** Convert an ISO timestamp to an MS-DOS date/time pair, clamped to the format. */
export function dosDateTime(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) throw new ZipError(`invalid timestamp ${JSON.stringify(iso)}`, 'ZIP_BAD_TIMESTAMP')
  const year = at.getUTCFullYear()
  if (year < 1980 || year > 2107) throw new ZipError('zip timestamps must be between 1980 and 2107', 'ZIP_BAD_TIMESTAMP')
  return {
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
  }
}

/**
 * Validate one archive-internal path.
 * @param path - the entry name exactly as stored.
 * @param options - `allowDirectory` permits a trailing slash.
 * @returns normalized path (unchanged; validation only).
 */
export function validateArchivePath(path, options = {}) {
  const allowDirectory = options.allowDirectory === true
  if (typeof path !== 'string' || path.length === 0) throw new ZipError('archive path must be a non-empty string', 'ZIP_BAD_PATH')
  if (path.includes('\0')) throw new ZipError(`archive path contains NUL: ${JSON.stringify(path)}`, 'ZIP_BAD_PATH')
  if (Buffer.byteLength(path, 'utf8') > 512) throw new ZipError(`archive path is too long: ${path}`, 'ZIP_BAD_PATH')
  if (path.includes('\\')) throw new ZipError(`archive path must use "/" separators: ${path}`, 'ZIP_BAD_PATH')
  const isDirectory = path.endsWith('/')
  if (isDirectory && !allowDirectory) throw new ZipError(`unexpected directory entry: ${path}`, 'ZIP_BAD_PATH')
  const body = isDirectory ? path.slice(0, -1) : path
  if (body === '') throw new ZipError(`archive path has no segments: ${path}`, 'ZIP_BAD_PATH')
  if (body.startsWith('/')) throw new ZipError(`archive path must be relative: ${path}`, 'ZIP_BAD_PATH')
  if (/^[A-Za-z]:/.test(body)) throw new ZipError(`archive path must not carry a drive letter: ${path}`, 'ZIP_BAD_PATH')
  for (const segment of body.split('/')) {
    if (segment === '') throw new ZipError(`archive path has an empty segment: ${path}`, 'ZIP_BAD_PATH')
    if (segment === '.' || segment === '..') throw new ZipError(`archive path must not traverse: ${path}`, 'ZIP_BAD_PATH')
    if (segment !== segment.trim()) throw new ZipError(`archive path segment has surrounding spaces: ${path}`, 'ZIP_BAD_PATH')
    if (segment.endsWith('.')) throw new ZipError(`archive path segment ends with a dot: ${path}`, 'ZIP_BAD_PATH')
    if (WINDOWS_RESERVED.test(segment)) throw new ZipError(`archive path segment is a reserved device name: ${path}`, 'ZIP_BAD_PATH')
  }
  return path
}

/** Reject archive paths that only differ by case, which would collide on Windows. */
export function assertNoCaseCollisions(paths) {
  const seen = new Map()
  for (const path of paths) {
    const key = path.toLowerCase()
    const previous = seen.get(key)
    if (previous !== undefined && previous !== path) {
      throw new ZipError(`archive paths differ only by case: ${previous} / ${path}`, 'ZIP_CASE_COLLISION')
    }
    if (previous === path) throw new ZipError(`duplicate archive path: ${path}`, 'ZIP_DUPLICATE_PATH')
    seen.set(key, path)
  }
}

function flags(utf8 = true) {
  return utf8 ? FLAG_UTF8 : 0
}

/**
 * Build a zip buffer.
 * @param entries - `{ path, data, mode? }`; `path` is the archive-internal name.
 * @param options - `timestamp` (ISO, default the DOS epoch), `compress` (default true).
 * @returns the zip bytes, byte-identical for identical input.
 */
export function writeZip(entries, options = {}) {
  const timestamp = options.timestamp === undefined ? DOS_EPOCH : dosDateTime(options.timestamp)
  const compress = options.compress !== false
  if (entries.length > ZIP_LIMITS.maxEntries) {
    throw new ZipError(`too many entries: ${entries.length} > ${ZIP_LIMITS.maxEntries}`, 'ZIP_TOO_MANY_ENTRIES')
  }

  const prepared = entries.map((entry) => {
    const path = validateArchivePath(entry.path)
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    if (data.length > ZIP_LIMITS.maxEntryBytes) {
      throw new ZipError(`entry ${path} exceeds ${ZIP_LIMITS.maxEntryBytes} bytes`, 'ZIP_ENTRY_TOO_LARGE')
    }
    const deflated = compress ? deflateRawSync(data, { level: 9 }) : undefined
    const method = deflated !== undefined && deflated.length < data.length ? METHOD_DEFLATE : METHOD_STORE
    const payload = method === METHOD_DEFLATE ? deflated : data
    return { path, data, payload, method, crc: crc32(data), mode: entry.mode ?? 0o644 }
  })
  // Path order makes the output reproducible.
  prepared.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))

  const totalBytes = prepared.reduce((sum, entry) => sum + entry.data.length, 0)
  if (totalBytes > ZIP_LIMITS.maxTotalBytes) {
    throw new ZipError(`archive content exceeds ${ZIP_LIMITS.maxTotalBytes} bytes`, 'ZIP_TOTAL_TOO_LARGE')
  }
  assertNoCaseCollisions(prepared.map(entry => entry.path))

  const chunks = []
  const central = []
  let offset = 0
  for (const entry of prepared) {
    const name = Buffer.from(entry.path, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags(), 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt16LE(timestamp.time, 10)
    local.writeUInt16LE(timestamp.date, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, entry.payload)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(SIG_CENTRAL, 0)
    record.writeUInt16LE(0x031e, 4) // made by: unix, version 3.0
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(flags(), 8)
    record.writeUInt16LE(entry.method, 10)
    record.writeUInt16LE(timestamp.time, 12)
    record.writeUInt16LE(timestamp.date, 14)
    record.writeUInt32LE(entry.crc, 16)
    record.writeUInt32LE(entry.payload.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE((entry.mode & 0xffff) << 16, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)

    offset += local.length + name.length + entry.payload.length
  }

  const centralBuffer = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuffer, eocd])
}

/** Locate the end-of-central-directory record. */
function findEocd(buffer) {
  const start = Math.max(0, buffer.length - ZIP_LIMITS.eocdSearchBytes)
  for (let at = buffer.length - 22; at >= start; at -= 1) {
    if (buffer.readUInt32LE(at) === SIG_EOCD) return at
  }
  throw new ZipError('not a zip archive: no end-of-central-directory record', 'ZIP_NOT_ZIP')
}

/**
 * Read the central directory without inflating anything.
 * @param buffer - the archive bytes.
 * @returns `{ entries, totalBytes }`; each entry carries an inflate-on-demand handle.
 */
export function readZipIndex(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new ZipError('archive must be a Buffer', 'ZIP_BAD_INPUT')
  if (buffer.length < 22) throw new ZipError('archive is too small to be a zip', 'ZIP_NOT_ZIP')
  const eocd = findEocd(buffer)
  const diskEntries = buffer.readUInt16LE(eocd + 8)
  const totalEntries = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  // zip64 markers make the 16/32-bit fields meaningless, so they are checked first.
  if (totalEntries === 0xffff || diskEntries === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('zip64 archives are not supported', 'ZIP_ZIP64')
  }
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
    throw new ZipError('multi-disk archives are not supported', 'ZIP_MULTI_DISK')
  }
  if (diskEntries !== totalEntries) throw new ZipError('archive entry counts disagree', 'ZIP_INVALID')
  if (totalEntries > ZIP_LIMITS.maxEntries) {
    throw new ZipError(`too many entries: ${totalEntries} > ${ZIP_LIMITS.maxEntries}`, 'ZIP_TOO_MANY_ENTRIES')
  }
  if (centralOffset + centralSize > buffer.length) throw new ZipError('central directory runs past the archive', 'ZIP_TRUNCATED')

  const entries = []
  let cursor = centralOffset
  let totalBytes = 0
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length) throw new ZipError('central directory entry is truncated', 'ZIP_TRUNCATED')
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) throw new ZipError('central directory is malformed', 'ZIP_INVALID')
    const flag = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const time = buffer.readUInt16LE(cursor + 12)
    const date = buffer.readUInt16LE(cursor + 14)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttrs = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) throw new ZipError('central directory name is truncated', 'ZIP_TRUNCATED')
    if ((flag & FLAG_ENCRYPTED) !== 0) throw new ZipError('encrypted zip entries are not supported', 'ZIP_ENCRYPTED')
    if ((flag & 0x0008) !== 0) throw new ZipError('data-descriptor entries are not supported', 'ZIP_DATA_DESCRIPTOR')
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipError(`unsupported compression method ${method}`, 'ZIP_METHOD')
    }
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('zip64 entries are not supported', 'ZIP_ZIP64')
    }
    const path = buffer.subarray(nameStart, nameEnd).toString('utf8')
    validateArchivePath(path, { allowDirectory: true })
    const unixMode = (externalAttrs >>> 16) & 0xffff
    if ((unixMode & 0o170000) === 0o120000) throw new ZipError(`symlink entries are not supported: ${path}`, 'ZIP_SYMLINK')
    if (uncompressedSize > ZIP_LIMITS.maxEntryBytes) {
      throw new ZipError(`entry ${path} exceeds ${ZIP_LIMITS.maxEntryBytes} bytes`, 'ZIP_ENTRY_TOO_LARGE')
    }
    if (method === METHOD_DEFLATE && uncompressedSize > 0
      && compressedSize > 0 && uncompressedSize / compressedSize > ZIP_LIMITS.maxCompressionRatio) {
      throw new ZipError(`entry ${path} exceeds the ${ZIP_LIMITS.maxCompressionRatio}:1 compression-ratio limit`, 'ZIP_BOMB')
    }
    totalBytes += uncompressedSize
    if (totalBytes > ZIP_LIMITS.maxTotalBytes) {
      throw new ZipError(`archive content exceeds ${ZIP_LIMITS.maxTotalBytes} bytes`, 'ZIP_TOTAL_TOO_LARGE')
    }
    entries.push({
      path, method, crc, compressedSize, uncompressedSize, time, date, unixMode, localOffset,
    })
    cursor = nameEnd + extraLength + commentLength
  }
  assertNoCaseCollisions(entries.map(entry => entry.path))
  return { entries, totalBytes }
}

/** Inflate one entry read from {@link readZipIndex}. */
export function readZipEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== SIG_LOCAL) {
    throw new ZipError(`local header is missing for ${entry.path}`, 'ZIP_INVALID')
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buffer.length) throw new ZipError(`entry ${entry.path} is truncated`, 'ZIP_TRUNCATED')
  const payload = buffer.subarray(dataStart, dataEnd)
  const data = entry.method === METHOD_DEFLATE ? inflateRawSync(payload) : Buffer.from(payload)
  if (data.length !== entry.uncompressedSize) {
    throw new ZipError(`entry ${entry.path} size mismatch: ${data.length} != ${entry.uncompressedSize}`, 'ZIP_SIZE_MISMATCH')
  }
  const actual = crc32(data)
  if (actual !== entry.crc) {
    throw new ZipError(`entry ${entry.path} CRC mismatch: ${actual.toString(16)} != ${entry.crc.toString(16)}`, 'ZIP_CRC_MISMATCH')
  }
  return data
}

/**
 * Extract every file entry into `targetDir`, creating parent directories.
 * Validates all paths before writing anything, then verifies containment.
 * @param buffer - the archive bytes.
 * @param targetDir - absolute destination directory (must already exist or be creatable).
 * @param options - `onFile(path, bytes)` notification hook.
 * @returns the written relative paths, in archive order.
 */
export async function extractZip(buffer, targetDir, options = {}) {
  const { entries } = readZipIndex(buffer)
  const root = resolve(targetDir)
  const written = []
  for (const entry of entries) {
    const destination = resolve(root, entry.path)
    const inside = relative(root, destination)
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) {
      throw new ZipError(`entry escapes the target directory: ${entry.path}`, 'ZIP_ESCAPE')
    }
    if (entry.path.endsWith('/')) {
      await mkdir(destination, { recursive: true })
      continue
    }
    const data = readZipEntry(buffer, entry)
    await mkdir(dirname(destination), { recursive: true })
    const handle = await open(destination, 'wx')
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    written.push(entry.path)
    options.onFile?.(entry.path, data)
  }
  const realRoot = await realpath(root)
  for (const path of written) {
    const realFile = await realpath(join(root, path))
    const inside = relative(realRoot, realFile)
    if (inside === '..' || inside.startsWith(`..${sep}`)) {
      throw new ZipError(`entry resolved outside the target directory: ${path}`, 'ZIP_ESCAPE')
    }
  }
  return written
}

/** Write a buffer to disk, creating the parent directory. */
export async function writeFileEnsured(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
}
