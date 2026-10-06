/**
 * Write a profile directly, the way the official installer's end state looks.
 *
 * The dpk import used to hand every install to the official plugin manager,
 * which runs pnpm in the profile. pnpm is only *transport*: what the Harness
 * loader actually reads at boot is three things, and this module writes exactly
 * those (plus the lockfile row pnpm would have written, so a later official
 * operation stays a no-op):
 *
 *  1. `<profile>/package.json` → `dependencies[<name>] = link:<store dir>` and,
 *     for a package that declares `dsh.bundle.patch`, the name appended to
 *     `dsh.profile.bundles` (the loader's layer order),
 *  2. `<profile>/node_modules/<name>` → a link to the same store directory
 *     (`resolveBundleDir` resolves the bundle through ordinary Node resolution),
 *  3. `<profile>/pnpm-lock.yaml` → the importer row for that dependency.
 *
 * Everything that is pnpm's own bookkeeping and nothing the loader reads
 * (`node_modules/.modules.yaml`, `.pnpm-workspace-state-v1.json`, the virtual
 * store) is left untouched: pnpm reconciles those itself the next time it runs.
 *
 * @module dpk/lib/profile-install
 */

import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, basename, win32 } from 'node:path'
import { cacheDir, pruneCache, stageIn } from './staging.mjs'
import { dpkRoot } from './store.mjs'

/** A profile that could not be written as asked. */
export class DpkProfileError extends Error {
  constructor(message, code = 'DPK_PROFILE_FAILED', detail = {}) {
    super(message)
    this.name = 'DpkProfileError'
    this.code = code
    this.detail = detail
  }
}

/** `<home>/profiles/<profile>`. */
export function profileDir(home, profile) {
  if (typeof home !== 'string' || home === '') throw new DpkProfileError('a DSH home is required', 'DPK_PROFILE_INVALID')
  if (typeof profile !== 'string' || profile === '' || profile === '.' || profile === '..'
    || profile.includes('/') || profile.includes('\\') || profile.includes('\0')
    || isAbsolute(profile) || win32.isAbsolute(profile) || /^[A-Za-z]:/u.test(profile)) {
    throw new DpkProfileError('the profile name must be one directory name', 'DPK_PROFILE_INVALID')
  }
  return join(resolve(home), 'profiles', profile)
}

/** The dependency specifier a profile keeps for one store directory. */
export function linkSpecifier(packageDir) {
  return `link:${toPosix(resolve(packageDir))}`
}

/** Forward slashes, which is what pnpm writes into a `link:` specifier. */
function toPosix(value) {
  return value.replace(/\\/g, '/')
}

/** Read one package.json; `undefined` when it is missing or unreadable. */
async function readManifestOf(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch (_missingOrInvalid) {
    return undefined
  }
}

/**
 * Read one profile manifest without letting a bad file hide the profile.
 *
 * A manifest that cannot be *read* is one thing; one that cannot be *parsed* is
 * another; one that is simply not there is a third. The first may be a transient
 * lock, the second a hand-edit, and the caller has to tell them apart because the
 * profile's `node_modules` links say which store copies it resolves regardless.
 *
 * @param path - the profile's package.json.
 * @returns `{ manifest }` when it parsed, `{}` when it was present but unusable,
 * `{ missing: true }` when it is not there, `{ error }` when it could not be
 * read for any other reason.
 */
async function readProfileManifestTolerant(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return error?.code === 'ENOENT' ? { missing: true } : { error }
  }
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? { manifest: parsed } : {}
  } catch (_invalid) {
    return {}
  }
}

/** The digest a store path names, or undefined when it names something else. */
function digestOfStorePath(target, storePrefix) {
  if (!target.startsWith(storePrefix)) return undefined
  const digest = target.slice(storePrefix.length).split('/')[0]
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined
}

/**
 * The store copies a profile's `node_modules` links resolve, read from the
 * filesystem rather than from its manifest.
 *
 * This is the second, stricter answer to "is this digest in use": a link's
 * target is a fact about the profile directory, and resolving it needs no JSON
 * at all. So a manifest that was corrupted, hand-edited or locked mid-write can
 * no longer make a copy that the profile loads look like garbage — which is
 * exactly the case where a collector must not guess.
 *
 * @param profileDir - the profile directory.
 * @param storePrefix - the posix `<root>/store/` prefix.
 * @returns `{ links }` (possibly empty) or `{ error }` when the directory could
 * not be listed at all.
 */
