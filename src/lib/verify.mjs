/**
 * Verification: archive structure, integrity, and strict DSH conformance.
 *
 * `verify` answers "can this archive be installed as a DSH plugin" without
 * installing it and without executing any package code.
 *
 * Cost shape (what the fast paths below are about): reading the index and the
 * manifest is milliseconds, hashing every entry is a decompression pass, and
 * *writing* the tree is the expensive part on Windows (one directory create and
 * one file create per entry). So verification offers two ways to avoid paying
 * for the tree twice:
 *
 *  - `extractTo`: verify and write in a single pass, then validate the tree in
 *    place. The installer uses this instead of "extract to a temp dir, validate,
 *    throw it away, extract again into the store".
 *  - `{ deep: false }`: hash-only, for a caller that already holds a verified
 *    copy of this exact digest in the content-addressed store.
 *
 * @module dpk/lib/verify
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PACKAGE_PREFIX, validateManifest, compareManifestToPackage, DpkManifestError, DPK_GENERATOR } from './dpk-manifest.mjs'
import { validateDshPackage, sha256 } from './dsh-package.mjs'
import { parseDataDeclaration } from './data.mjs'
import { DPK_DATA_ENTRY, readDpkData } from './dpk-data.mjs'
import { readZipEntry, readZipIndex } from './zip.mjs'

/** The manifest file at the archive root (`DPK_ENTRY` is the *package* entry, not this). */
const MANIFEST_ENTRY = 'dpk.json'

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
 * Read the archive layout and its manifest — no content hashing, no writes.
 *
 * Split out because the installer needs identity (name, version, digest) before
 * it can decide whether the store already holds this package, and that decision
 * must not cost a decompression pass.
 *
 * @param buffer - the `.dpk` bytes.
 * @returns `{ index, manifest, checks }`.
 * @throws {DpkArchiveError} / {DpkManifestError} / {ZipError} with a precise reason.
 */
export function inspectArchive(buffer) {
  const checks = []
  const index = readZipIndex(buffer)
  checks.push(`zip: ${index.entries.length} entries, ${index.totalBytes} uncompressed bytes, store/deflate only`)

  const filePaths = index.entries.filter(entry => !entry.path.endsWith('/')).map(entry => entry.path)
  for (const path of filePaths) {
    if (path === MANIFEST_ENTRY || path === DPK_DATA_ENTRY || path.startsWith(PACKAGE_PREFIX) || path.startsWith('data/')) continue
    throw new DpkArchiveError(`unexpected top-level entry: ${path} (only ${MANIFEST_ENTRY}, ${DPK_DATA_ENTRY}, ${PACKAGE_PREFIX} and data/ are allowed)`, 'DPK_LAYOUT')
  }
  if (!filePaths.includes(MANIFEST_ENTRY)) throw new DpkArchiveError(`archive has no ${MANIFEST_ENTRY}`, 'DPK_LAYOUT')
  if (filePaths.filter(path => path === MANIFEST_ENTRY).length !== 1) {
    throw new DpkArchiveError(`archive has more than one ${MANIFEST_ENTRY}`, 'DPK_LAYOUT')
  }

  const manifestEntry = findEntry(index, MANIFEST_ENTRY)
  const manifestBytes = readZipEntry(buffer, manifestEntry)
  let parsed
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw new DpkManifestError(`${MANIFEST_ENTRY} is not valid JSON: ${String(error)}`, 'DPK_MANIFEST_INVALID')
  }
  const manifest = validateManifest(parsed)
  const data = readDpkData(buffer, { index, package: manifest.name })
  if (data !== undefined) {
    const declared = parseDataDeclaration(manifest.dsh?.data, `${MANIFEST_ENTRY}: dsh.data`)
    const declaredPaths = new Set(declared.map(volume => `${volume.class}/${volume.path}`))
    for (const file of data.files) {
      if (!declaredPaths.has(file.path)) {
        throw new DpkArchiveError(
          `${DPK_DATA_ENTRY} carries ${file.path}, which the package does not declare`,
          'DPK_DATA_UNDECLARED',
        )
      }
    }
  }
  checks.push(`manifest: ${manifest.name}@${manifest.version}, format ${manifest.dpk}, roles ${manifest.roles.join('+')}`)
  checks.push(`integrity: digest ${manifest.integrity.digest} matches the declared file list`)

  // The archive must contain exactly the manifest's files.
  const manifestPaths = new Set(manifest.files.map(file => file.path))
  for (const path of filePaths) {
    if (path === MANIFEST_ENTRY || path === DPK_DATA_ENTRY || path.startsWith('data/')) continue
    if (!manifestPaths.has(path)) {
      throw new DpkArchiveError(`archive contains ${path}, which ${MANIFEST_ENTRY} does not list`, 'DPK_UNLISTED_FILE')
    }
  }
  return { index, manifest, data, checks, filePaths }
}

/**
 * The manifest alone, for callers that only need identity.
 * @param buffer - the `.dpk` bytes.
 */
export function readArchiveManifest(buffer) {
  return inspectArchive(buffer).manifest
}

