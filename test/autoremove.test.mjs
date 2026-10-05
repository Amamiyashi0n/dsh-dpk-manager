/**
 * autoremove(原 gc):store 里只应留下 profile 真正引用的 digest,其余(含历史遗留的
 * store/<digest>/dpk.json)由 gc 收集;"谁在用"永远从 profile 读,不看账本。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runDpkAction } from '../lib/actions.mjs'
import { referencedDigests } from '../lib/profile-install.mjs'
import { dpkRoot, readIndex, recordInstall, storeDir } from '../lib/store.mjs'
import { makeHome } from './helpers.mjs'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

/** A store entry with a package.json, and optionally the legacy manifest copy. */
async function storeEntry(root, digest, options = {}) {
  const packageDir = join(storeDir(root, digest), 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: options.name ?? '@local/x', version: '1.0.0' })}\n`)
  await writeFile(join(packageDir, 'index.js'), 'export const x = 1\n')
  if (options.legacyManifest === true) await writeFile(join(storeDir(root, digest), 'dpk.json'), '{}\n')
  return packageDir
}

/** A profile whose dependency rows point into the store. */
async function profileUsing(home, profile, dependencies = {}) {
  const dir = join(home, 'profiles', profile)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, dir]) => [name, `link:${dir}`])),
    dsh: { profile: { bundles: [] } },
  }, undefined, 2)}\n`)
}

/** Point `<profile>/node_modules/<name>` at a store package directory. */
async function linkPackage(home, profile, name, packageDir) {
  const link = join(home, 'profiles', profile, 'node_modules', ...name.split('/'))
  await mkdir(dirname(link), { recursive: true })
  await symlink(packageDir, link, 'junction')
}

test('a profile with an unparseable manifest still protects the copy it links to', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const linked = await storeEntry(root, A)
  const garbage = await storeEntry(root, B)
  // The manifest is the convenient answer to "what does this profile resolve",
  // and it is damaged. The `node_modules` link is the authoritative one — it is
  // what the Harness resolves — so the collector must read it before deleting.
  await profileUsing(home, 'broken', { '@local/shared': linked })
  await linkPackage(home, 'broken', '@local/shared', linked)
  await writeFile(join(home, 'profiles', 'broken', 'package.json'), '{ this is not json')

  const result = await runDpkAction('autoremove', {}, { home })

  assert.deepEqual(result.data.digests.map(item => item.digest), [B], 'the unlinked copy is garbage and goes')
  assert.equal(existsSync(storeDir(root, A)), true, 'the linked copy survives a damaged manifest')
  assert.equal(existsSync(garbage), false)
  assert.deepEqual(result.data.unreadable, [], 'the profile was examined through its link')
})

test('an unreadable manifest does not block the collection either', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const garbage = await storeEntry(root, B)
  // `package.json` is a directory here, so reading it fails with something other
  // than "not there" — and the profile links nothing. Both answers agree that
  // this profile resolves no store copy, and a collector is a collector: one
  // unreadable file is not a reason to leave every other package's garbage on
  // disk. (The directory itself has no links to protect, so nothing is at risk.)
  await mkdir(join(home, 'profiles', 'opaque', 'package.json'), { recursive: true })

  const result = await runDpkAction('autoremove', {}, { home })

  assert.equal(existsSync(garbage), false, 'the collection is not blocked')
  assert.deepEqual(result.data.digests.map(item => item.digest), [B])
  assert.deepEqual(result.data.unreadable, [], 'its links could be listed, so its references are known')
})

test('referencedDigests maps each digest to the profiles that resolve it', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const shared = await storeEntry(root, A)
  const solo = await storeEntry(root, B)
  await profileUsing(home, 'web', { '@local/shared': shared })
  await profileUsing(home, 'desktop', { '@local/shared': shared, '@local/solo': solo })
  await profileUsing(home, 'idle')                                        // no dependencies at all
  await mkdir(join(home, 'profiles', 'not-a-profile'), { recursive: true }) // no package.json

  const { profiles, references } = await referencedDigests({ home, root })

  assert.deepEqual(profiles, ['desktop', 'idle', 'web'], 'a profile is a directory with a package.json')
  assert.deepEqual(references.get(A), ['desktop', 'web'], 'profile-name order, deterministic')
  assert.deepEqual(references.get(B), ['desktop'])
})

test('a dependency that is not a link into this store is not a reference', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const elsewhere = await mkdtemp(join(tmpdir(), 'elsewhere-'))
  await storeEntry(root, A)
  await mkdir(join(home, 'profiles', 'p'), { recursive: true })
  await writeFile(join(home, 'profiles', 'p', 'package.json'), `${JSON.stringify({
    private: true,
    dependencies: {
      local: `link:${join(storeDir(root, A), 'package')}`,
      outside: `link:${join(elsewhere, 'package')}`,
      registry: '^1.0.0',
      file: `file:${elsewhere}`,
    },
  }, undefined, 2)}\n`)

  const { references } = await referencedDigests({ home, root })

  assert.deepEqual([...references.keys()], [A])
})

test('gc collects exactly what no profile references, and says what it freed', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const kept = await storeEntry(root, A, { name: '@local/kept', legacyManifest: true })
  const stale = await storeEntry(root, B, { name: '@local/stale' })
  await storeEntry(root, 'c'.repeat(64), { name: '@local/untracked' })    // no ledger row at all
  await recordInstall(root, { name: '@local/kept', version: '1.0.0', digest: A, source: 'kept.dpk' })
  await recordInstall(root, { name: '@local/stale', version: '1.0.0', digest: B, source: 'stale.dpk' })
  await profileUsing(home, 'desktop', { '@local/kept': kept })

  const result = await runDpkAction('autoremove', {}, { home })

  assert.deepEqual(result.data.digests.map(item => item.digest).sort(), [B, 'c'.repeat(64)].sort())
  assert.equal(result.data.digests.every(item => item.bytes > 0), true, 'the report carries what was freed')
  assert.equal(result.data.referenced, 1)
  assert.equal(existsSync(storeDir(root, A)), true)
  // A `dpk.json` sidecar is a pre-2.0.3 leftover, read by nothing: it goes from
  // every digest it is found in, referenced or not, with no bookkeeping to
  // report it.
  assert.equal(existsSync(join(storeDir(root, A), 'dpk.json')), false, 'the old sidecar is deleted')
  assert.equal(existsSync(storeDir(root, B)), false)
  assert.equal(existsSync(storeDir(root, 'c'.repeat(64))), false, 'an untracked store directory is collected too')

  const index = await readIndex(root)
  assert.deepEqual(index.entries.map(entry => entry.digest), [A], 'the ledger converges onto the profiles')
  assert.match(result.text, /freed/)
})

test('gc on a converged store is a no-op that says so', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const kept = await storeEntry(root, A, { name: '@local/kept' })
  await recordInstall(root, { name: '@local/kept', version: '1.0.0', digest: A, source: 'kept.dpk' })
  await profileUsing(home, 'desktop', { '@local/kept': kept })

  const result = await runDpkAction('autoremove', {}, { home })

  assert.deepEqual(result.data.digests, [])
  assert.match(result.text, /nothing to collect/)
})
