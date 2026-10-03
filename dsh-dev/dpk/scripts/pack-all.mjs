#!/usr/bin/env node
/**
 * The one way to build every `.dpk` in this workspace.
 *
 * Each package is packed from its own source tree into its own `dist/`. Every
 * package is built and tested first, and no artifact is written unless all of
 * them pass:
 *
 *  1. tests green         — the package's own suite passes, every file of it,
 *  2. no nested archives  — the archive lists no `.dpk` entry at any depth,
 *  3. no build cargo      — no `dist/`, `node_modules/`, or `.git/` entries,
 *  4. byte-reproducible   — packing the same tree twice yields identical bytes.
 *
 * The test gate comes first because a red suite is the one failure that reaches
 * a user as "it installed but it does not work". zcode-provider 2.6.9 shipped
 * with `tests/native-account.mjs` failing — this script only ran `build` — and
 * the `&&` chain in that package's `test` script had also suppressed
 * `tests/standalone-package.mjs`, the offline gate proving the archive activates
 * and serves requests with no ZCode installed. Both gaps are closed: the package
 * runs every test file and reports the whole set, and this script refuses to
 * write an artifact until that set is green.
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

/** The packages this workspace distributes; `build`/`test` mark the npm steps each one has. */
const PACKAGES = [
  { dir: join(root, 'zcode-provider-dpk'), build: true, test: true },
  // reverse-skill's single test wants an absolute path to a skill checkout that
  // the package does not carry, so it cannot gate a distributable.
  { dir: join(root, 'reverse-skill') },
  { dir: join(root, 'dpk-manager'), test: true },
]

/** Run a package's own build script when it has one. */
function runBuild(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (manifest.scripts?.build === undefined) return false
  const run = spawnSync('npm run build', { cwd: dir, stdio: 'inherit', shell: true })
  if (run.status !== 0) throw new Error(`build failed in ${dir} (exit ${String(run.status)})`)
  return true
}

/**
 * Run a package's own test script, reporting rather than throwing so that every
 * package's suite runs and the caller can report the whole set at once.
 * @param dir - package directory.
 * @returns `{ name, skipped }` when the package has no suite, else `{ name, ok, status }`.
 */
function runTests(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (manifest.scripts?.test === undefined) return { name: manifest.name, skipped: true }
  const run = spawnSync('npm test', { cwd: dir, stdio: 'inherit', shell: true })
  return { name: manifest.name, ok: run.status === 0, status: run.status }
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

// Build every package, then gate on the whole test set, then pack. Nothing
// reaches dist/ until the set is known to be green.
const built = new Set()
for (const pkg of PACKAGES) {
  if (runBuild(pkg.dir)) built.add(pkg.dir)
}

const results = PACKAGES.filter(pkg => pkg.test === true).map(pkg => ({ dir: pkg.dir, ...runTests(pkg.dir) }))
const failed = results.filter(result => result.skipped !== true && result.ok !== true)
for (const result of results) {
  if (result.skipped === true) console.log(`tests   ${result.name}: no test script, skipped`)
}
if (failed.length > 0) {
  throw new Error(
    'tests failed; no artifact was written: '
    + failed.map(result => `${result.name} (exit ${String(result.status)})`).join(', '),
  )
}
console.log(`tests   ${results.filter(result => result.skipped !== true).length} package suite(s) green`)
// A package with no suite is not "tested": say only what actually ran.
const tested = new Set(results.filter(result => result.skipped !== true).map(result => result.dir))

for (const pkg of PACKAGES) {
  const packed = await packDirectory(pkg.dir)

  // Check 4 before anything touches dist/: the same tree must pack identically.
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
    + `  ${[built.has(pkg.dir) ? 'built' : null, tested.has(pkg.dir) ? 'tested' : null, 'clean', 'reproducible'].filter(Boolean).join(' + ')}`,
  )
}
console.log('pack-all: every artifact is tested, clean, complete, and byte-reproducible.')
