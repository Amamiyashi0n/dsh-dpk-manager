/** Install semantics: store layout, idempotency, dry-run purity, the official-installer hand-off, and the profile policy write. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packDirectory } from '../lib/pack.mjs'
import { installArchive, installOverwriting } from '../lib/install.mjs'
import { disableReleaseAgeCooldown } from '../lib/profile-policy.mjs'
import { dpkRoot, readIndex, storeDir } from '../lib/store.mjs'
import { makeHome, makePackage } from './helpers.mjs'

/** An installer that records the call instead of running pnpm. */
function recorder() {
  const calls = []
  return { calls, installer: async (packageDir, meta) => { calls.push([packageDir, meta]) } }
}

/** A manager whose first install cannot diff the unchanged row, like the official one on a re-import. */
function ambiguousManager() {
  const seen = []
  const manager = {
    seen,
    installBundle: async (dir) => {
      seen.push(['install', dir])
      return seen.filter(call => call[0] === 'install').length === 1
        ? { application: 'failed', error: { diagnostic: 'ambiguous-install' } }
        : { application: 'applied', changed: true }
    },
    removeBundle: async (name) => { seen.push(['remove', name]); return { changed: true } },
  }
  return manager
}

async function packFixture(manifest) {
  const root = await makePackage(manifest === undefined ? {} : { manifest })
  return packDirectory(root)
}

/** The workspace file an install may touch, as the install itself resolves it. */
function workspaceOf(home, profile) {
  return join(home, 'profiles', profile, 'pnpm-workspace.yaml')
}

test('verifies, extracts into the store, and hands the official installer an absolute package path', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const exec = recorder()
  const result = await installArchive({
    file: 'fixture.dpk',
    buffer: packed.buffer,
    home,
    profile: 'test',
    installer: exec.installer,
    log: () => {},
  })

  const root = dpkRoot(home)
  const packageDir = join(storeDir(root, packed.manifest.integrity.digest), 'package')
  assert.equal(result.packageDir, packageDir)
  assert.equal(result.created, true)
  assert.ok(existsSync(join(packageDir, 'package.json')), 'the store holds the package root')

  assert.equal(exec.calls.length, 1)
  assert.equal(exec.calls[0][0], packageDir)
  assert.deepEqual(exec.calls[0][1], { name: '@local/dpk-fixture', version: '1.0.0', digest: packed.manifest.integrity.digest })
  assert.equal(result.via, 'service')

  const index = await readIndex(root)
  assert.equal(index.entries.length, 1)
  assert.equal(index.entries[0].name, '@local/dpk-fixture')
  assert.equal(index.entries[0].digest, packed.manifest.integrity.digest)
  assert.deepEqual(index.entries[0].profiles, ['test'])
})

test('is idempotent: the same digest is extracted once', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const first = await installArchive({ file: 'a.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  const second = await installArchive({ file: 'b.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  const entries = await readdir(join(dpkRoot(home), 'store'))
  assert.deepEqual(entries, [packed.manifest.integrity.digest])
  const index = await readIndex(dpkRoot(home))
  assert.equal(index.entries.length, 1, 'one ledger row per identity')
})

test('records a second profile without duplicating the entry', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  for (const profile of ['web', 'desktop']) {
    await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile, installer: recorder().installer, log: () => {} })
  }
  const index = await readIndex(dpkRoot(home))
  assert.equal(index.entries.length, 1)
  assert.deepEqual([...index.entries[0].profiles].sort(), ['desktop', 'web'])
})

test('a dry run writes nothing and still reports the official hand-off', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const exec = recorder()
  const result = await installArchive({
    file: 'fixture.dpk', buffer: packed.buffer, home, profile: 'test',
    installer: exec.installer, dryRun: true, log: () => {},
  })
  assert.equal(exec.calls.length, 0, 'no installer was run')
  assert.equal(existsSync(dpkRoot(home)), false, 'the store was not created')
  assert.equal(existsSync(workspaceOf(home, 'test')), false, 'the profile workspace was not written')
  assert.equal(result.dryRun, true)
  assert.equal(result.toolCall, `plugin_manager action=install_bundle target=${result.packageDir}`)
})

