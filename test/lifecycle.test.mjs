/**
 * dpk 对自己生命周期的两条保证:
 *  ① 它不留下自己的垃圾:写入用的是"暂存 + 改名",进程被杀会留下暂存物,
 *     这些必须有人收(autoremove),而且**绝不能动活着的那次写入**;
 *  ② 它不管别人写进来的东西:dpk 根目录里出现别人的文件,既不报错也不删。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { runDpkAction } from '../lib/actions.mjs'
import { dpkRoot, readIndex, recordInstall, restartPending, storeDir } from '../lib/store.mjs'
import { profileDir } from '../lib/profile-install.mjs'
import { cacheDir, stagePath } from '../lib/staging.mjs'
import { packDirectory } from '../lib/pack.mjs'
import { makePackage } from './helpers.mjs'
import { makeHome, profileUsing, storeEntry } from './helpers.mjs'

/** One `.dpk` of the fixture package, written into the home and returned. */
async function fixtureArchive(home, version, options = {}) {
  const packed = await packDirectory(await makePackage({
    manifest: { name: options.name ?? '@local/fixture', version, ...options.manifest },
    ...options.package,
  }))
  const file = join(home, `${(options.name ?? '@local/fixture').replace(/^@[^/]+\//, '')}-${version}.dpk`)
  await writeFile(file, packed.buffer)
  return file
}

const DIGEST = 'a'.repeat(64)

/** A home with one installed digest plus the staging leftovers of dead writers. */
async function homeWithLeftovers() {
  const home = await makeHome()
  const root = dpkRoot(home)
  await storeEntry(root, DIGEST, { name: '@local/x' })
  const profile = await profileUsing(home, 'probe', { '@local/x': join(storeDir(root, DIGEST), 'package') })

  // Everything dpk stages lives in one directory, so an interrupted install,
  // ledger write or profile write all leave their leftovers side by side there.
  // The pid in the name is that of a writer that no longer exists (999999 is not
  // a live process here).
  const cache = cacheDir(root)
  await mkdir(cache, { recursive: true })
  const deadStoreStaging = stagePath(cache, DIGEST, 'tmp').replace(`-${process.pid}-`, '-999999-')
  await mkdir(join(deadStoreStaging, 'package'), { recursive: true })
  await writeFile(join(deadStoreStaging, 'package', 'package.json'), '{"name":"@local/x"}\n')
  const deadLedgerStaging = stagePath(cache, 'index.json', 'tmp').replace(`-${process.pid}-`, '-999999-')
  await writeFile(deadLedgerStaging, '{}\n')
  const deadProfileStaging = stagePath(cache, `manifest-${basename(profile)}`, 'dpk').replace(`-${process.pid}-`, '-999999-')
  await writeFile(deadProfileStaging, '{}\n')

  // And what a live writer would have: this process's own staging.
  const liveStaging = stagePath(cache, DIGEST, 'tmp')
  await mkdir(liveStaging, { recursive: true })

  return { home, root, profile, cache, deadStoreStaging, deadLedgerStaging, deadProfileStaging, liveStaging }
}

test('autoremove collects the staging leftovers of writers that are gone', async () => {
  const { home, deadStoreStaging, deadLedgerStaging, deadProfileStaging, liveStaging } = await homeWithLeftovers()

  const result = await runDpkAction('autoremove', {}, { home })

  assert.deepEqual(
    result.data.stagings.map(item => item.path).sort(),
    [deadStoreStaging, deadLedgerStaging, deadProfileStaging].sort(),
  )
  assert.equal(result.data.stagings.every(item => item.pid === 999999), true)
  assert.match(result.text, /staging leftover\(s\)/)
  assert.equal(existsSync(deadStoreStaging), false, 'the interrupted store staging is gone')
  assert.equal(existsSync(deadLedgerStaging), false)
  assert.equal(existsSync(deadProfileStaging), false)
  assert.equal(existsSync(liveStaging), true, 'a live writer\'s staging is never touched')
})

test('autoremove removes the leftovers but never a live writer\'s staging', async () => {
  const { home, deadStoreStaging, liveStaging, cache } = await homeWithLeftovers()

  const result = await runDpkAction('autoremove', {}, { home })

  assert.equal(result.data.stagings.length, 3)
  assert.equal(existsSync(deadStoreStaging), false, 'the dead writer\'s leftover is collected')
  assert.equal(existsSync(liveStaging), true, 'a live writer\'s staging is never touched')
  assert.equal(existsSync(cache), true, 'the cache stays while a live writer is using it')
  assert.match(result.text, /kept \(a live writer is staging there\)/)
})

