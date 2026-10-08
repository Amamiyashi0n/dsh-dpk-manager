/**
 * Packing: a validated DSH package directory becomes a `.dpk` archive.
 *
 * @module dpk/lib/pack
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  archiveFileName, buildManifest, compareManifestToPackage, DPK_FORMAT_VERSION, DpkManifestError,
  PACKAGE_PREFIX, REPRODUCIBLE_EPOCH,
} from './dpk-manifest.mjs'
import { validateDshPackage } from './dsh-package.mjs'
import { exportVolumes, parseDataDeclaration } from './data.mjs'
import { appendDpkData } from './dpk-data.mjs'
import { createSourceArchive, SOURCE_ARCHIVE_ENTRY } from './source-archive.mjs'
import { writeZip } from './zip.mjs'

/**
 * Validate a package directory and build its archive.
 * @param directory - the package root to pack.
 * @param options - `timestamp` (ISO, overrides the reproducible DOS epoch),
 * `createdAt` (ISO; defaults to the reproducible epoch), `generator` override,
 * `compress: false` to store uncompressed.
 * @returns `{ buffer, manifest, fileName, source, sourceArchive }`; the optional
 * source archive is carried inside `buffer` as `source.tar.gz`.
 */
export async function packDirectory(directory, options = {}) {
  const source = await validateDshPackage(directory)
  const runtimeSource = { ...source, files: source.runtimeFiles }
  const sourceArchive = source.sourceFiles.length > 0
    ? await createSourceArchive(source.sourceFiles)
    : undefined
  const manifest = buildManifest({
    name: source.name,
    version: source.version,
    roles: source.roles,
    dsh: source.dsh,
    data: source.dataVolumes,
    engines: source.engines,
    peerDependencies: source.peerDependencies,
    files: source.runtimeFiles,
    // Reproducibility by default: identical input must yield identical bytes.
    createdAt: options.createdAt ?? REPRODUCIBLE_EPOCH,
    ...options.generator === undefined ? {} : { generator: options.generator },
  })

  // Pack and verify agree by construction: an archive this packer writes has
  // already passed the very cross-check an importer runs. Without this, a
  // formatting choice in package.json could produce an archive this same
  // verifier refuses, and the failure would only surface on whichever machine
  // imports it — the shape of the 2.1.8–2.1.10 volume defect.
  const problems = compareManifestToPackage(manifest, runtimeSource)
  if (problems.length > 0) {
    throw new DpkManifestError(
      `refusing to write an archive that verify would reject:\n  - ${problems.join('\n  - ')}`,
      'DPK_PACK_MISMATCH',
    )
  }

  const entries = [{
    path: 'dpk.json',
    data: Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8'),
    mode: 0o644,
  }]
  for (const file of source.runtimeFiles) {
    entries.push({
      path: `${PACKAGE_PREFIX}${file.path}`,
      data: await readFile(file.absolute),
      mode: 0o644,
    })
  }
  if (sourceArchive !== undefined) {
    entries.push({
      path: SOURCE_ARCHIVE_ENTRY,
      data: sourceArchive.buffer,
      mode: 0o644,
    })
  }
  const buffer = writeZip(entries, {
    ...options.timestamp === undefined ? {} : { timestamp: options.timestamp },
    compress: options.compress !== false,
  })
  return {
    buffer,
    manifest,
    fileName: archiveFileName(source.name, source.version),
    source: runtimeSource,
    sourceArchive,
    format: DPK_FORMAT_VERSION,
    root: resolve(directory),
  }
}

/**
 * Re-pack an installed package and attach its current managed data volumes.
 * `classes: ['app']` creates the portable runtime export; omitted classes
 * carries both app and data for migration.
 */
export async function packInstalledDirectory(directory, options = {}) {
  if (typeof options.home !== 'string' || options.home === '') {
    throw new Error('packInstalledDirectory needs the DSH home')
  }
  const packed = await packDirectory(directory, options)
  const packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const packageName = options.packageName ?? packed.manifest.name
  const declaration = parseDataDeclaration(packageJson.dsh?.data, `${packageName}: package.json`)
  const files = await exportVolumes(options.home, packageName, declaration, { classes: options.classes })
  const withData = appendDpkData(packed.buffer, packed.manifest.name, files)
  return {
    ...packed,
    buffer: withData.buffer,
    data: withData.manifest,
  }
}
