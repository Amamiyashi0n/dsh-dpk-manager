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
