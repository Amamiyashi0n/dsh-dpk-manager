/**
 * The two data containers — one package or several — read and written by
 * content, not by file name.
 *
 * A data file holds **packages**, each carrying its volumes:
 *
 *   one package      `dpk-config-data/1`  JSON, bytes base64 in the document
 *   several packages `dpks-data/1`        zip, bytes as `data/<pkg>/<…>` entries
 *
 * Which form a file has is a consequence of how many packages it holds, not a
 * property anyone chooses: `dpk pkg` promotes a one-package file to the archive
 * form when a second package is added and demotes it back when one is left. The
 * reader therefore never trusts the name or the declared format alone — it reads
 * a hand-made file that says one thing and holds another (a single-package
 * document listing entries for several packages counts as several), because the
 * alternative is refusing data that is perfectly readable.
 *
 * @module dpk/lib/data-file
 */

import { looksLikeZip, readZipEntry, readZipIndex, writeZip } from './zip.mjs'

/** Format string of a one-package document. */
export const DATA_FORMAT_SINGLE = 'dpk-config-data/1'

/** Format string of a multi-package archive. */
export const DATA_FORMAT_ALL = 'dpks-data/1'

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The entry path an archive gives one carried volume. */
function archivePath(packageName, filePath) {
  return `data/${packageName}/${filePath}`
}

/**
 * Which form a set of packages takes.
 * @param packages - `[{ package, files }]`.
 * @returns `'dpk'` for exactly one package, `'dpks'` for none or several.
 */
export function formOf(packages) {
  return packages.length === 1 ? 'dpk' : 'dpks'
}

/** The file extension each form is written with. */
export function extensionOf(form) {
  return form === 'dpk' ? '.json' : '.dpks'
}

function malformed(message) {
  return new Error(message)
}

/** Read a JSON-document container. `several` also covers a `packages` array. */
function readDocument(payload, where) {
  if (typeof payload !== 'object' || payload === null) throw malformed(`the data file is not an object: ${where}`)

  // A `packages` array is the multi-package shape whatever the format string
  // says; a document that carries one is read as what it holds.
  if (Array.isArray(payload.packages)) {
    return payload.packages.map((carried) => {
      if (typeof carried?.package !== 'string' || carried.package === '') {
        throw malformed('the data file carries an entry with no package name')
      }
      if (!Array.isArray(carried.files)) throw malformed('the data file has no files array')
      return {
        package: carried.package,
        files: carried.files.map(file => readDocumentFile(file, carried.package)),
      }
    })
  }

  if (payload.format === DATA_FORMAT_ALL) throw malformed('the dpks-data file has no packages array')
  if (payload.format !== DATA_FORMAT_SINGLE) {
    throw malformed(`the data file is neither a ${DATA_FORMAT_SINGLE} export nor a ${DATA_FORMAT_ALL} bundle: ${where}`)
  }
  if (typeof payload.package !== 'string' || payload.package === '') {
    throw malformed(`the data file names no package: ${where}`)
  }
  if (!Array.isArray(payload.files)) throw malformed('the data file has no files array')
  // A file entry may name its own package. One document holding entries for
  // more than one package is a hand-made file, and it is still readable: the
  // entry's own name wins over the document's.
  const grouped = new Map()
  for (const file of payload.files) {
    const owner = typeof file?.package === 'string' && file.package !== '' ? file.package : payload.package
    if (!grouped.has(owner)) grouped.set(owner, [])
    grouped.get(owner).push(readDocumentFile(file, owner))
  }
  return [...grouped].map(([name, files]) => ({ package: name, files }))
}

function readDocumentFile(file, owner) {
  if (typeof file?.path !== 'string' || file.path === '') {
    throw malformed('the data file carries a malformed entry')
  }
  if (typeof file.bytes !== 'string') {
    throw malformed(`the data file carries no content for ${owner}/${file.path}`)
  }
  if (!BASE64.test(file.bytes)) throw malformed(`the data file entry ${file.path} is not base64`)
  return { path: file.path, bytes: Buffer.from(file.bytes, 'base64') }
}

