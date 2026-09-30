/**
 * Verification: archive structure, integrity, and strict DSH conformance.
 *
 * `verify` answers "can this archive be installed as a DSH plugin" without
 * installing it and without executing any package code.
 *
 * @module dpk/lib/verify
 */

import { mkdtemp, mkdir, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DPK_ENTRY, PACKAGE_PREFIX, validateManifest, compareManifestToPackage, DpkManifestError } from './dpk-manifest.mjs'
import { validateDshPackage, sha256 } from './dsh-package.mjs'
import { extractZip, readZipEntry, readZipIndex } from './zip.mjs'

/** An archive that fails verification. */
export class DpkArchiveError extends Error {
  constructor(message, code = 'DPK_ARCHIVE_INVALID', detail = {}) {
    super(message)
    this.name = 'DpkArchiveError'
    this.code = code
    this.detail = detail
  }
}

/** Find one file entry by exact path. */
function findEntry(index, path) {
  return index.entries.find(entry => entry.path === path && !entry.path.endsWith('/'))
}

/**
 * Write the package subtree of an archive into `targetDir`.
 * Used by the deep check (into a temp dir) and by the store.
 * @returns the written package-relative paths.
 */
export async function extractPackageTree(buffer, manifest, targetDir) {
  const index = readZipIndex(buffer)
  const root = resolve(targetDir)
  const written = []
  for (const file of manifest.files) {
    const entry = findEntry(index, file.path)
    if (entry === undefined) throw new DpkArchiveError(`archive is missing ${file.path}`, 'DPK_MISSING_FILE')
    const data = readZipEntry(buffer, entry)
    const relative = file.path.slice(PACKAGE_PREFIX.length)
    const destination = join(root, relative)
    await mkdir(dirname(destination), { recursive: true })
    const handle = await open(destination, 'wx')
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    written.push(relative)
  }
  return written
}

/**
 * Verify an archive end to end.
 * @param buffer - the `.dpk` bytes.
 * @param options - `deep: false` skips the extract-and-validate-DSH step.
 * @returns `{ manifest, files, warnings, notes, checks }`.
 * @throws {DpkArchiveError} / {DpkManifestError} / {ZipError} / {PackageError} with a precise reason.
 */
export async function verifyArchive(buffer, options = {}) {
  const checks = []
  const warnings = []
  const notes = []

  const index = readZipIndex(buffer)
  checks.push(`zip: ${index.entries.length} entries, ${index.totalBytes} uncompressed bytes, store/deflate only`)

  const filePaths = index.entries.filter(entry => !entry.path.endsWith('/')).map(entry => entry.path)
  for (const path of filePaths) {
    if (path !== 'dpk.json' && !path.startsWith(PACKAGE_PREFIX)) {
      throw new DpkArchiveError(`unexpected top-level entry: ${path} (only dpk.json and package/ are allowed)`, 'DPK_LAYOUT')
    }
  }
  if (!filePaths.includes('dpk.json')) throw new DpkArchiveError('archive has no dpk.json', 'DPK_LAYOUT')
  if (filePaths.filter(path => path === 'dpk.json').length !== 1) {
    throw new DpkArchiveError('archive has more than one dpk.json', 'DPK_LAYOUT')
  }

  const manifestEntry = findEntry(index, 'dpk.json')
  const manifestBytes = readZipEntry(buffer, manifestEntry)
  let parsed
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw new DpkManifestError(`dpk.json is not valid JSON: ${String(error)}`, 'DPK_MANIFEST_INVALID')
  }
  const manifest = validateManifest(parsed)
  checks.push(`manifest: ${manifest.name}@${manifest.version}, format ${manifest.dpk}, roles ${manifest.roles.join('+')}`)
  checks.push(`integrity: digest ${manifest.integrity.digest} matches the declared file list`)

  // The archive must contain exactly the manifest's files.
  const manifestPaths = new Set(manifest.files.map(file => file.path))
  for (const path of filePaths) {
    if (path === 'dpk.json') continue
    if (!manifestPaths.has(path)) {
      throw new DpkArchiveError(`archive contains ${path}, which dpk.json does not list`, 'DPK_UNLISTED_FILE')
    }
  }
  for (const file of manifest.files) {
    const entry = findEntry(index, file.path)
    if (entry === undefined) throw new DpkArchiveError(`archive is missing ${file.path}`, 'DPK_MISSING_FILE')
    const data = readZipEntry(buffer, entry)
    if (data.length !== file.size) {
      throw new DpkArchiveError(`${file.path}: size ${data.length} != declared ${file.size}`, 'DPK_SIZE_MISMATCH')
    }
    const digest = sha256(data)
    if (digest !== file.sha256) {
      throw new DpkArchiveError(`${file.path}: sha256 ${digest} != declared ${file.sha256}`, 'DPK_HASH_MISMATCH')
    }
  }
  checks.push(`content: ${manifest.files.length} files match their size and sha256`)

  let packageFacts
  if (options.deep !== false) {
    const staging = await mkdtemp(join(tmpdir(), 'dpk-verify-'))
    try {
      await extractPackageTree(buffer, manifest, staging)
      packageFacts = await validateDshPackage(staging)
      const problems = compareManifestToPackage(manifest, packageFacts)
      if (problems.length > 0) {
        throw new DpkArchiveError(`package/ contradicts dpk.json:\n  - ${problems.join('\n  - ')}`, 'DPK_MANIFEST_MISMATCH')
      }
      checks.push(`dsh: package.json passes strict conformance (${packageFacts.roles.join('+')}, ${packageFacts.files.length} files)`)
      warnings.push(...packageFacts.warnings)
      notes.push(...packageFacts.checkNotes)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } else {
    warnings.push('deep check skipped: DSH conformance of package/ was not re-validated')
  }

  return { manifest, files: manifest.files, warnings, notes, checks, packageFacts }
}

/** Small helper for callers that only need identity. */
export function describeManifest(manifest) {
  return `${manifest.name}@${manifest.version} (${manifest.roles.join('+')})`
}