async function linkedPackages(profileDir, storePrefix) {
  const modules = join(profileDir, 'node_modules')
  let entries
  try {
    entries = await readdir(modules, { withFileTypes: true })
  } catch (error) {
    // No node_modules (or not a directory) means no links, which is different
    // from "could not find out".
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { links: [] } : { error }
  }
  const links = []
  let scopeError
  const consider = async (linkPath, name) => {
    try {
      const digest = digestOfStorePath(toPosix(await realpath(linkPath)), storePrefix)
      if (digest !== undefined) links.push({ name, digest })
    } catch (_brokenLink) {
      // A link that does not resolve references nothing.
    }
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('@')) {
      let scoped
      try {
        scoped = await readdir(join(modules, entry.name), { withFileTypes: true })
      } catch (error) {
        scopeError = error
        continue
      }
      for (const inner of scoped) await consider(join(modules, entry.name, inner.name), `${entry.name}/${inner.name}`)
      continue
    }
    await consider(join(modules, entry.name), entry.name)
  }
  return scopeError === undefined ? { links } : { links, error: scopeError }
}

/**
 * Read the profile manifest.
 * @param dir - the profile directory.
 * @returns the parsed manifest.
 * @throws {DpkProfileError} when the profile has no readable package.json.
 */
export async function readProfileManifest(dir) {
  const manifest = await readManifestOf(join(dir, 'package.json'))
  if (manifest === undefined) throw new DpkProfileError(`no readable package.json in ${dir}`, 'DPK_PROFILE_UNREADABLE', { dir })
  return manifest
}

/**
 * Write the profile manifest: temp file in the dpk cache, then rename over the
 * target, so a crash cannot truncate it.
 *
 * @param dir - the profile directory.
 * @param manifest - the manifest to publish.
 * @param home - the DSH home, whose `dpk/cache` holds the staging file.
 */
async function writeProfileManifest(dir, manifest, home) {
  const target = join(dir, 'package.json')
  const cache = cacheDir(dpkRoot(home))
  const staging = await stageIn(cache, `manifest-${basename(dir)}`, 'dpk')
  await writeFile(staging, `${JSON.stringify(manifest, undefined, 2)}\n`)
  try {
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { force: true })
    await pruneCache(cache)
    throw error
  }
  await pruneCache(cache)
}

/** Whether the package contributes a profile layer (`dsh.bundle.patch`). */
export async function isBundlePackage(packageDir) {
  const manifest = await readManifestOf(join(packageDir, 'package.json'))
  const patch = manifest?.dsh?.bundle?.patch
  return (typeof patch === 'string' && patch.trim() !== '')
    || (Array.isArray(patch) && patch.length > 0 && patch.every(entry => typeof entry === 'string' && entry.trim() !== ''))
}

/** Rewrite `dependencies` with keys in pnpm's order, keeping every value. */
function sortDependencies(manifest) {
  const dependencies = manifest.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return manifest
  const sorted = {}
  for (const name of Object.keys(dependencies).sort()) sorted[name] = dependencies[name]
  return { ...manifest, dependencies: sorted }
}

/**
 * Whether `<home>/profiles/<profile>` already holds this exact package.
 *
 * Read from the same three things the loader reads, so a positive answer means
 * "there is nothing left to do": the dependency row resolves into this store
 * directory, the package is listed in `dsh.profile.bundles` when it is a bundle,
 * and `node_modules/<name>` really points at that directory.
 *
 * @param options - `{ home, profile, packageName, packageDir, bundle }`.
 * @returns `{ installed, reasons }`; `reasons` names every disagreement.
 */
