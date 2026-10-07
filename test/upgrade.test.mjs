/**
 * apt 生命周期的两环:`update`(报告有什么可用)与 `upgrade`(装上去)。
 *
 * 两类包共用这套生命周期,但各自的"上游"不同:registry 包(官方插件页装的那类)
 * 问 npm —— 通过官方管理器的 inspect/installBundle;`.dpk` 文件包问它来源所在的
 * 目录。这里同时钉住"报告的就是会发生的":`update` 的计划要等于 `upgrade` 真跑的结果。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runDpkAction } from '../src/lib/cli.mjs'
import { packDirectory } from '../src/lib/pack.mjs'
import { readZipIndex } from '../src/lib/zip.mjs'
import { dpkRoot, readIndex, recordInstall, storeDir } from '../src/lib/store.mjs'
import { linkSpecifier, profileDir, readProfileManifest } from '../src/lib/profile-install.mjs'
import { archiveCopies, makeHome, makePackage, profileUsing, storeEntry } from './helpers.mjs'

/** A scratch source directory holding one version of the fixture package. */
async function sourceWith(home, versions) {
  const directory = join(home, 'sources')
  await mkdir(directory, { recursive: true })
  const built = []
  for (const version of versions) {
    const packed = await packDirectory(await makePackage({ manifest: { name: '@local/dpk-fixture', version } }))
    const file = join(directory, `${packed.manifest.name.replace(/^@[^/]+\//, '')}-${version}.dpk`)
    await writeFile(file, packed.buffer)
    built.push({ version, file, digest: packed.manifest.integrity.digest })
  }
  return { directory, built }
}

/** Install one version into a profile, the way a user would. */
async function installVersion(home, file, profile = 'probe') {
  await profileUsing(home, profile)
  return await runDpkAction('install', { file }, { home, profile })
}

test('update reports no upgrade when the newest .dpk is what is installed', async () => {
  const home = await makeHome()
  const { built } = await sourceWith(home, ['1.0.0'])
  await installVersion(home, built[0].file)

  const result = await runDpkAction('update', {}, { home })

  assert.equal(result.data.upgradable, 0)
  assert.equal(result.data.plan.length, 1)
  assert.equal(result.data.plan[0].current, '1.0.0')
  assert.equal(result.data.plan[0].upgrade, false)
  assert.match(result.text, /already newest/)
  assert.match(result.text, /nothing to upgrade/)
})

test('update finds a newer .dpk in the directory the package came from', async () => {
  const home = await makeHome()
  const { built } = await sourceWith(home, ['1.0.0', '1.1.0'])
  await installVersion(home, built[0].file)

  const result = await runDpkAction('update', {}, { home })

  assert.equal(result.data.upgradable, 1)
  assert.deepEqual(
    { current: result.data.plan[0].current, available: result.data.plan[0].available },
    { current: '1.0.0', available: '1.1.0' },
  )
  assert.equal(result.data.plan[0].file, built[1].file)
  assert.match(result.text, /@local\/dpk-fixture {2}1\.0\.0 -> 1\.1\.0/)
})

test('upgrade installs the newer version into every profile that had the old one', async () => {
  const home = await makeHome()
  const { built } = await sourceWith(home, ['1.0.0', '2.0.0'])
  await installVersion(home, built[0].file, 'probe')
  await installVersion(home, built[0].file, 'web')
  const oldDigest = built[0].digest

  const result = await runDpkAction('upgrade', {}, { home })

  assert.equal(result.data.upgraded.length, 2, 'one install per profile')
  assert.deepEqual(result.data.upgraded.map(row => row.profile).sort(), ['probe', 'web'])
  for (const profile of ['probe', 'web']) {
    const manifest = await readProfileManifest(profileDir(home, profile))
    assert.equal(manifest.dependencies['@local/dpk-fixture'], linkSpecifier(join(storeDir(dpkRoot(home), built[1].digest), 'package')))
  }
  assert.equal(existsSync(storeDir(dpkRoot(home), built[1].digest)), true)
  assert.equal(existsSync(storeDir(dpkRoot(home), oldDigest)), false, 'the replaced copy is reclaimed')
  const ledger = await readIndex(dpkRoot(home))
  assert.deepEqual(ledger.entries.filter(entry => entry.version === '2.0.0').length, 1, 'the ledger keys on identity')

  // And a second pass finds nothing left to do.
  assert.equal((await runDpkAction('update', {}, { home })).data.upgradable, 0)
})

