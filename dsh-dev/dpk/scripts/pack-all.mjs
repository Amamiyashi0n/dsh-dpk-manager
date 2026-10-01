#!/usr/bin/env node
/**
 * The one way to build every `.dpk` in this workspace.
 *
 * Each package is packed from its own source tree into its own `dist/`, and
 * every artifact passes three self-checks before the script reports success:
 *
 *  1. no nested archives  — the archive lists no `.dpk` entry at any depth,
 *  2. no build cargo      — no `dist/`, `node_modules/`, or `.git/` entries,
 *  3. byte-reproducible   — packing the same tree twice yields identical bytes.
 *
 * The nested-archive incident (zcode-provider 2.5.35–2.5.38 swept every
 * previous archive into each new build) happened because build outputs lived
 * inside the packed tree and nothing refused them. The packer now rejects any
 * `.dpk` inside a package outright, and this script is the front door that
 * keeps every distributable on the clean path.
 *
 * Usage:  node scripts/pack-all.mjs
 * Output: <package>/dist/<name>-<version>.dpk  (plus a summary on stdout)
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NEVER_PACKED } from '../dpk-manager/lib/dsh-package.mjs'
import { packDirectory } from '../dpk-manager/lib/pack.mjs'
import { verifyArchive } from '../dpk-manager/lib/verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** The packages this workspace distributes; `build` marks the npm build step. */
const PACKAGES = [
  { dir: join(root, 'zcode-provider-dpk'), build: true },
  { dir: join(root, 'reverse-skill') },
  { dir: join(root, 'dpk-manager') },
]

/** Run a package's own build script when it has one. */
function runBuild(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (manifest.scripts?.build === undefined) return false
  const run = spawnSync('npm run build', { cwd: dir, stdio: 'inherit', shell: true })
  if (run.status !== 0) throw new Error(`build failed in ${dir} (exit ${String(run.status)})`)
  return true
}

/** Assert the artifact carries nothing an archive may not carry. */
function assertClean(manifest) {
  for (const file of manifest.files) {
    if (file.path.toLowerCase().endsWith('.dpk')) {
      throw new Error(`nested archive in the artifact: ${file.path}`)
    }
    const segment = file.path.replace(/^package\//, '').split('/')[0]
    if (NEVER_PACKED.has(segment)) {
      throw new Error(`build cargo in the artifact: ${file.path}`)
    }
  }
}

for (const pkg of PACKAGES) {
  const built = pkg.build === true ? runBuild(pkg.dir) : false
  const packed = await packDirectory(pkg.dir)

  // Check 3 before anything touches dist/: the same tree must pack identically.
  const second = await packDirectory(pkg.dir)
  if (!second.buffer.equals(packed.buffer)) {
    throw new Error(`${packed.manifest.name}: repacking changed the bytes`)
  }
  await verifyArchive(packed.buffer, { deep: true })
  assertClean(packed.manifest)

  const dist = join(pkg.dir, 'dist')
  // The shipped file name keeps the scope out of the path: the package name
  // minus its scope, e.g. @local/zcode-provider -> zcode-provider-2.5.42.dpk.
  const fileName = `${packed.manifest.name.replace(/^@[^/]+\//u, '')}-${packed.manifest.version}.dpk`
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  await writeFile(join(dist, fileName), packed.buffer)

  console.log(
    `packed  ${packed.manifest.name}@${packed.manifest.version}`
    + `  ${(packed.buffer.length / 1024).toFixed(1)} KB`
    + `  ${packed.manifest.files.length} files`
    + `  digest ${packed.manifest.integrity.digest.slice(0, 12)}…`
    + `  ${[built ? 'built' : null, 'clean', 'reproducible'].filter(Boolean).join(' + ')}`,
  )
}
console.log('pack-all: every artifact is clean, complete, and byte-reproducible.')