export async function installedState(options) {
  const dir = profileDir(options.home, options.profile)
  const normalize = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const want = normalize(options.packageDir)
  const reasons = []
  const manifest = await readManifestOf(join(dir, 'package.json'))
  if (manifest === undefined) return { installed: false, reasons: [`no readable package.json in ${dir}`] }

  const dependency = manifest.dependencies?.[options.packageName]
  const row = normalize(String(dependency ?? '').replace(/^link:/i, ''))
  if (row !== want) reasons.push(`dependency row is ${JSON.stringify(dependency ?? null)}, not ${linkSpecifier(options.packageDir)}`)

  if (await isBundlePackage(options.packageDir)) {
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    if (!bundles.includes(options.packageName)) reasons.push(`${options.packageName} is not in dsh.profile.bundles`)
  }

  try {
    const linked = normalize(await realpath(join(dir, 'node_modules', options.packageName)))
    const target = normalize(await realpath(options.packageDir))
    if (linked !== target) reasons.push(`node_modules/${options.packageName} resolves to ${linked}, not ${target}`)
  } catch (error) {
    reasons.push(`node_modules/${options.packageName} is not linked: ${String(error instanceof Error ? error.message : error)}`)
  }
  return { installed: reasons.length === 0, reasons }
}

/**
 * Point `node_modules/<name>` at a store directory.
 *
 * Refuses to replace anything that is not a link this manager could have made:
 * a real directory there is somebody else's installation, and silently deleting
 * it would be worse than failing.
 *
 * @param options - `{ profileDir, packageName, packageDir }`.
 * @returns `{ linkPath, changed }`.
 */
export async function ensurePackageLink(options) {
  const linkPath = join(options.profileDir, 'node_modules', ...options.packageName.split('/'))
  const target = resolve(options.packageDir)
  let existing
  try {
    existing = await lstat(linkPath)
  } catch (_missing) {
    existing = undefined
  }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new DpkProfileError(
        `${linkPath} exists and is not a link; refusing to replace it`,
        'DPK_PROFILE_LINK_CONFLICT',
        { linkPath },
      )
    }
    const current = await realpath(linkPath).catch(() => undefined)
    if (current !== undefined && resolve(current) === target) return { linkPath, changed: false }
    await rm(linkPath, { recursive: true, force: true })
  }
  await mkdir(dirname(linkPath), { recursive: true })
  // 'junction' is what Windows needs for a directory link and is ignored elsewhere.
  await symlink(target, linkPath, 'junction')
  return { linkPath, changed: true }
}

/** Remove `node_modules/<name>` when it is a link; leave anything else alone. */
async function removePackageLink(options) {
  const linkPath = join(options.profileDir, 'node_modules', ...options.packageName.split('/'))
  try {
    const existing = await lstat(linkPath)
    if (!existing.isSymbolicLink()) return { linkPath, changed: false }
    await rm(linkPath, { recursive: true, force: true })
    return { linkPath, changed: true }
  } catch (_missing) {
    return { linkPath, changed: false }
  }
}

/** Quote a YAML key the way pnpm writes dependency names. */
function yamlKey(name) {
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : `'${name}'`
}

/**
 * Add, update or drop one importer row in a `pnpm-lock.yaml` text.
 *
 * Line-oriented on purpose: the file is generated by pnpm, dpk only needs the
 * one row for the dependency it just placed, and a shape this function does not
 * recognise must be left byte-for-byte alone rather than patched blind.
 *
 * @param text - the current lockfile.
 * @param entry - `{ name, specifier, version }`, or `{ name, remove: true }`.
 * @returns the new text, or `undefined` when the shape was not recognised.
 */
export function patchLockfileImporter(text, entry) {
  const lines = text.split('\n')
  let importerAt = -1
  let importerIndent = ''
  for (let index = 0; index < lines.length; index += 1) {
    const block = /^(\s*)\.:\s*$/.exec(lines[index])
    if (block !== null) {
      importerAt = index
      importerIndent = block[1]
      break
    }
    // pnpm writes an empty importer inline; anything else means the first
    // dependency is about to be added, so the block has to be opened up.
    const inline = /^(\s*)\.:\s*\{\s*\}\s*$/.exec(lines[index])
    if (inline !== null) {
      importerAt = index
      importerIndent = inline[1]
      lines[index] = `${importerIndent}.:`
      break
    }
  }
  if (importerAt === -1) return undefined
  const dependenciesIndent = `${importerIndent}  `
  let sectionAt = -1
  for (let index = importerAt + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (indentOf(line) <= importerIndent.length) break
    if (indentOf(line) === dependenciesIndent.length && line.trim() === 'dependencies:') {
      sectionAt = index
      break
    }
  }
  const entryIndent = `${dependenciesIndent}  `
  const fieldIndent = `${entryIndent}  `
  const quoted = yamlKey(entry.name)
  const start = sectionAt === -1 ? undefined : findEntryLine(lines, sectionAt, entryIndent, quoted)

  if (entry.remove === true) {
    if (start === undefined) return text
    lines.splice(start, entryEnd(lines, start, entryIndent) - start)
    return lines.join('\n')
  }

  const block = [`${entryIndent}${quoted}:`, `${fieldIndent}specifier: ${entry.specifier}`, `${fieldIndent}version: ${entry.version}`]
  if (start !== undefined) {
    lines.splice(start, entryEnd(lines, start, entryIndent) - start, ...block)
    return lines.join('\n')
  }
  if (sectionAt !== -1) {
    let insertAt = sectionAt + 1
    while (insertAt < lines.length) {
      const line = lines[insertAt]
      if (line.trim() === '') break
      if (indentOf(line) <= dependenciesIndent.length) break
      const name = entryNameAt(line, entryIndent)
      if (name !== undefined && name.localeCompare(entry.name) > 0) break
      insertAt += 1
    }
    lines.splice(insertAt, 0, ...block)
    return lines.join('\n')
  }
  // No dependencies block yet: create one right under the importer.
  lines.splice(importerAt + 1, 0, `${dependenciesIndent}dependencies:`, ...block)
  return lines.join('\n')
}

