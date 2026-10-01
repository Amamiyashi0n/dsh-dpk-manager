/**
 * Packing: a validated DSH package directory becomes a `.dpk` archive.
 *
 * @module dpk/lib/pack
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  archiveFileName, buildManifest, DPK_FORMAT_VERSION, PACKAGE_PREFIX, REPRODUCIBLE_EPOCH,
} from './dpk-manifest.mjs'
import { validateDshPackage } from './dsh-package.mjs'
import { writeZip } from './zip.mjs'

export { archiveFileName }

/**
 * Validate a package directory and build its archive.
 * @param directory - the package root to pack.
 * @param options - `timestamp` (ISO, overrides the reproducible DOS epoch),
 * `createdAt` (ISO; defaults to the reproducible epoch), `generator` override,
 * `compress: false` to store uncompressed.
 * @returns `{ buffer, manifest, fileName, source }`.
 */
export async function packDirectory(directory, options = {}) {
  const source = await validateDshPackage(directory)
  const manifest = buildManifest({
    name: source.name,
    version: source.version,
    roles: source.roles,
    dsh: source.dsh,
    data: source.dataVolumes,
    engines: source.engines,
    peerDependencies: source.peerDependencies,
    files: source.files,
    // Reproducibility by default: identical input must yield identical bytes.
    createdAt: options.createdAt ?? REPRODUCIBLE_EPOCH,
    ...options.generator === undefined ? {} : { generator: options.generator },
  })

  const entries = [{
    path: 'dpk.json',
    data: Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8'),
    mode: 0o644,
  }]
  for (const file of source.files) {
    entries.push({
      path: `${PACKAGE_PREFIX}${file.path}`,
      data: await readFile(file.absolute),
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
    source,
    format: DPK_FORMAT_VERSION,
    root: resolve(directory),
  }
}