test('a failing installer leaves the store but no ledger entry', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await assert.rejects(
    installArchive({
      file: 'x.dpk', buffer: packed.buffer, home, profile: 'test',
      installer: async () => { throw new Error('the plugin manager refused') },
      log: () => {},
    }),
    error => error instanceof Error && error.message.includes('plugin manager refused'),
  )
  assert.equal(existsSync(join(dpkRoot(home), 'index.json')), false)
})

test('without an installer the install refuses and names the official call', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', log: () => {} }),
    error => error.code === 'DPK_NO_INSTALLER' && error.message.includes('plugin_manager action=install_bundle'),
  )
  assert.equal(existsSync(join(dpkRoot(home), 'index.json')), false)
})

test('a corrupt archive never reaches the installer', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const exec = recorder()
  const corrupt = Buffer.from(packed.buffer)
  corrupt[40] ^= 0xff
  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: corrupt, home, profile: 'test', installer: exec.installer, log: () => {} }),
  )
  assert.equal(exec.calls.length, 0)
})

test('--force re-extracts the same digest', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const first = await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  await writeFile(join(first.packageDir, 'stray.txt'), 'leftover\n')
  const second = await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', force: true, installer: recorder().installer, log: () => {} })
  assert.equal(second.created, true)
  assert.equal(existsSync(join(second.packageDir, 'stray.txt')), false, 'the directory was rebuilt')
})

test('--keep-archive retains the original bytes', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await installArchive({
    file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', keepArchive: true,
    installer: recorder().installer, log: () => {},
  })
  const retained = await readFile(join(dpkRoot(home), 'archives', 'local-dpk-fixture-1.0.0.dpk'))
  assert.ok(retained.equals(packed.buffer))
})

test('refuses to install without a DSH home', async () => {
  const packed = await packFixture()
  const exec = recorder()
  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: packed.buffer, home: '', installer: exec.installer, log: () => {} }),
    error => error.code === 'DPK_NO_HOME',
  )
  assert.equal(exec.calls.length, 0)
})

test('an install opts the profile out of the pnpm release-age cooldown', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await mkdir(join(home, 'profiles', 'test'), { recursive: true })
  await writeFile(workspaceOf(home, 'test'), 'packages:\n  - .\nnodeLinker: hoisted\n')
  await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  const text = await readFile(workspaceOf(home, 'test'), 'utf8')
  assert.ok(text.startsWith('packages:\n  - .\nnodeLinker: hoisted\n'), 'the existing settings are preserved')
  assert.ok(text.includes('minimumReleaseAge: 0'), 'the cooldown is disabled for the profile')
})

test('a policy the user configured explicitly is never rewritten', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await mkdir(join(home, 'profiles', 'test'), { recursive: true })
  await writeFile(workspaceOf(home, 'test'), 'packages:\n  - .\nminimumReleaseAge: 1440\n')
  await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  const text = await readFile(workspaceOf(home, 'test'), 'utf8')
  assert.equal(text, 'packages:\n  - .\nminimumReleaseAge: 1440\n', 'the explicit value stays')
})