/** The index just past one entry's own lines (a blank line already ends it). */
function entryEnd(lines, start, entryIndent) {
  let end = start + 1
  while (end < lines.length) {
    if (lines[end].trim() === '') break
    if (indentOf(lines[end]) <= entryIndent.length) break
    end += 1
  }
  return end
}

/** The line index of one dependency key inside a dependencies block. */
function findEntryLine(lines, sectionAt, entryIndent, quoted) {
  for (let index = sectionAt + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (indentOf(line) < entryIndent.length) return undefined
    if (entryNameAt(line, entryIndent) === quoted) return index
  }
  return undefined
}

/** The dependency key a line declares, or `undefined` for anything else. */
function entryNameAt(line, entryIndent) {
  const matched = new RegExp(`^${entryIndent}(.+):\\s*$`).exec(line)
  return matched === null ? undefined : matched[1]
}

/** The leading-space count of one line. */
function indentOf(line) {
  return /^(\s*)/.exec(line)[1].length
}

/**
 * Install one package into a profile without pnpm.
 *
 * @param options - `{ home, profile, packageName, packageDir }`.
 * @returns `{ changed, linkPath, bundlesChanged, lockfile }`, where `lockfile`
 * is `'updated'`, `'unchanged'`, `'absent'` (no lockfile to keep in step) or
 * `'unrecognised'` (a shape this module will not patch).
 */
export async function applyProfileInstall(options) {
  const dir = profileDir(options.home, options.profile)
  if (!existsSync(join(dir, 'package.json'))) {
    throw new DpkProfileError(`the profile ${options.profile} has no package.json at ${dir}`, 'DPK_PROFILE_UNREADABLE', { dir })
  }
  const manifest = await readProfileManifest(dir)
  const specifier = linkSpecifier(options.packageDir)
  const previousRow = manifest.dependencies?.[options.packageName]
  const dependencies = { ...manifest.dependencies, [options.packageName]: specifier }
  let next = sortDependencies({ ...manifest, dependencies })

  let bundlesChanged = false
  const previousBundles = Array.isArray(next.dsh?.profile?.bundles) ? next.dsh.profile.bundles : []
  if (await isBundlePackage(options.packageDir)) {
    if (!previousBundles.includes(options.packageName)) {
      next = { ...next, dsh: { ...next.dsh, profile: { ...next.dsh?.profile, bundles: [...previousBundles, options.packageName] } } }
      bundlesChanged = true
    }
  } else if (previousBundles.includes(options.packageName)) {
    next = { ...next, dsh: { ...next.dsh, profile: { ...next.dsh?.profile, bundles: previousBundles.filter(name => name !== options.packageName) } } }
    bundlesChanged = true
  }

  const manifestChanged = previousRow !== specifier || bundlesChanged
  const transaction = await captureProfileTransaction(dir, options.packageName)
  let link
  let lockfile
  try {
    // Link first, dependency row second. The loader reads the row first, but
    // every mutation is covered by the transaction so an upgrade failure can
    // restore the old link and manifest instead of leaving a broken profile.
    link = await ensurePackageLink({ profileDir: dir, packageName: options.packageName, packageDir: options.packageDir })
    if (manifestChanged) await writeProfileManifest(dir, next, options.home)
    lockfile = await updateLockfile(dir, {
      name: options.packageName,
      specifier,
      version: `link:${toPosix(relative(dir, resolve(options.packageDir)))}`,
    })
  } catch (error) {
    await transaction.restore()
    throw error
  }
  if (options.transaction !== undefined) options.transaction.rollback = transaction.restore
  return {
    changed: manifestChanged || link.changed || lockfile === 'updated',
    linkPath: link.linkPath,
    bundlesChanged,
    lockfile,
  }
}