test('update scans a directory the caller names, and tolerates junk in it', async () => {
  const home = await makeHome()
  const { built } = await sourceWith(home, ['1.0.0'])
  await installVersion(home, built[0].file)
  const elsewhere = join(home, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })
  const newer = await packDirectory(await makePackage({ manifest: { name: '@local/dpk-fixture', version: '3.0.0' } }))
  await writeFile(join(elsewhere, 'newer.dpk'), newer.buffer)
  await writeFile(join(elsewhere, 'broken.dpk'), 'not a zip at all\n')

  const result = await runDpkAction('update', { directory: elsewhere }, { home })

  assert.equal(result.data.upgradable, 1)
  assert.equal(result.data.plan[0].available, '3.0.0')
  assert.equal(result.data.warnings.length, 1, 'the unreadable file is a warning, not a failure')
  assert.match(result.data.warnings[0], /broken\.dpk: not a readable \.dpk/)
})

test('an upgrade keeps no copy of the archives it consumed', async () => {
  const home = await makeHome()
  const { built } = await sourceWith(home, ['1.0.0', '1.1.0'])
  await installVersion(home, built[0].file)

  await runDpkAction('upgrade', {}, { home })

  // Neither the replaced 1.0.0 archive nor the 1.1.0 one dpk just consumed is
  // kept: the files stay in the source directory they were built in, and the
  // replaced store copy is reclaimed.
  assert.deepEqual(await archiveCopies(dpkRoot(home), built[0].digest), [], 'no copy of the replaced archive')
  assert.deepEqual(await archiveCopies(dpkRoot(home), built[1].digest), [], 'no copy of the new archive')
  assert.equal((await readdir(join(dpkRoot(home), 'store'))).length, 1)
})

test('an upgrade reports the version it moved to, for a .dpk too', async () => {
  const home = await makeHome()
  const { built } = await sourceWith(home, ['1.0.0', '1.1.0'])
  await installVersion(home, built[0].file)

  const result = await runDpkAction('upgrade', {}, { home })

  // installArchive answers with the manifest, not a bare version: reading it as
  // `result.version` printed "1.0.0 -> undefined" for every file upgrade.
  assert.match(result.text, /upgraded @local\/dpk-fixture {2}1\.0\.0 -> 1\.1\.0 {2}in probe/)
  assert.equal(result.data.upgraded[0].to, '1.1.0')
})

test('an upgrade reclaims only the digest it displaced, never an unrelated one', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const { built } = await sourceWith(home, ['1.0.0', '1.1.0'])
  await installVersion(home, built[0].file)
  // A package in the ledger that no profile references: garbage only
  // `autoremove` may collect, and none of this upgrade's business.
  const unrelated = await storeEntry(root, 'b'.repeat(64), { manifest: { name: '@local/unrelated', version: '9.9.9' } })
  await recordInstall(root, { name: '@local/unrelated', version: '9.9.9', digest: 'b'.repeat(64), source: 'C:/gone/unrelated.dpk' })

  const result = await runDpkAction('upgrade', {}, { home })

  assert.equal(existsSync(storeDir(root, built[0].digest)), false, 'the replaced copy goes')
  assert.equal(existsSync(unrelated), true, 'an unrelated unreferenced copy is not this verb\'s to delete')
  assert.deepEqual(result.data.reclaimed, [built[0].digest])
  assert.match(result.text, /reclaimed 1 displaced digest\(s\)/)
})

test('a profile with a broken manifest still protects the copy its link resolves', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const { built } = await sourceWith(home, ['1.0.0', '1.1.0'])
  await installVersion(home, built[0].file)
  // A second profile holding the same version, whose manifest was then damaged
  // by hand. dpk cannot rewrite that profile (writing it needs to read it), so
  // its own upgrade fails — but its `node_modules` link still points at the
  // store, and that link, not the manifest, is what the Harness resolves.
  await installVersion(home, built[0].file, 'broken')
  await writeFile(join(profileDir(home, 'broken'), 'package.json'), '{ this is not json')

  const result = await runDpkAction('upgrade', {}, { home })

  assert.equal(result.data.upgraded.length, 1, 'the readable profile moved')
  assert.equal(result.data.failed.length, 1, 'the unreadable one reports why it could not')
  assert.match(result.data.failed[0].error, /no readable package\.json/)
  assert.equal(existsSync(storeDir(root, built[0].digest)), true, 'a copy the broken profile still links is never collected')
  assert.deepEqual(result.data.reclaimed, [])
  assert.match(result.text, /kept {5}1 displaced digest\(s\): a profile still references the stored copy/)
})