test('disableReleaseAgeCooldown creates the workspace file when absent', async () => {
  const dir = await makeHome()
  assert.equal(await disableReleaseAgeCooldown(dir), true)
  assert.equal(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'), 'minimumReleaseAge: 0\n')
  assert.equal(await disableReleaseAgeCooldown(dir), false, 'the second call changes nothing')
})

test('installOverwriting retries an ambiguous re-import as remove+install', async () => {
  const manager = ambiguousManager()
  const outcome = await installOverwriting(manager, 'C:/store/pkg', 'fixture')
  assert.equal(outcome.application, 'applied')
  assert.deepEqual(manager.seen, [
    ['install', 'C:/store/pkg'],
    ['remove', 'fixture'],
    ['install', 'C:/store/pkg'],
  ])
})

test('installOverwriting surfaces a failure that is not the ambiguous case', async () => {
  const manager = {
    installBundle: async () => ({ application: 'failed', error: { diagnostic: 'registry refused' } }),
    removeBundle: async () => { throw new Error('must not be reached') },
  }
  const outcome = await installOverwriting(manager, 'C:/store/pkg', 'fixture')
  assert.equal(outcome.application, 'failed')
  assert.equal(outcome.error.diagnostic, 'registry refused')
})

test('installOverwriting reports a failing remove during the retry', async () => {
  const manager = {
    installBundle: async () => ({ application: 'failed', error: { code: 'ambiguous-install' } }),
    removeBundle: async () => ({ application: 'failed', error: { diagnostic: 'unload refused' } }),
  }
  await assert.rejects(
    installOverwriting(manager, 'C:/store/pkg', 'fixture'),
    error => error.message.includes('unload refused'),
  )
})

test('an unscoped source installs under the @local scope in store, ledger, and patch rows', async () => {
  const home = await makeHome()
  const dir = await makePackage({
    manifest: { name: 'plain-tool' },
    extraFiles: { 'cordis.patch.yml': "- insert:\n    - id: plain-tool\n      name: 'plain-tool'" },
  })
  const packed = await packDirectory(dir)
  assert.equal(packed.manifest.name, 'plain-tool', 'the archive manifest carries the bare name; the scope is an install-time marking')
  const exec = recorder()
  const result = await installArchive({
    file: 'plain.dpk', buffer: packed.buffer, home, profile: 'test',
    installer: exec.installer, log: () => {},
  })

  const stored = JSON.parse(await readFile(join(result.packageDir, 'package.json'), 'utf8'))
  assert.equal(stored.name, '@local/plain-tool', 'the store copy is re-scoped')
  const patch = await readFile(join(result.packageDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes("name: '@local/plain-tool'"), `patch rows name the scoped package:\n${patch}`)
  assert.ok(!/name:\s*'plain-tool'/.test(patch), 'no row keeps the unscoped name')

  const index = await readIndex(dpkRoot(home))
  assert.equal(index.entries[0].name, '@local/plain-tool', 'the ledger records the scoped name')
})

test('writeIndex leaves no temp file behind and reads back identically', async () => {
  const { writeIndex, readIndex, dpkRoot } = await import('../lib/store.mjs')
  const { readdir } = await import('node:fs/promises')
  const home = await makeHome()
  const root = dpkRoot(home)
  const index = { entries: [{ name: '@local/x', version: '1.0.0', digest: 'a'.repeat(64), installedAt: '', source: '', profiles: ['test'], path: '' }] }
  await writeIndex(root, index)
  const files = (await readdir(root)).filter(name => name.includes('.tmp-'))
  assert.deepEqual(files, [], 'no temp file survives a successful write')
  assert.deepEqual((await readIndex(root)).entries, index.entries)
})

test('concurrent ledger writes serialize: both apply in order, no temp left, no lost rename', async () => {
  const { writeIndex, readIndex, dpkRoot } = await import('../lib/store.mjs')
  const { readdir } = await import('node:fs/promises')
  const home = await makeHome()
  const root = dpkRoot(home)
  const entry = suffix => ({ name: '@local/x', version: `1.0.${String(suffix)}`, digest: 'a'.repeat(64), installedAt: '', source: '', profiles: ['test'], path: '' })
  // 卸载→立刻装新版的真实形态:两个 writeIndex 几乎同时进入
  await Promise.all([
    writeIndex(root, { entries: [entry(1)] }),
    writeIndex(root, { entries: [entry(1), entry(2)] }),
  ])
  const files = (await readdir(root)).filter(name => name.includes('.tmp-'))
  assert.deepEqual(files, [], 'no temp file survives concurrent writes')
  const after = (await readIndex(root)).entries.map(e => e.version)
  assert.deepEqual(after, ['1.0.1', '1.0.2'], 'the later write wins whole, never interleaved')
})
