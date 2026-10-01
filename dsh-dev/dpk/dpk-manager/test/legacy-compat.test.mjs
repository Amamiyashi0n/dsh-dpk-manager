/**
 * Legacy-archive compatibility: archives written before the @local scope
 * convention and before `dist/` was excluded from packing must still verify.
 * Their dpk.json carries an unscoped name and lists the nested archives the
 * dist/ directory used to hold; the modern scanner localizes names and skips
 * never-packed directories, so the comparison must read both sides through
 * the same normalization instead of flagging the archive as self-contradictory.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareManifestToPackage } from '../lib/dpk-manifest.mjs'
import { validateDshPackage } from '../lib/dsh-package.mjs'
import { makePackage } from './helpers.mjs'

/** Facts of an unscoped fixture that also carries a stale dist/ archive. */
async function legacyFixture() {
  const root = await makePackage({
    manifest: { name: 'plain-tool' },
    extraFiles: { 'dist/plain-tool-0.9.0.dpk': 'stale nested archive bytes' },
  })
  return validateDshPackage(root)
}

test('a legacy archive is consistent: unscoped name and carried dist files verify clean', async () => {
  const facts = await legacyFixture()
  const files = facts.files.map(file => ({ path: `package/${file.path}`, size: file.size, sha256: file.sha256 }))
  files.push({ path: 'package/dist/plain-tool-0.9.0.dpk', size: 27, sha256: 'f'.repeat(64) })
  const legacyManifest = {
    name: 'plain-tool',
    version: facts.version,
    roles: [...facts.roles],
    dsh: facts.dsh,
    files,
  }
  assert.deepEqual(compareManifestToPackage(legacyManifest, facts), [])
})

test('the comparison still catches a real mismatch', async () => {
  const facts = await legacyFixture()
  const files = facts.files.map(file => ({ path: `package/${file.path}`, size: file.size, sha256: file.sha256 }))
  const manifest = {
    name: 'plain-tool',
    version: facts.version,
    roles: [...facts.roles],
    dsh: facts.dsh,
    files: [...files, { path: 'package/lib/absent.js', size: 1, sha256: 'a'.repeat(64) }],
  }
  const problems = compareManifestToPackage(manifest, facts)
  assert.ok(problems.some(problem => problem.includes('absent.js')), problems.join('\n'))
  const renamed = { ...manifest, name: '@local/other' }
  assert.ok(compareManifestToPackage(renamed, facts).some(problem => problem.startsWith('name:')), 'a genuinely different name still fails')
})

test('importing a legacy archive stores the package alone, without its carried archives', async () => {
  const { readFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { installArchive } = await import('../lib/install.mjs')
  const { dpkRoot, readIndex } = await import('../lib/store.mjs')
  const { sha256 } = await import('../lib/dsh-package.mjs')
  const { computeIntegrity, sortFiles } = await import('../lib/dpk-manifest.mjs')
  const { writeZip } = await import('../lib/zip.mjs')
  const { makeHome } = await import('./helpers.mjs')

  const home = await makeHome()
  const dir = await makePackage({ manifest: { name: 'dpk-legacy-fixture' } })
  const junk = Buffer.from('old nested archive bytes')
  const parts = ['package.json', 'index.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json']
  const entries = []
  const files = []
  for (const relative of parts) {
    const data = await readFile(join(dir, relative))
    files.push({ path: `package/${relative}`, size: data.length, sha256: sha256(data) })
    entries.push({ path: `package/${relative}`, data })
  }
  files.push({ path: 'package/dist/old-0.9.0.dpk', size: junk.length, sha256: sha256(junk) })
  entries.push({ path: 'package/dist/old-0.9.0.dpk', data: junk })

  const sorted = sortFiles(files)
  const manifest = {
    dpk: 1,
    name: 'dpk-legacy-fixture',
    version: '1.0.0',
    createdAt: '1980-01-01T00:00:00.000Z',
    generator: 'dpk/1.0.0',
    entry: 'package/package.json',
    roles: ['bundle'],
    dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } },
    files: sorted,
    integrity: { algorithm: 'sha256', digest: computeIntegrity(sorted) },
  }
  entries.push({ path: 'dpk.json', data: Buffer.from(JSON.stringify(manifest)) })
  const buffer = writeZip(entries)

  const result = await installArchive({
    file: 'legacy.dpk', buffer, home, profile: 'test',
    installer: async () => {}, log: () => {},
  })

  assert.equal(existsSync(join(result.packageDir, 'dist')), false, 'the carried archives never reach the store')
  const stored = JSON.parse(await readFile(join(result.packageDir, 'package.json'), 'utf8'))
  assert.equal(stored.name, '@local/dpk-legacy-fixture', 'the stored copy is re-scoped')
  const ledger = await readIndex(dpkRoot(home))
  assert.equal(ledger.entries[0].name, '@local/dpk-legacy-fixture')
})