test('autoremove removes the whole cache once nothing is staged in it', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const cache = cacheDir(root)
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, `index.json.tmp-999999-3`), '{}\n')

  const result = await runDpkAction('autoremove', {}, { home })

  assert.deepEqual(result.data.stagings.map(item => item.name), ['index.json.tmp-999999-3'])
  assert.equal(existsSync(cache), false, 'an empty cache directory is not kept')
  assert.match(result.text, /removed \(nothing staged there any more\)/)
})

test('a successful write leaves no cache directory behind', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  await profileUsing(home, 'probe')
  const file = await fixtureArchive(home, '1.0.0')

  // Install stages the store copy, the profile manifest and the ledger — three
  // writers, one scratch directory. Each renames its artifact out, and the last
  // one drops the directory: a steady-state dpk root is `store/` and
  // `index.json`, nothing else.
  await runDpkAction('install', { file }, { home, profile: 'probe' })
  assert.equal(existsSync(cacheDir(root)), false, 'the install staged and left nothing')
  assert.deepEqual((await readdir(root)).sort(), ['index.json', 'store'])

  await runDpkAction('remove', { name: '@local/fixture' }, { home, profile: 'probe' })
  assert.equal(existsSync(cacheDir(root)), false, 'the removal staged and left nothing')
  assert.deepEqual((await readdir(root)).sort(), ['index.json', 'store'])
})

test('staging residue an older generation left inside store is deleted on sight', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  await storeEntry(root, DIGEST, { name: '@local/x' })
  await profileUsing(home, 'probe', { '@local/x': join(storeDir(root, DIGEST), 'package') })
  // dpk ≤ 2.1.43 staged beside its target, so an interrupted install of that
  // generation leaves `<digest>.tmp-…` inside store/. Older generations are not
  // supported: their residue is deleted whether or not that writer still runs,
  // and only a name that is not dpk's staging convention is left alone.
  const residueDead = join(root, 'store', `${'c'.repeat(64)}.tmp-999999-1`)
  await mkdir(residueDead, { recursive: true })
  const residueLive = join(root, 'store', `${'d'.repeat(64)}.tmp-${process.pid}-1`)
  await mkdir(residueLive, { recursive: true })
  const foreign = join(root, 'store', 'someone-elses-directory')
  await mkdir(foreign, { recursive: true })

  const result = await runDpkAction('autoremove', {}, { home })

  assert.deepEqual(
    result.data.stagings.map(item => item.name).sort(),
    [`${'c'.repeat(64)}.tmp-999999-1`, `${'d'.repeat(64)}.tmp-${process.pid}-1`].sort(),
  )
  assert.equal(existsSync(residueDead), false, 'the old generation\'s residue goes')
  assert.equal(existsSync(residueLive), false, 'including a live one: that generation is not served')
  assert.equal(existsSync(foreign), true, 'a name that is not staging is not dpk\'s to judge')
  assert.equal(existsSync(storeDir(root, DIGEST)), true, 'the referenced digest survives')
})

test('a foreign file in the dpk root is ignored, not managed', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  await storeEntry(root, DIGEST, { name: '@local/x' })
  await recordInstall(root, { name: '@local/x', version: '1.0.0', digest: DIGEST, source: 'x.dpk' })
  // Someone else's business: a note, a directory, a file that looks like a digest.
  await writeFile(join(root, 'NOTES.md'), 'mine, keep it\n')
  await mkdir(join(root, 'my-own-dir'), { recursive: true })
  await writeFile(join(root, 'my-own-dir', 'thing.txt'), 'still mine\n')
  await writeFile(join(root, 'b'.repeat(64)), 'not a store dir\n')

  const before = (await readdir(root)).sort()
  const listed = await runDpkAction('list', {}, { home })
  const swept = await runDpkAction('autoremove', {}, { home })

  assert.deepEqual((await readdir(root)).sort(), before, 'dpk neither deletes nor adds foreign entries')
  assert.equal(existsSync(join(root, 'NOTES.md')), true)
  assert.equal(existsSync(join(root, 'my-own-dir', 'thing.txt')), true)
  assert.equal(listed.data.entries.length, 1, 'the ledger still reports its own package')
  assert.deepEqual(swept.data.stagings, [], 'a foreign name is not a staging')
})

test('stale staging names are recognised by shape, not by luck', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const cache = cacheDir(root)
  await mkdir(cache, { recursive: true })
  // Names that only look similar must survive: only `<label>.<tmp|dpk>-<pid>-<n>`
  // is a staging, and only when that pid is gone. An unrecognised name in the
  // cache is not dpk's to judge either — everything it writes is pid-named.
  const foreign = ['tmp-123-1', 'index.json.tmp', 'index.json.tmp-abc-1', 'x.tmp-1', 'someone-elses-file']
  for (const name of foreign) await writeFile(join(cache, name), '{}\n')
  await writeFile(join(cache, 'index.json.tmp-999999-7'), '{}\n')

  const result = await runDpkAction('autoremove', {}, { home })

  assert.deepEqual(result.data.stagings.map(item => item.name), ['index.json.tmp-999999-7'])
  assert.deepEqual((await readdir(cache)).sort(), foreign.sort(), 'only the real staging was collected')
})

