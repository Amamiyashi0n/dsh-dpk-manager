/** Install semantics: store layout, idempotency, dry-run purity, and the DSH hand-off. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packDirectory } from '../lib/pack.mjs'
import { installArchive, resolveDshCli } from '../lib/install.mjs'
import { dpkRoot, readIndex, storeDir } from '../lib/store.mjs'
import { makeHome, makePackage } from './helpers.mjs'

/** An executor that records invocations instead of running pnpm. */
function recorder(status = 0) {
  const calls = []
  return { calls, run: (argv) => { calls.push(argv); return { status } } }
}

/** A fake DSH CLI argv, so resolveDshCli returns it verbatim. */
const FAKE_DSH = [process.execPath, '-e', 'process.exit(0)']

async function packFixture(manifest) {
  const root = await makePackage(manifest === undefined ? {} : { manifest })
  return packDirectory(root)
}

test('verifies, extracts into the store, and hands DSH an absolute package path', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const exec = recorder()
  const result = await installArchive({
    file: 'fixture.dpk',
    buffer: packed.buffer,
    home,
    profile: 'test',
    dsh: FAKE_DSH,
    run: exec.run,
    log: () => {},
  })

  const root = dpkRoot(home)
  const packageDir = join(storeDir(root, packed.manifest.integrity.digest), 'package')
  assert.equal(result.packageDir, packageDir)
  assert.equal(result.created, true)
  assert.ok(existsSync(join(packageDir, 'package.json')), 'the store holds the package root')
  assert.ok(existsSync(join(storeDir(root, packed.manifest.integrity.digest), 'dpk.json')), 'the manifest copy is kept')

  assert.equal(exec.calls.length, 1)
  assert.deepEqual(exec.calls[0], [...FAKE_DSH, 'plugin', '--profile', 'test', 'install', packageDir])
  assert.equal(exec.calls[0].at(-1), packageDir)

  const index = await readIndex(root)
  assert.equal(index.entries.length, 1)
  assert.equal(index.entries[0].name, '@local/dpk-fixture')
  assert.equal(index.entries[0].digest, packed.manifest.integrity.digest)
  assert.deepEqual(index.entries[0].profiles, ['test'])
})

test('is idempotent: the same digest is extracted once', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const first = await installArchive({ file: 'a.dpk', buffer: packed.buffer, home, profile: 'test', dsh: FAKE_DSH, run: recorder().run, log: () => {} })
  const second = await installArchive({ file: 'b.dpk', buffer: packed.buffer, home, profile: 'test', dsh: FAKE_DSH, run: recorder().run, log: () => {} })
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
    await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile, dsh: FAKE_DSH, run: recorder().run, log: () => {} })
  }
  const index = await readIndex(dpkRoot(home))
  assert.equal(index.entries.length, 1)
  assert.deepEqual([...index.entries[0].profiles].sort(), ['desktop', 'web'])
})

test('a dry run writes nothing and still reports the exact command', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const exec = recorder()
  const result = await installArchive({
    file: 'fixture.dpk', buffer: packed.buffer, home, profile: 'test',
    dsh: FAKE_DSH, run: exec.run, dryRun: true, log: () => {},
  })
  assert.equal(exec.calls.length, 0, 'no installer was run')
  assert.equal(existsSync(dpkRoot(home)), false, 'the store was not created')
  assert.equal(result.dryRun, true)
  assert.deepEqual(result.command, [...FAKE_DSH, 'plugin', '--profile', 'test', 'install', result.packageDir])
  assert.equal(result.toolCall, `plugin_manager action=install_bundle target=${result.packageDir}`)
})

test('a failed DSH install leaves the store but no ledger entry, and names the retry', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', dsh: FAKE_DSH, run: recorder(1).run, log: () => {} }),
    error => error.code === 'DPK_DSH_FAILED' && error.message.includes('plugin --profile test install'),
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
    installArchive({ file: 'x.dpk', buffer: corrupt, home, profile: 'test', dsh: FAKE_DSH, run: exec.run, log: () => {} }),
  )
  assert.equal(exec.calls.length, 0)
})

test('--force re-extracts the same digest', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const first = await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', dsh: FAKE_DSH, run: recorder().run, log: () => {} })
  await writeFile(join(first.packageDir, 'stray.txt'), 'leftover\n')
  const second = await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', force: true, dsh: FAKE_DSH, run: recorder().run, log: () => {} })
  assert.equal(second.created, true)
  assert.equal(existsSync(join(second.packageDir, 'stray.txt')), false, 'the directory was rebuilt')
})

test('--keep-archive retains the original bytes', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await installArchive({
    file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', keepArchive: true,
    dsh: FAKE_DSH, run: recorder().run, log: () => {},
  })
  const retained = await readFile(join(dpkRoot(home), 'archives', 'local-dpk-fixture-1.0.0.dpk'))
  assert.ok(retained.equals(packed.buffer))
})

test('resolving the DSH CLI honours an explicit override', () => {
  const resolved = resolveDshCli({ dsh: FAKE_DSH })
  assert.deepEqual(resolved.argv, FAKE_DSH)
  const asString = resolveDshCli({ dsh: 'dsh-here' })
  assert.deepEqual(asString.argv, ['dsh-here'])
})

test('refuses to install without a DSH home', async () => {
  const packed = await packFixture()
  const exec = recorder()
  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: packed.buffer, home: '', dsh: FAKE_DSH, run: exec.run, log: () => {} }),
    error => error.code === 'DPK_NO_HOME',
  )
  assert.equal(exec.calls.length, 0)
})