/**
 * Remove one package from a profile without pnpm.
 * @param options - `{ home, profile, packageName }`.
 * @returns `{ changed, bundlesChanged, lockfile }`.
 */
export async function applyProfileRemove(options) {
  const dir = profileDir(options.home, options.profile)
  const manifest = await readProfileManifest(dir)
  const transaction = await captureProfileTransaction(dir, options.packageName)
  const dependencies = { ...manifest.dependencies }
  const removedDependency = Object.hasOwn(dependencies, options.packageName)
  delete dependencies[options.packageName]
  const previous = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const bundles = previous.filter((name) => name !== options.packageName)
  const next = { ...manifest, dependencies }
  if (bundles.length !== previous.length) next.dsh = { ...next.dsh, profile: { ...next.dsh?.profile, bundles } }
  let link
  let lockfile
  try {
    if (removedDependency || bundles.length !== previous.length) await writeProfileManifest(dir, next, options.home)
    link = await removePackageLink({ profileDir: dir, packageName: options.packageName })
    lockfile = await updateLockfile(dir, { name: options.packageName, remove: true })
  } catch (error) {
    await transaction.restore()
    throw error
  }
  if (options.transaction !== undefined) options.transaction.rollback = transaction.restore
  return {
    changed: removedDependency || bundles.length !== previous.length || link.changed || lockfile === 'updated',
    bundlesChanged: bundles.length !== previous.length,
    lockfile,
  }
}