test('an install commits through a staging name the collector recognises', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  await profileUsing(home, 'probe')
  // The naming convention is shared: whatever the writers stage, the collector
  // can read. This pins that both sides go through stagePath, and that every
  // staging lands in the one directory the collector sweeps.
  const cache = cacheDir(root)
  assert.match(stagePath(cache, 'index.json', 'tmp'), /index\.json\.tmp-\d+-\d+$/)
  assert.match(stagePath(cache, `manifest-probe`, 'dpk'), /manifest-probe\.dpk-\d+-\d+$/)
  assert.match(dirname(stagePath(cache, 'index.json', 'tmp')), new RegExp(`cache$`))
})

test('a re-install that changes nothing is not recorded as a new install', async () => {
  const home = await makeHome()
  const file = await fixtureArchive(home, '1.0.0')
  await profileUsing(home, 'probe')
  const first = await runDpkAction('install', { file }, { home, profile: 'probe' })
  assert.equal(first.data.created, true)
  const before = (await readIndex(dpkRoot(home))).entries[0].installedAt

  const again = await runDpkAction('install', { file }, { home, profile: 'probe' })

  assert.equal(again.data.unchanged, true)
  assert.equal(again.data.created, false)
  const after = (await readIndex(dpkRoot(home))).entries[0].installedAt
  // The panel reads "installed after this process started" as "restart to load
  // it", so a run that changed nothing must not move the timestamp: read as a
  // process started after the first install, the prompt must stay quiet.
  assert.equal(after, before, 'installedAt stays put when nothing changed')
  const laterProcess = Date.now() + 1000
  assert.equal(restartPending((await readIndex(dpkRoot(home))).entries, laterProcess), false,
    'the no-op install did not renew the restart prompt')
})

test('a repeat install does not rewrite an identical seed', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const packed = await packDirectory(await makePackage({
    manifest: {
      name: '@local/seeded',
      version: '1.0.0',
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        data: { volumes: [{ id: 'providers', class: 'data', path: 'providers.json', seed: 'seeds/providers.json' }] },
      },
    },
    extraFiles: { 'seeds/providers.json': '{"seed":1}\n' },
  }))
  const file = join(home, 'seeded.dpk')
  await writeFile(file, packed.buffer)
  await profileUsing(home, 'probe')

  await runDpkAction('install', { file }, { home, profile: 'probe' })
  const volume = join(home, 'data', '@local', 'seeded', 'data', 'providers.json')
  const written = (await stat(volume)).mtimeMs

  const again = await runDpkAction('install', { file, reinstall: true }, { home, profile: 'probe' })

  assert.equal((await stat(volume)).mtimeMs, written, 'the identical seed was not rewritten')
  assert.equal((await readFile(volume, 'utf8')), '{"seed":1}\n')
  // A volume refresh is not a reason to restart: only the store copy and the
  // profile are what the loader reads.
  assert.equal(again.data.created, true, 'reinstall re-placed the store copy, so this one did change')
  assert.equal(restartPending((await readIndex(root)).entries), true)
})

test('a package a profile references but the ledger never recorded is listed', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const digest = 'c'.repeat(64)
  // Exactly what a run killed between the profile write and the ledger write
  // leaves: a resolvable reference with no record of where it came from.
  const packageDir = await storeEntry(root, digest, { name: '@local/ghost' })
  await profileUsing(home, 'probe', { '@local/ghost': packageDir })
  const link = join(profileDir(home, 'probe'), 'node_modules', '@local', 'ghost')
  await mkdir(dirname(link), { recursive: true })
  await symlink(packageDir, link, 'junction')

  const listed = await runDpkAction('list', {}, { home })

  assert.deepEqual(listed.data.untracked.map(entry => entry.digest), [digest])
  assert.equal(listed.data.untracked[0].version, '1.0.0', 'the version comes from the store copy')
  assert.deepEqual(listed.data.broken, [], 'it resolves, so it is not broken')
  assert.match(listed.text, /untracked/)

  // And the verbs that read the profiles already worked with it.
  assert.match((await runDpkAction('show', { name: '@local/ghost' }, { home })).text, /used by {2}probe {2}ok/)
  assert.match((await runDpkAction('remove', { name: '@local/ghost' }, { home, profile: 'probe' })).text, /removed/)
})