test('an unparseable manifest no longer blocks collecting what nothing links to', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const { built } = await sourceWith(home, ['1.0.0', '1.1.0'])
  await installVersion(home, built[0].file)
  // An unrelated digest, referenced by nothing, plus a profile directory whose
  // manifest cannot be parsed and which links nothing. The damaged manifest is
  // not a reason to leave the garbage behind: its links say what it resolves.
  const unrelated = await storeEntry(root, 'b'.repeat(64), { manifest: { name: '@local/unrelated', version: '9.9.9' } })
  await recordInstall(root, { name: '@local/unrelated', version: '9.9.9', digest: 'b'.repeat(64), source: 'C:/gone/unrelated.dpk' })
  await mkdir(join(home, 'profiles', 'broken'), { recursive: true })
  await writeFile(join(home, 'profiles', 'broken', 'package.json'), '{ this is not json')

  const result = await runDpkAction('upgrade', {}, { home })

  assert.equal(existsSync(storeDir(root, built[0].digest)), false, 'the displaced copy is collected')
  assert.deepEqual(result.data.reclaimed, [built[0].digest])
  assert.equal(existsSync(unrelated), true, 'the unrelated copy is still autoremove\'s business')
})

test('upgrading every profile that held the old version leaves no copy behind', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const { built } = await sourceWith(home, ['1.0.0', '1.1.0'])
  await installVersion(home, built[0].file, 'probe')
  await installVersion(home, built[0].file, 'web')

  const result = await runDpkAction('upgrade', {}, { home })

  assert.equal(result.data.upgraded.length, 2)
  assert.equal(existsSync(storeDir(root, built[0].digest)), false, 'the previous orphan is gone once its last holder moved on')
  assert.deepEqual(result.data.reclaimed, [built[0].digest])
  // The store holds exactly what the profiles resolve, and nothing else: no
  // orphaned directory, and no provenance row for a copy that no longer exists.
  assert.deepEqual(await readdir(join(root, 'store')), [built[1].digest])
  assert.deepEqual((await readIndex(root)).entries.map(entry => entry.digest), [built[1].digest])
})

test('a failed upgrade changes nothing: the previous version keeps working', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const { built } = await sourceWith(home, ['1.0.0'])
  await installVersion(home, built[0].file)
  const profileBefore = await readFile(join(profileDir(home, 'probe'), 'package.json'), 'utf8')
  // A newer version whose declaration passes pack and verify but cannot be
  // materialised. The store copy is placed first, the volumes next, and the
  // profile — the commit point the loader reads — last: so this failure has to
  // leave the profile, the volumes and the store exactly as they were, rather
  // than a profile pointing at a version whose declared files were never placed.
  const oversized = Array.from({ length: 17000 }, (unused, index) => createHash('sha256').update(String(index)).digest('hex')).join('')
  const packed = await packDirectory(await makePackage({
    manifest: {
      name: '@local/dpk-fixture',
      version: '1.1.0',
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        data: {
          volumes: [
            { id: 'good', class: 'data', path: 'good.json', seed: 'seeds/good.json' },
            { id: 'huge', class: 'data', path: 'huge.json', seed: 'seeds/huge.json' },
          ],
        },
      },
    },
    extraFiles: { 'seeds/good.json': '{"v":1}\n', 'seeds/huge.json': oversized },
  }))
  await writeFile(join(home, 'sources', 'dpk-fixture-1.1.0.dpk'), packed.buffer)

  const result = await runDpkAction('upgrade', {}, { home })

  assert.match(result.text, /failed {3}@local\/dpk-fixture {2}1\.0\.0 -> 1\.1\.0: volume huge: seed exceeds/)
  assert.equal(await readFile(join(profileDir(home, 'probe'), 'package.json'), 'utf8'), profileBefore, 'the profile is untouched')
  // Pass 1 of the volume materialisation validates every declaration before
  // pass 2 writes any of them, so the good volume is not seeded by a run that
  // then failed on the next one.
  assert.equal(existsSync(join(home, 'data', '@local', 'dpk-fixture')), false, 'no volume was written')
  assert.equal(existsSync(storeDir(root, built[0].digest)), true, 'the version the profile still resolves survives')
  assert.equal(existsSync(storeDir(root, packed.manifest.integrity.digest)), false, 'the copy this failed install placed is gone')
  assert.deepEqual(await readdir(join(root, 'store')), [built[0].digest])
  assert.deepEqual(result.data.reclaimed, [])
})

