/** Action layer: the behaviour shared by the CLI and the in-session `dpk` tool. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DpkActionError, runDpkAction } from '../lib/actions.mjs'
import { packDirectory } from '../lib/pack.mjs'
import { dpkRoot } from '../lib/store.mjs'
import { makeHome, makePackage } from './helpers.mjs'

async function packedFixture() {
  const root = await makePackage()
  return packDirectory(root)
}

test('verify needs a file', async () => {
  await assert.rejects(runDpkAction('verify', {}, {}), error => error instanceof DpkActionError && /needs `file`/.test(error.message))
})

test('verify and inspect work on a real archive', async () => {
  const packed = await packedFixture()
  const home = await makeHome()
  const file = join(home, 'fixture.dpk')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, packed.buffer)

  const verified = await runDpkAction('verify', { file }, {})
  assert.equal(verified.data.name, '@local/dpk-fixture')
  assert.equal(verified.data.files, 5)
  assert.match(verified.text, /verdict {2}valid/)

  const inspected = await runDpkAction('inspect', { file }, {})
  assert.equal(inspected.data.manifest.integrity.digest, packed.manifest.integrity.digest)
  assert.match(inspected.text, /"generator": "dpk\//)
})

test('pack writes an archive and reports its digest', async () => {
  const root = await makePackage()
  const home = await makeHome()
  const output = join(home, 'out.dpk')
  const result = await runDpkAction('pack', { directory: root, output }, {})
  assert.ok(existsSync(output))
  assert.equal(result.data.digest, (await packDirectory(root)).manifest.integrity.digest)
  assert.equal((await readFile(output)).length, result.data.bytes)
})

test('pack can record real build provenance on request', async () => {
  const root = await makePackage()
  const home = await makeHome()
  const result = await runDpkAction('pack', { directory: root, output: join(home, 'now.dpk'), createdAt: 'now' }, {})
  assert.notEqual(result.data.digest, undefined)
  assert.match(result.text, /wrote/)
})

test('install dry-run writes nothing and hands off the exact store path', async () => {
  const packed = await packedFixture()
  const home = await makeHome()
  const file = join(home, 'x.dpk')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, packed.buffer)

  const result = await runDpkAction('install', { file, dryRun: true }, { home, profile: 'probe' })
  assert.equal(result.data.dryRun, true)
  assert.ok(!existsSync(dpkRoot(home)), 'dry-run must not create the store')
  // Whichever hand-off this machine supports: the official CLI, or the tool call when it has none.
  assert.ok(
    result.text.includes('plugin_manager action=install_bundle target=') || result.text.includes('plugin --profile probe install'),
    `dry run must name the official hand-off, got:\n${result.text}`,
  )
  assert.match(result.text, /nothing was written/)
})

test('install through an injected installer records the ledger and never spawns anything', async () => {
  const packed = await packedFixture()
  const home = await makeHome()
  const file = join(home, 'x.dpk')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, packed.buffer)

  const calls = []
  const result = await runDpkAction('install', { file }, {
    home,
    profile: 'probe',
    installer: async (packageDir) => { calls.push(packageDir) },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0], result.data.storePath)
  assert.equal(result.data.via, 'service')
  assert.ok(existsSync(join(result.data.storePath, 'package.json')))
  assert.match(result.text, /installed by the plugin manager service/)

  const listed = await runDpkAction('list', {}, { home })
  assert.equal(listed.data.entries.length, 1)
  assert.deepEqual(listed.data.entries[0].profiles, ['probe'])

  const which = await runDpkAction('which', { name: '@local/dpk-fixture' }, { home })
  const normalise = value => value.replaceAll('\\', '/')
  assert.ok(normalise(which.text).includes(normalise(result.data.storePath)))
})

test('a failing installer leaves no ledger entry', async () => {
  const packed = await packedFixture()
  const home = await makeHome()
  const file = join(home, 'x.dpk')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, packed.buffer)
  await assert.rejects(
    runDpkAction('install', { file }, { home, profile: 'probe', installer: async () => { throw new Error('manager refused') } }),
    /manager refused/,
  )
  assert.equal(existsSync(join(dpkRoot(home), 'index.json')), false)
})

test('list on an empty store says so, and which reports a miss', async () => {
  const home = await makeHome()
  const listed = await runDpkAction('list', {}, { home })
  assert.equal(listed.data.entries.length, 0)
  assert.match(listed.text, /no packages installed through dpk/)
  await assert.rejects(runDpkAction('which', { name: 'nope' }, { home }), error => error instanceof DpkActionError)
})

test('unknown actions and missing arguments are caller mistakes', async () => {
  await assert.rejects(runDpkAction('frobnicate', {}, {}), error => error instanceof DpkActionError)
  await assert.rejects(runDpkAction('pack', {}, {}), error => /pack needs `directory`/.test(error.message))
  await assert.rejects(runDpkAction('which', {}, {}), error => /which needs `name`/.test(error.message))
  await assert.rejects(runDpkAction('install', {}, {}), error => /needs `file`/.test(error.message))
})
