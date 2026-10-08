/**
 * Build the optional source archive carried inside a DPK.
 *
 * Runtime files stay under `package/`. Files that are useful to inspect or
 * rebuild a plugin, but are not needed by DSH at runtime, are kept in one
 * deterministic gzip-compressed ustar archive carried as `source.tar.gz` at the
 * archive root. Test trees are never carried: they are validation inputs in the
 * source checkout, not distributable plugin content.
 *
 * @module dpk/lib/source-archive
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

export const SOURCE_ARCHIVE_FORMAT = 'tar.gz'
export const SOURCE_ARCHIVE_ENTRY = 'source.tar.gz'

const TEST_DIRECTORY_NAMES = new Set(['test', 'tests'])
const SOURCE_ONLY_DIRECTORY_NAMES = new Set(['scripts'])
const SOURCE_ONLY_FILE_NAMES = new Set([
  '.gitattributes',
  '.gitignore',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
])
const SOURCE_ONLY_FILE_PATTERN = /^(?:README|CHANGELOG|CONTRIBUTING|LICENSE)(?:\.|$)/i
const BUILD_CONFIG_PATTERN = /^(?:tsconfig(?:\..*)?|jsconfig(?:\..*)?)$/i
const TEST_FILE_PATTERN = /(?:^|[._-])(?:test|spec)(?:\.[^.]+)?\.[^.]+$/i

/** Normalize a package-relative path to a slash-separated path. */
function normalizePath(path) {
  return String(path).replace(/\\/g, '/')
}

/** A path under a test tree is deliberately omitted from both outputs. */
export function isTestPath(path) {
  const normalized = normalizePath(path)
  const segments = normalized.split('/')
  return segments.some(segment => TEST_DIRECTORY_NAMES.has(segment))
    || TEST_FILE_PATTERN.test(segments.at(-1) ?? '')
}

/**
 * Flatten package.json export targets into concrete path-like strings.
 * Conditions and arrays are only containers; the target strings are what
 * identify the runtime roots.
 */
function exportTargets(value, targets = []) {
  if (typeof value === 'string') targets.push(value)
  else if (Array.isArray(value)) for (const item of value) exportTargets(item, targets)
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) exportTargets(item, targets)
  }
  return targets
}