test('a failed upgrade keeps a copy a profile still resolves', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const { built } = await sourceWith(home, ['1.0.0', '1.1.0'])
  await installVersion(home, built[0].file)
  // The archive's manifest reads (so `update` offers it) but its content does
  // not: the install fails before the profile is repointed, so the old copy is
  // still what this profile loads and must survive the reclaim candidate list.
  const tampered = Buffer.from(await readFile(built[1].file))
  const entry = readZipIndex(tampered).entries.find(candidate => candidate.path === 'package/index.js')
  tampered[entry.localOffset + 30 + Buffer.byteLength(entry.path)] ^= 0xff
  await writeFile(built[1].file, tampered)

  const result = await runDpkAction('upgrade', {}, { home })

  assert.match(result.text, /failed {3}@local\/dpk-fixture/)
  assert.equal(existsSync(storeDir(root, built[0].digest)), true, 'a copy a profile still resolves is never collected')
  assert.match(result.text, /kept {5}1 displaced digest\(s\): a profile still references the stored copy/)
  assert.deepEqual(result.data.reclaimed, [])
})

test('show names the data volumes an installed package declares', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const packageDir = join(storeDir(root, 'd'.repeat(64)), 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@local/x',
    version: '1.0.0',
    dsh: { data: { volumes: [{ id: 'providers', class: 'data', path: 'providers.json' }] } },
  })}\n`)
  const { recordInstall } = await import('../src/lib/store.mjs')
  await recordInstall(root, { name: '@local/x', version: '1.0.0', digest: 'd'.repeat(64), source: 'x.dpk' })
  await profileUsing(home, 'probe', { '@local/x': packageDir })
  const link = join(profileDir(home, 'probe'), 'node_modules', '@local', 'x')
  await mkdir(dirname(link), { recursive: true })
  await symlink(packageDir, link, 'junction')
  const volume = join(home, 'data', '@local', 'x', 'data', 'providers.json')
  await mkdir(dirname(volume), { recursive: true })
  await writeFile(volume, '{}\n')

  const result = await runDpkAction('show', { name: '@local/x' }, { home })

  assert.deepEqual(result.data.volumes.map(item => [item.id, item.class, item.exists]), [['providers', 'data', true]])
  assert.match(await readFile(volume, 'utf8'), /\{\}/)
})

test('update asks the npm registry about packages no local .dpk answers for', async () => {
  const home = await makeHome()
  const { built } = await sourceWith(home, ['1.0.0'])
  await installVersion(home, built[0].file, 'probe')
  // A second package whose source directory is gone: it has no local candidate,
  // so it is the one that goes to the registry.
  const root = dpkRoot(home)
  const other = await storeEntry(root, 'c'.repeat(64), { manifest: { name: '@local/npm-pkg', version: '0.3.0' } })
  const { recordInstall } = await import('../src/lib/store.mjs')
  await recordInstall(root, { name: '@local/npm-pkg', version: '0.3.0', digest: 'c'.repeat(64), source: 'C:/gone/npm-pkg-0.3.0.dpk' })
  await profileUsing(home, 'probe', { '@local/npm-pkg': other, 'npm-pkg': '^0.3.0', '@local/dpk-fixture': join(storeDir(root, built[0].digest), 'package') })
  const asked = []
  const view = async (profile, name) => {
    asked.push(`${profile}:${name}`)
    return name === 'npm-pkg' ? { version: '0.4.0' } : null
  }

  const result = await runDpkAction('update', { directory: join(home, 'sources') }, { home, view })

  assert.deepEqual(asked, ['probe:npm-pkg'], 'only the package without a local candidate is asked, once')
  const row = result.data.plan.find(entry => entry.name === '@local/npm-pkg')
  assert.equal(row.from, 'registry')
  assert.deepEqual({ current: row.current, available: row.available, upgrade: row.upgrade }, { current: '0.3.0', available: '0.4.0', upgrade: true })
  const fixtureRow = result.data.plan.find(entry => entry.name === '@local/dpk-fixture')
  assert.equal(fixtureRow.from, 'file', 'a package with a local candidate never asks the registry')
  assert.equal(fixtureRow.upgrade, false)
})

test('update without a registry view still reports, and says the registry side was unavailable', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const other = await storeEntry(root, 'c'.repeat(64), { manifest: { name: '@local/npm-pkg', version: '0.3.0' } })
  const { recordInstall } = await import('../src/lib/store.mjs')
  await recordInstall(root, { name: '@local/npm-pkg', version: '0.3.0', digest: 'c'.repeat(64), source: 'C:/gone/x.dpk' })
  await profileUsing(home, 'probe', { '@local/npm-pkg': other, 'npm-pkg': '^0.3.0' })

  const result = await runDpkAction('update', {}, { home })

  const row = result.data.plan.find(entry => entry.name === '@local/npm-pkg')
  assert.deepEqual({ available: row.available, upgrade: row.upgrade }, { available: null, upgrade: false })
  assert.match(result.text, /no newer version found \(registry unavailable\)/)
})

test('upgrade installs registry packages one by one through the official manager', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const other = await storeEntry(root, 'c'.repeat(64), { manifest: { name: '@local/npm-pkg', version: '0.3.0' } })
  const { recordInstall } = await import('../src/lib/store.mjs')
  await recordInstall(root, { name: '@local/npm-pkg', version: '0.3.0', digest: 'c'.repeat(64), source: 'C:/gone/x.dpk' })
  await profileUsing(home, 'probe', { '@local/npm-pkg': other, 'npm-pkg': '^0.3.0' })
  const calls = []
  const view = async (_profile, name) => (name === 'npm-pkg' ? { version: '0.4.0' } : null)
  const registryInstaller = async (spec) => {
    calls.push(spec)
    return { application: 'applied', changed: true }
  }
  const context = { home, profile: 'probe', view, registryInstaller }

  const result = await runDpkAction('upgrade', {}, context)

  // One install call per package, with the un-scoped registry name and the
  // exact available version: the official manager resolves and runs pnpm.
  assert.deepEqual(calls, ['npm-pkg@0.4.0'])
  assert.match(result.text, /upgraded @local\/npm-pkg {2}0\.3\.0 -> 0\.4\.0 {2}in probe {2}\(npm\)/)
  assert.equal(result.data.upgraded.length, 1)
})

test('a registry upgrade opts the profile out of the release-age cooldown first', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const other = await storeEntry(root, 'c'.repeat(64), { manifest: { name: '@local/npm-pkg', version: '0.3.0' } })
  const { recordInstall } = await import('../src/lib/store.mjs')
  await recordInstall(root, { name: '@local/npm-pkg', version: '0.3.0', digest: 'c'.repeat(64), source: 'C:/gone/x.dpk' })
  await profileUsing(home, 'probe', { '@local/npm-pkg': other, 'npm-pkg': '^0.3.0' })
  const order = []
  const context = {
    home,
    profile: 'probe',
    view: async () => ({ version: '0.4.0' }),
    registryInstaller: async () => { order.push('install'); return { application: 'applied', changed: true } },
    beforeRegistryUpgrade: profile => { order.push(`policy:${profile}`) },
  }

  await runDpkAction('upgrade', {}, context)

  assert.deepEqual(order, ['policy:probe', 'install'], 'the cooldown opt-out is written before pnpm runs')
})

test('a failing registry upgrade is reported per package and does not stop the rest', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const first = await storeEntry(root, 'c'.repeat(64), { manifest: { name: '@local/npm-a', version: '1.0.0' } })
  const second = await storeEntry(root, 'd'.repeat(64), { manifest: { name: '@local/npm-b', version: '1.0.0' } })
  const { recordInstall } = await import('../src/lib/store.mjs')
  await recordInstall(root, { name: '@local/npm-a', version: '1.0.0', digest: 'c'.repeat(64), source: 'C:/gone/a.dpk' })
  await recordInstall(root, { name: '@local/npm-b', version: '1.0.0', digest: 'd'.repeat(64), source: 'C:/gone/b.dpk' })
  await profileUsing(home, 'probe', { '@local/npm-a': first, '@local/npm-b': second, 'npm-a': '^1.0.0', 'npm-b': '^1.0.0' })
  const context = {
    home,
    profile: 'probe',
    view: async () => ({ version: '2.0.0' }),
    registryInstaller: async (spec) => {
      if (spec.startsWith('npm-a@')) return { application: 'failed', error: { diagnostic: 'registry unreachable' } }
      return { application: 'applied', changed: true }
    },
  }

  const result = await runDpkAction('upgrade', {}, context)

  assert.equal(result.data.failed.length, 1)
  assert.match(result.data.failed[0].error, /registry unreachable/)
  assert.equal(result.data.upgraded.length, 1, 'the second package still upgraded')
  assert.match(result.text, /failed {3}@local\/npm-a/)
  assert.match(result.text, /upgraded @local\/npm-b/)
})

test('a registry upgrade without the manager service fails that package with the exact hand-off', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const other = await storeEntry(root, 'c'.repeat(64), { manifest: { name: '@local/npm-pkg', version: '0.3.0' } })
  const { recordInstall } = await import('../src/lib/store.mjs')
  await recordInstall(root, { name: '@local/npm-pkg', version: '0.3.0', digest: 'c'.repeat(64), source: 'C:/gone/x.dpk' })
  await profileUsing(home, 'probe', { '@local/npm-pkg': other, 'npm-pkg': '^0.3.0' })

  const result = await runDpkAction('upgrade', {}, { home, profile: 'probe', view: async () => ({ version: '0.4.0' }) })

  assert.equal(result.data.failed.length, 1)
  assert.match(result.data.failed[0].error, /plugin manager service is not composed/)
})

test('update sees packages the official Plugins page installed, and upgrade updates them in place', async () => {
  const home = await makeHome()
  // The official page writes a registry-spec row (^version, no link:) and
  // installs into the profile's own node_modules — no dpk digest anywhere.
  const dir = await profileUsing(home, 'probe', { 'official-plugin': '^0.1.5' })
  const installed = join(dir, 'node_modules', 'official-plugin')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'official-plugin', version: '0.1.5' }))
  const view = async (_profile, name) => (name === 'official-plugin' ? { version: '0.2.0' } : null)

  const upd = await runDpkAction('update', {}, { home, view })

  const row = upd.data.plan.find(entry => entry.name === 'official-plugin')
  assert.notEqual(row, undefined, 'the registry row is in the plan at all')
  assert.deepEqual(
    { from: row.from, current: row.current, available: row.available, upgrade: row.upgrade },
    { from: 'registry', current: '0.1.5', available: '0.2.0', upgrade: true },
  )
  assert.match(upd.text, /official-plugin {2}0\.1\.5 -> 0\.2\.0 {2}\[probe\] {2}\(npm\)/)

  // upgrade goes through the official installer with name@available, and the
  // profile's own copy moves to the new version — the store is untouched
  // (there is no digest to place).
  const calls = []
  const result = await runDpkAction('upgrade', {}, {
    home,
    profile: 'probe',
    view,
    registryInstaller: async (spec) => {
      calls.push(spec)
      await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'official-plugin', version: '0.2.0' }))
      return { application: 'applied', changed: true }
    },
  })

  assert.deepEqual(calls, ['official-plugin@0.2.0'])
  assert.match(result.text, /upgraded official-plugin {2}0\.1\.5 -> 0\.2\.0 {2}in probe {2}\(npm\)/)
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, '0.2.0')
  assert.equal((await runDpkAction('update', {}, { home, view })).data.upgradable, 0)
})

test('a registry row still satisfying its range is reported as already newest', async () => {
  const home = await makeHome()
  await profileUsing(home, 'probe', { 'official-plugin': '^0.1.5' })
  const view = async () => ({ version: '0.1.9' })

  const result = await runDpkAction('update', {}, { home, view })

  const row = result.data.plan.find(entry => entry.name === 'official-plugin')
  assert.deepEqual(row.upgrade, false, '0.1.9 satisfies ^0.1.5: nothing to do until the profile asks for more')
  assert.match(result.text, /already newest/)
})

test('update ignores link: and file: rows when collecting registry rows', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const packageDir = await storeEntry(root, 'e'.repeat(64), { name: '@local/local-one' })
  // A link: row (dpk's own) and a file: row (never a registry dependency):
  // neither may reach the registry, whatever view is wired.
  await profileUsing(home, 'probe', { '@local/local-one': packageDir })
  await writeFile(join(profileDir(home, 'probe'), 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-probe',
    private: true,
    dependencies: {
      '@local/local-one': `link:${packageDir}`,
      somewhere: 'file:C:/elsewhere',
    },
    dsh: { profile: { bundles: [] } },
  }, undefined, 2)}\n`)
  const asked = []
  const result = await runDpkAction('update', {}, { home, view: async (_p, name) => { asked.push(name); return null } })

  assert.deepEqual(asked, [], 'neither row is a registry dependency')
  assert.equal(result.data.plan.length, 1, 'only the link: row forms the digest plan')
  assert.deepEqual(result.data.plan[0].from, 'file')
})