/** Read a zip container. */
function readArchive(buffer, where) {
  const index = readZipIndex(buffer)
  const manifest = index.entries.find(entry => entry.path === 'dpks.json')
  if (manifest === undefined) throw malformed('the dpks archive has no dpks.json')
  const volumes = new Map()
  for (const entry of index.entries) {
    if (entry.path === 'dpks.json' || !entry.path.startsWith('data/')) continue
    volumes.set(entry.path, readZipEntry(buffer, entry))
  }
  let payload
  try {
    payload = JSON.parse(readZipEntry(buffer, manifest).toString('utf8'))
  } catch (error) {
    throw malformed(`the dpks manifest is not valid JSON: ${String(error)}`)
  }
  const carried = Array.isArray(payload?.packages)
    ? payload.packages
    : (typeof payload?.package === 'string' ? [{ package: payload.package, files: payload.files }] : undefined)
  if (carried === undefined) throw malformed(`the dpks archive names no package: ${where}`)
  return carried.map((entry) => {
    if (typeof entry?.package !== 'string' || entry.package === '') {
      throw malformed('the data file carries an entry with no package name')
    }
    if (!Array.isArray(entry.files)) throw malformed('the data file has no files array')
    return {
      package: entry.package,
      files: entry.files.map((file) => {
        if (typeof file?.path !== 'string' || file.path === '') throw malformed('the data file carries a malformed entry')
        const bytes = volumes.get(archivePath(entry.package, file.path))
        if (bytes === undefined) throw malformed(`the archive carries no content for ${entry.package}/${file.path}`)
        return { path: file.path, bytes }
      }),
    }
  })
}

/**
 * Read a data file into packages, whatever its name or format string says.
 *
 * @param buffer - the whole file.
 * @param options - `where`: the path, for the error messages.
 * @returns `[{ package, files: [{ path, bytes }] }]`, in file order.
 */
export function readDataFile(buffer, options = {}) {
  const where = options.where ?? 'the data file'
  if (looksLikeZip(buffer)) return readArchive(buffer, where)
  let payload
  try {
    payload = JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    throw malformed(`the data file is not valid JSON(${where}): ${String(error)}`)
  }
  return readDocument(payload, where)
}

/**
 * Serialize packages into the container their count calls for.
 *
 * @param packages - `[{ package, files: [{ path, bytes }] }]`.
 * @param options - `form` (defaults to {@link formOf}), `exportedAt`.
 * @returns `{ form, extension, buffer }`.
 */
export function buildDataFile(packages, options = {}) {
  const form = options.form ?? formOf(packages)
  if (form === 'dpk') {
    const [only] = packages
    if (only === undefined) throw malformed('a one-package data file needs one package')
    const payload = {
      format: DATA_FORMAT_SINGLE,
      package: only.package,
      files: only.files.map(file => ({ path: file.path, bytes: file.bytes.toString('base64') })),
    }
    return { form, extension: extensionOf(form), buffer: Buffer.from(`${JSON.stringify(payload, undefined, 2)}\n`, 'utf8') }
  }

  // The manifest lists paths only; the bytes ride as archive entries, once each.
  const payload = {
    format: DATA_FORMAT_ALL,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    packages: packages.map(carried => ({
      package: carried.package,
      files: carried.files.map(file => ({ path: file.path })),
    })),
  }
  const entries = [{
    path: 'dpks.json',
    data: Buffer.from(`${JSON.stringify(payload, undefined, 2)}\n`, 'utf8'),
    mode: 0o644,
  }]
  for (const carried of packages) {
    for (const file of carried.files) {
      entries.push({ path: archivePath(carried.package, file.path), data: file.bytes, mode: 0o644 })
    }
  }
  return { form, extension: extensionOf(form), buffer: writeZip(entries, { compress: true }) }
}

/** How a carried set of volumes reads in a report, classes named. */
export function countClasses(files) {
  return {
    data: files.filter(file => file.path.startsWith('data/')).length,
    app: files.filter(file => file.path.startsWith('app/')).length,
  }
}
