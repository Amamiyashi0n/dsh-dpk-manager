/**
 * The archive/package cross-check, read strictly.
 *
 * `dpk.json` and the `package/` inside it make the same claims twice, and the
 * digest never covers the manifest itself — so this comparison is what stands
 * between a rewritten manifest and an installer that would act on it. Nothing is
 * normalized to make an older generation's archive agree: a manifest that
 * localized the name at pack time, or that lists a directory the packer never
 * packs, is a mismatch like any other.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareManifestToPackage } from '../src/lib/dpk-manifest.mjs'
import { validateDshPackage } from '../src/lib/dsh-package.mjs'
import { makePackage } from './helpers.mjs'

/** Facts of the fixture package, as the archive scanner reads them. */
async function factsOf() {
  return validateDshPackage(await makePackage())
}

/** A manifest that matches the fixture, with one thing changed. */
function manifestFor(facts, overrides = {}) {
  return {
    name: facts.name,
    version: facts.version,
    roles: [...facts.roles],
    dsh: facts.dsh,
    files: facts.files.map(file => ({ path: `package/${file.path}`, size: file.size, sha256: file.sha256 })),
    ...overrides,
  }
}

test('a manifest that agrees with the package cross-checks clean', async () => {
  const facts = await factsOf()
  assert.deepEqual(compareManifestToPackage(manifestFor(facts), facts), [])
})

test('the cross-check names a renamed package and an absent file', async () => {
  const facts = await factsOf()
  const manifest = manifestFor(facts)
  assert.ok(
    compareManifestToPackage({ ...manifest, name: '@local/other' }, facts).some(problem => problem.startsWith('name:')),
    'a genuinely different name fails',
  )
  const withGhost = manifestFor(facts, {
    files: [...manifest.files, { path: 'package/lib/absent.js', size: 1, sha256: 'a'.repeat(64) }],
  })
  assert.ok(
    compareManifestToPackage(withGhost, facts).some(problem => problem.includes('absent.js')),
    'a listed file the package does not have fails',
  )
})

test('a manifest that localized the name at pack time is a mismatch', async () => {
  const facts = await factsOf()
  // Pre-2.1.10 packers burned the install-time scope into the archive. This
  // reader serves one convention — archives carry the bare name — so the old
  // spelling is refused rather than normalized into agreement.
  const problems = compareManifestToPackage(manifestFor(facts, { name: facts.name.replace(/^/, '@local/') }), facts)
  assert.ok(problems.some(problem => problem.startsWith('name:')), problems.join('\n'))
})

test('a manifest listing a never-packed directory is a mismatch', async () => {
  const facts = await factsOf()
  // The packer never carries `dist/`, `node_modules/` or `.git/`. A manifest
  // that lists one describes an archive this reader does not accept — the old
  // tolerance for it (skipping such entries) is gone.
  const junk = Buffer.from('stale nested archive bytes')
  const problems = compareManifestToPackage(manifestFor(facts, {
    files: [
      ...facts.files.map(file => ({ path: `package/${file.path}`, size: file.size, sha256: file.sha256 })),
      { path: 'package/dist/old-0.9.0.dpk', size: junk.length, sha256: 'f'.repeat(64) },
    ],
  }), facts)
  assert.ok(problems.some(problem => problem.includes('dist/old-0.9.0.dpk')), problems.join('\n'))
})
