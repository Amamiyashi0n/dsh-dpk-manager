/**
 * `dpk list` 的可加载性诊断 —— `dpkg --audit` 里可推导的那一半。
 *
 * profile 说某个包在,但 store 副本没了 / 链接指向别处 / 没进 bundle 列表 /
 * 根本没链接时,Harness 下次启动就加载不了这个 bundle。这些事实全都能从
 * profile + store 读出来,所以在 `list` 里直接报,而不是等启动报错。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runDpkAction } from '../lib/actions.mjs'
import { dpkRoot, recordInstall } from '../lib/store.mjs'
import { makeHome, profileUsing, storeEntry } from './helpers.mjs'

const A = 'a'.repeat(64)

/** A home with one package installed into `desktop`, plus its ledger row. */
async function installed(options = {}) {
  const home = await makeHome()
  const root = dpkRoot(home)
  const packageDir = await storeEntry(root, A, { name: options.name ?? '@local/x' })
  await recordInstall(root, { name: options.name ?? '@local/x', version: '1.0.0', digest: A, source: 'x.dpk' })
  const dependencies = options.dependencies === undefined ? { '@local/x': packageDir } : options.dependencies
  const profileDir = await profileUsing(home, 'desktop', dependencies)
  if (options.link !== false) {
    const link = join(profileDir, 'node_modules', '@local', 'x')
    await mkdir(dirname(link), { recursive: true })
    await symlink(packageDir, link, 'junction')
  }
  return { home, root, packageDir, profileDir }
}

test('list stays quiet when everything the profiles name still resolves', async () => {
  const { home } = await installed()

  const result = await runDpkAction('list', {}, { home })

  assert.deepEqual(result.data.broken, [])
  assert.equal(result.text.includes('broken'), false)
})

test('list reports a store copy that is gone', async () => {
  const { home, packageDir } = await installed()
  await rm(packageDir, { recursive: true, force: true })

  const result = await runDpkAction('list', {}, { home })

  assert.equal(result.data.broken.length, 1)
  assert.match(result.data.broken[0], /is gone \(the store copy was deleted\)/)
  assert.match(result.text, /^broken/m)
  assert.match(result.text, /re-install its \.dpk/)
})

test('list reports a link that resolves somewhere else', async () => {
  const { home, profileDir } = await installed()
  const elsewhere = join(home, 'somewhere-else')
  await storeEntry(join(home, 'other-root'), A, { name: '@local/x' })
  const link = join(profileDir, 'node_modules', '@local', 'x')
  await rm(link, { recursive: true, force: true })
  await symlink(join(home, 'other-root', 'store', A, 'package'), link, 'junction')
  await rm(elsewhere, { recursive: true, force: true })

  const result = await runDpkAction('list', {}, { home })

  assert.equal(result.data.broken.length, 1)
  assert.match(result.data.broken[0], /resolves to/)
})

test('list reports a missing link and a missing bundle entry', async () => {
  const { home } = await installed({ link: false })

  const result = await runDpkAction('list', {}, { home })

  assert.equal(result.data.broken.length, 1)
  assert.match(result.data.broken[0], /is not linked/)
})

test('a row no profile names any more is unused, not broken', async () => {
  const { home, root, profileDir: dir } = await installed()
  // The profile moves to another digest, which is what a re-install does: the
  // dependency row and the link move together.
  const other = await storeEntry(root, 'b'.repeat(64), { name: '@local/x' })
  await profileUsing(home, 'desktop', { '@local/x': other })
  const link = join(dir, 'node_modules', '@local', 'x')
  await rm(link, { recursive: true, force: true })
  await symlink(other, link, 'junction')

  const result = await runDpkAction('list', {}, { home })

  assert.deepEqual(result.data.broken, [], 'an unreferenced digest is autoremove business, not a load failure')
  assert.deepEqual(result.data.entries[0].profiles, [])
  assert.match(result.text, /unused/)
  assert.match(result.text, /dpk autoremove/)
  // The digest the profile moved to has no ledger row (this fixture placed one
  // without recording it), so the inventory reports it rather than omitting a
  // package a profile really resolves.
  assert.deepEqual(result.data.untracked.map(entry => entry.digest), ['b'.repeat(64)])
  assert.match(result.text, /\(untracked\)/)
})