/** One declared file's bytes, without checking them. */
function readEntry(buffer, index, file) {
  const entry = findEntry(index, file.path)
  if (entry === undefined) throw new DpkArchiveError(`archive is missing ${file.path}`, 'DPK_MISSING_FILE')
  return readZipEntry(buffer, entry)
}

/** Compare one entry's declared size and sha256 against its bytes. */
function verifiedEntry(buffer, index, file) {
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
  return data
}

/** Decompress and hash every declared file, writing nothing. */
function verifyContent(buffer, index, manifest) {
  for (const file of manifest.files) verifiedEntry(buffer, index, file)
  return `content: ${manifest.files.length} files match their size and sha256`
}

/**
 * Extract the package subtree of an archive, verifying each byte as it lands.
 *
 * One pass: every declared file is decompressed once, checked against its
 * declared size and sha256, and written straight to `targetDir`. A mismatch
 * aborts, and the caller removes the partially written tree — so nothing
 * unverified is ever trusted, and nothing is decompressed twice.
 *
 * Verification can be turned off for callers that already hashed the archive
 * (the reuse path: the content is already in a content-addressed store).
 *
 * @param buffer - the `.dpk` bytes.
 * @param index - the zip index (from {@link inspectArchive}).
 * @param manifest - the validated manifest.
 * @param targetDir - destination for the package subtree.
 * @param options - `verified: false` skips the size/sha256 check per file.
 * @returns the written package-relative paths.
 */
export async function extractTree(buffer, index, manifest, targetDir, options = {}) {
  const root = resolve(targetDir)
  const written = []
  let lastDirectory
  for (const file of manifest.files) {
    const data = options.verified === false ? readEntry(buffer, index, file) : verifiedEntry(buffer, index, file)
    const relative = file.path.slice(PACKAGE_PREFIX.length)
    const destination = join(root, relative)
    // One `mkdir` per *directory*, not per file: on Windows the syscall plus
    // the store's filter driver make a per-file create the dominant cost of an
    // install (104 files ≈ 285 ms, of which the writes are most of it).
    const directory = dirname(destination)
    if (directory !== lastDirectory) {
      await mkdir(directory, { recursive: true })
      lastDirectory = directory
    }
    await writeFile(destination, data, { flag: 'wx' })
    written.push(relative)
  }
  return written
}

/** Run the DSH conformance check on an extracted tree and compare it to the manifest. */
async function deepFacts(directory, manifest) {
  const packageFacts = await validateDshPackage(directory)
  const problems = compareManifestToPackage(manifest, packageFacts)
  if (problems.length > 0) {
    // Name both sides of the version pair: this check most often fails on a
    // machine whose reader differs from the packer that wrote the archive,
    // and the two versions are what the reader needs to align.
    throw new DpkArchiveError(
      `package/ contradicts ${MANIFEST_ENTRY}:\n  - ${problems.join('\n  - ')}`
      + `\n(archive written by ${manifest.generator}; this reader is ${DPK_GENERATOR})`,
      'DPK_MANIFEST_MISMATCH',
    )
  }
  return packageFacts
}

/**
 * Verify an archive end to end.
 *
 * `deep` (the default) checks that the package really is a DSH package, which
 * means writing its tree somewhere and validating it there; `extractTo` names
 * that place (the installer hands it its store staging directory), otherwise a
 * temporary directory is used and removed. `deep: false` hashes the archive
 * without extracting, for a caller whose store already holds this digest.
 *
 * @param buffer - the `.dpk` bytes.
 * @param options - `deep`, `extractTo`, `inspected` (an existing
 * {@link inspectArchive} result, so the archive is parsed once).
 * @returns `{ manifest, files, warnings, notes, checks }`.
 * @throws {DpkArchiveError} / {DpkManifestError} / {ZipError} / {PackageError} with a precise reason.
 */
export async function verifyArchive(buffer, options = {}) {
  const warnings = []
  const notes = []
  const { index, manifest, data, checks } = options.inspected ?? inspectArchive(buffer)

  let packageFacts
  if (options.deep !== false) {
    const target = options.extractTo === undefined ? await mkdtemp(join(tmpdir(), 'dpk-verify-')) : resolve(options.extractTo)
    try {
      await mkdir(target, { recursive: true })
      await extractTree(buffer, index, manifest, target)
      checks.push(`content: ${manifest.files.length} files match their size and sha256`)
      packageFacts = await deepFacts(target, manifest)
      checks.push(`dsh: package.json passes strict conformance (${packageFacts.roles.join('+')}, ${packageFacts.files.length} files)`)
      warnings.push(...packageFacts.warnings)
      notes.push(...packageFacts.checkNotes)
    } finally {
      if (options.extractTo === undefined) await rm(target, { recursive: true, force: true })
    }
  } else {
    checks.push(verifyContent(buffer, index, manifest))
    warnings.push('deep check skipped: DSH conformance of package/ was not re-validated')
  }

  return { manifest, data, files: manifest.files, warnings, notes, checks, packageFacts }
}

/** Small helper for callers that only need identity. */
export function describeManifest(manifest) {
  return `${manifest.name}@${manifest.version} (${manifest.roles.join('+')})`
}
