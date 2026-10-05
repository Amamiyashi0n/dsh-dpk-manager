/** Shared fixtures for the dpk test suite. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A minimal but complete bundle package, with hooks for breaking it deliberately. */
export async function makePackage(options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dpk-pkg-'))
  const manifest = {
    name: '@local/dpk-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    description: 'DPK conformance fixture',
    exports: {
      '.': './index.js',
      './package.json': './package.json',
      './locale/*.json': './locale/*.json',
    },
    icon: './icon.svg',
    dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } },
    ...options.manifest,
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (value === undefined) delete manifest[key]
  }
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  await writeFile(join(root, 'index.js'), 'export function apply() {}\n')
  await writeFile(join(root, 'cordis.patch.yml'), "- insert:\n    - id: dpk-fixture\n      name: '@local/dpk-fixture'\n")
  await writeFile(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n')
  await mkdir(join(root, 'locale'), { recursive: true })
  await writeFile(join(root, 'locale', 'en.json'), `${JSON.stringify({ meta: { title: 'DPK Fixture', description: 'A fixture' } })}\n`)
  for (const [relative, content] of Object.entries(options.extraFiles ?? {})) {
    const path = join(root, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  return root
}

/** A scratch DSH home for store tests. */
export async function makeHome() {
  return mkdtemp(join(tmpdir(), 'dpk-home-'))
}

/** Flip one byte inside a buffer copy. */
export function flipByte(buffer, offset) {
  const copy = Buffer.from(buffer)
  copy[offset] = copy[offset] ^ 0xff
  return copy
}

/**
 * One store entry holding a readable package.json, so a digest looks placed.
 * @param root - dpk root.
 * @param digest - the store digest to create.
 * @param options - `{ name, manifest, files, legacyManifest }`; `manifest`
 * replaces the whole package.json (for a package that declares volumes).
 * @returns the `<root>/store/<digest>/package` directory.
 */
export async function storeEntry(root, digest, options = {}) {
  const packageDir = join(root, 'store', digest, 'package')
  await mkdir(packageDir, { recursive: true })
  const manifest = options.manifest ?? { name: options.name ?? '@local/x', version: '1.0.0' }
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify(manifest)}\n`)
  await writeFile(join(packageDir, 'index.js'), 'export const x = 1\n')
  if (options.legacyManifest === true) await writeFile(join(root, 'store', digest, 'dpk.json'), '{}\n')
  return packageDir
}

/**
 * Files under `root` that are byte-identical to the archive with this digest —
 * i.e. copies of the `.dpk` dpk consumed. Empty means dpk kept none, whatever
 * else the directory happens to contain.
 */
export async function archiveCopies(root, digest, prefix = '') {
  return (await dpkOwnedFiles(root, prefix)).filter(entry => entry.digest === digest).map(entry => entry.path)
}

/** Every file under `root` as `{ path, digest }`, for copy detection. */
async function dpkOwnedFiles(directory, prefix = '') {
  const { createHash } = await import('node:crypto')
  const { readdir, readFile } = await import('node:fs/promises')
  const found = []
  let names
  try {
    names = await readdir(directory, { withFileTypes: true })
  } catch (_absent) {
    return found
  }
  for (const entry of names) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await dpkOwnedFiles(path, relative))
    else if (entry.isFile()) {
      found.push({ path: relative, digest: createHash('sha256').update(await readFile(path)).digest('hex') })
    }
  }
  return found
}

/**
 * A profile whose dependency rows point into the store. `dependencies` maps a
 * dependency name to the package directory it links to. For a registry-style
 * row pass the bare spec as a string: `{ official: '^1.0.0' }` — only values
 * that name a directory are turned into `link:` rows.
 */
export async function profileUsing(home, profile, dependencies = {}) {
  const dir = join(home, 'profiles', profile)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, target]) => [
      name,
      typeof target === 'string' && !target.startsWith('^') && !target.startsWith('~') && target !== 'latest'
        ? `link:${target}`
        : target,
    ])),
    dsh: { profile: { bundles: [] } },
  }, undefined, 2)}\n`)
  return dir
}

/**
 * Every file under a directory as `relative/path: sha256`, plus directories as
 * `relative/path/`. Two snapshots being equal means nothing was created,
 * removed or modified in between — the decisive way to assert that an operation
 * is read-only, without guessing which paths it might have touched.
 */
export async function snapshot(directory, prefix = '') {
  const { createHash } = await import('node:crypto')
  const { readdir, readFile } = await import('node:fs/promises')
  const entries = {}
  let names
  try {
    names = await readdir(directory, { withFileTypes: true })
  } catch (_absent) {
    return entries
  }
  for (const entry of names.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      entries[`${relative}/`] = null
      Object.assign(entries, await snapshot(path, relative))
    } else if (entry.isFile()) {
      entries[relative] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  return entries
}