/** Capture the profile files and package link touched by one operation. */
async function captureProfileTransaction(dir, packageName) {
  const manifest = await captureFile(join(dir, 'package.json'))
  const lockfile = await captureFile(join(dir, 'pnpm-lock.yaml'))
  const linkPath = join(dir, 'node_modules', ...packageName.split('/'))
  let link
  try {
    const info = await lstat(linkPath)
    if (!info.isSymbolicLink()) throw new DpkProfileError(`${linkPath} exists and is not a link`, 'DPK_PROFILE_LINK_CONFLICT', { linkPath })
    link = { path: linkPath, target: await readlink(linkPath) }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  let restored = false
  return {
    async restore() {
      if (restored) return
      restored = true
      await restoreFile(join(dir, 'package.json'), manifest)
      await restoreFile(join(dir, 'pnpm-lock.yaml'), lockfile)
      await rm(linkPath, { recursive: true, force: true })
      if (link !== undefined) {
        await mkdir(dirname(linkPath), { recursive: true })
        await symlink(link.target, linkPath, 'junction')
      }
    },
  }
}

async function captureFile(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new DpkProfileError(`${path} is not a regular file`, 'DPK_PROFILE_FILE_CONFLICT', { path })
    return { exists: true, bytes: await readFile(path) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    throw error
  }
}

async function restoreFile(path, snapshot) {
  if (!snapshot.exists) {
    await rm(path, { force: true })
    return
  }
  await writeFile(path, snapshot.bytes)
}

/**
 * The registry-spec dependency rows across every profile: the packages the
 * official Plugins page installed (`name: ^version` — no `link:`, no digest).
 *
 * dpk did not install these, but they live in the profiles dpk manages, and
 * `update`/`upgrade` are asked about them too: their upstream is the npm
 * registry, so these rows are what tells dpk they exist and what range the
 * profile asked for.
 *
 * @param options - `{ home }`.
 * @returns `{ profiles, rows }` with rows as `{ profile, name, range }`.
 */
export async function registryRows(options) {
  const base = join(resolve(options.home), 'profiles')
  const rows = []
  const profiles = []
  let names = []
  try {
    names = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (_noProfiles) {
    return { profiles, rows }
  }
  for (const name of names.sort()) {
    const manifest = await readManifestOf(join(base, name, 'package.json'))
    if (manifest === undefined) continue
    profiles.push(name)
    const dependencies = manifest.dependencies
    if (dependencies === null || typeof dependencies !== 'object') continue
    for (const [dependency, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== 'string' || /^(?:link|file):/i.test(specifier)) continue
      rows.push({ profile: name, name: dependency, range: specifier })
    }
  }
  return { profiles, rows }
}

/**
 * The version of a package as a profile actually has it: read from the
 * profile's own `node_modules/<name>/package.json`, which is what the loader
 * resolves — the authority for "what is running", whether dpk or the official
 * page put it there.
 *
 * @returns the version string, or null when it is not installed/resolvable.
 */
export async function installedProfileVersion(options) {
  try {
    const manifest = JSON.parse(await readFile(join(options.profileDir, 'node_modules', ...options.name.split('/'), 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch (_unreadable) {
    return null
  }
}

/**
 * Which store digests the profiles of this DSH home actually resolve.
 *
 * This is the single answer to "is this digest in use", and it reads the two
 * filesystem facts the Harness itself uses, not one:
 *
 *  1. the profile manifest's `link:` dependency rows, and
 *  2. the `node_modules/<name>` links, resolved through `realpath`.
 *
 * The second is what makes collection safe against a manifest that cannot be
 * parsed: a hand-edited or half-written `package.json` no longer hides the
 * copies the profile loads. A profile counts as unexamined when its links
 * cannot be listed for a reason other than "not there"; collectors then defer
 * deletion rather than guessing.
 *
 * @param options - `{ home, root }` (`root` = the dpk root holding `store/`).
 * @returns `{ profiles, references, rows, unreadable }`: every profile name
 * that could be examined at all; a `Map<digest, string[]>` of the profiles
 * resolving each digest; those same facts as `{ profile, name, digest }` rows,
 * de-duplicated across both sources; and the names of profile directories that
 * could not be examined.
 */
export async function referencedDigests(options) {
  const base = join(resolve(options.home), 'profiles')
  const storePrefix = `${toPosix(join(resolve(options.root), 'store'))}/`
  const references = new Map()
  const rows = []
  const seen = new Set()
  const profiles = []
  const unreadable = []
  const add = (profile, name, digest) => {
    const key = `${profile}\0${name}\0${digest}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push({ profile, name, digest })
    const users = references.get(digest)
    if (users === undefined) references.set(digest, [profile])
    else if (!users.includes(profile)) users.push(profile)
  }
  let names = []
  try {
    names = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if (error?.code === 'ENOENT') return { profiles, references, rows, unreadable }
    unreadable.push(base)
    return { profiles, references, rows, unreadable }
  }
  for (const name of names.sort()) {
    const profileDir = join(base, name)
    const read = await readProfileManifestTolerant(join(profileDir, 'package.json'))
    const linked = await linkedPackages(profileDir, storePrefix)
    // The links are the authority: they are the filesystem fact the Harness
    // resolves, so once they are known the profile's references are known too —
    // a manifest that could not be read only costs us the dependency *names*.
    const linksKnown = linked.error === undefined
    const hasManifest = read.missing !== true
    const links = linked.links ?? []
    // A directory with neither a manifest nor a store link is not a profile
    // (an empty leftover, someone else's folder); anything we could not examine
    // stays in the picture instead of being silently written off.
    if (!hasManifest && links.length === 0 && linksKnown) continue
    profiles.push(name)
    if (!linksKnown) unreadable.push(name)
    const dependencies = read.manifest?.dependencies
    if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
      for (const [dependency, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== 'string' || !/^link:/i.test(specifier)) continue
        const digest = digestOfStorePath(toPosix(resolve(String(specifier).replace(/^link:/i, ''))), storePrefix)
        if (digest !== undefined) add(name, dependency, digest)
      }
    }
    for (const link of links) add(name, link.name, link.digest)
  }
  return { profiles, references, rows, unreadable }
}

/** Apply one row change to `<profile>/pnpm-lock.yaml` when pnpm's shape allows it. */
async function updateLockfile(dir, entry) {
  const path = join(dir, 'pnpm-lock.yaml')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (_missing) {
    return 'absent'
  }
  const patched = patchLockfileImporter(text, entry)
  if (patched === undefined) return 'unrecognised'
  if (patched === text) return 'unchanged'
  await writeFile(path, patched)
  return 'updated'
}
