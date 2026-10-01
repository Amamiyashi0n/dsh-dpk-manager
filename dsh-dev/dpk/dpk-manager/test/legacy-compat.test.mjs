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