/** Convert a package target to the directory root it makes runtime-visible. */
function targetRoot(target) {
  const normalized = normalizePath(target).replace(/^\.\//, '')
  const wildcard = normalized.indexOf('*')
  const withoutWildcard = wildcard >= 0 ? normalized.slice(0, wildcard) : normalized
  if (withoutWildcard.endsWith('/')) return withoutWildcard
  const slash = withoutWildcard.lastIndexOf('/')
  return slash < 0 ? '' : withoutWildcard.slice(0, slash + 1)
}

/**
 * Return the package roots that DSH can load through the normal Node package
 * entry points. A source tree under `src/` remains runtime content when the
 * package actually exports or starts from it (as dpk-manager does).
 */
function runtimeTargets(manifest) {
  const targets = []
  if (typeof manifest.main === 'string') targets.push(manifest.main)
  exportTargets(manifest.exports, targets)
  exportTargets(manifest.browser, targets)
  exportTargets(manifest.bin, targets)
  const roots = new Set()
  const exact = new Set()
  for (const target of targets) {
    const normalized = normalizePath(target).replace(/^\.\//, '')
    if (normalized.includes('*')) roots.add(targetRoot(normalized))
    else {
      exact.add(normalized)
      const root = targetRoot(normalized)
      if (root !== '') roots.add(root)
    }
  }
  return { roots, exact }
}

/** Whether a runtime entry point or an explicitly referenced DSH asset uses it. */
function isRuntimePath(path, manifest, targets) {
  const normalized = normalizePath(path)
  if (normalized === 'package.json') return true
  if (isTestPath(normalized)) return false

  const segments = normalized.split('/')
  const first = segments[0]
  const fileName = segments.at(-1) ?? ''
  if (SOURCE_ONLY_DIRECTORY_NAMES.has(first)) return false
  if (SOURCE_ONLY_FILE_NAMES.has(fileName) || SOURCE_ONLY_FILE_PATTERN.test(fileName)) return false
  if (BUILD_CONFIG_PATTERN.test(fileName)) return false

  // An explicit DSH asset is runtime content even if it is not in an export.
  if (typeof manifest.icon === 'string' && normalized === normalizePath(manifest.icon).replace(/^\.\//, '')) return true
  const patch = manifest.dsh?.bundle?.patch
  const patches = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
  if (patches.some(item => normalized === normalizePath(item).replace(/^\.\//, ''))) return true
  const volumes = manifest.dsh?.data?.volumes ?? []
  if (volumes.some(volume => typeof volume.seed === 'string'
    && normalized === normalizePath(volume.seed).replace(/^\.\//, ''))) return true

  if (targets.exact.has(normalized)) return true
  for (const root of targets.roots) {
    if (normalized === root.slice(0, -1) || normalized.startsWith(root)) return true
  }
  // Packages without a declared entry point are still valid DSH plain
  // packages. Keep their non-development files runtime-visible by default.
  return targets.roots.size === 0 && targets.exact.size === 0
}

/**
 * Split validated package files into runtime content and source-only content.
 * Test files are omitted entirely and therefore never reach either output.
 */
export function splitPackageFiles(files, manifest) {
  const targets = runtimeTargets(manifest)
  const runtimeFiles = []
  const sourceFiles = []
  for (const file of files) {
    if (isTestPath(file.path)) continue
    if (isRuntimePath(file.path, manifest, targets)) runtimeFiles.push(file)
    else sourceFiles.push(file)
  }
  return { runtimeFiles, sourceFiles }
}

function octal(value, width) {
  const text = Math.max(0, value).toString(8)
  return `${'0'.repeat(Math.max(0, width - text.length - 1))}${text}\0`
}

function writeText(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new Error(`source archive path field is too long: ${value}`)
  bytes.copy(buffer, offset, 0, bytes.length)
}

function checksum(header) {
  let total = 0
  for (const byte of header) total += byte
  return octal(total, 8).padEnd(8, ' ')
}

/** Write one deterministic ustar file header. */
function tarHeader(path, size) {
  const header = Buffer.alloc(512, 0)
  const normalized = normalizePath(path)
  let name = normalized
  let prefix = ''
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const slash = normalized.lastIndexOf('/')
    if (slash <= 0) throw new Error(`source archive path is too long: ${path}`)
    prefix = normalized.slice(0, slash)
    name = normalized.slice(slash + 1)
    if (Buffer.byteLength(name, 'utf8') > 100 || Buffer.byteLength(prefix, 'utf8') > 155) {
      throw new Error(`source archive path is too long: ${path}`)
    }
  }
  writeText(header, 0, 100, name)
  writeText(header, 100, 8, octal(0o644, 8))
  writeText(header, 108, 8, octal(0, 8))
  writeText(header, 116, 8, octal(0, 8))
  writeText(header, 124, 12, octal(size, 12))
  writeText(header, 136, 12, octal(0, 12))
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeText(header, 257, 6, 'ustar\0')
  writeText(header, 263, 2, '00')
  writeText(header, 265, 32, 'root')
  writeText(header, 297, 32, 'root')
  writeText(header, 345, 155, prefix)
  writeText(header, 148, 8, checksum(header))
  return header
}

function padTo512(size) {
  return (512 - (size % 512)) % 512
}

/** Create a deterministic gzip-compressed ustar archive for source files. */
export async function createSourceArchive(files) {
  const sorted = [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
  const chunks = []
  const sourceEntries = []
  for (const file of sorted) {
    const path = normalizePath(file.path)
    const data = await readFile(file.absolute)
    const digest = createHash('sha256').update(data).digest('hex')
    sourceEntries.push({ path, size: data.length, sha256: digest })
    chunks.push(tarHeader(path, data.length), data, Buffer.alloc(padTo512(data.length)))
  }
  chunks.push(Buffer.alloc(1024))
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 })
  return {
    format: SOURCE_ARCHIVE_FORMAT,
    size: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    files: sourceEntries,
    buffer: archive,
  }
}
