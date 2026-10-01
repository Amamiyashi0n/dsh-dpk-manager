/** Managed data volumes (SPEC §13): declaration validation, dpkg-style install/upgrade semantics, purge, and config export/import. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packDirectory } from '../lib/pack.mjs'
import { installArchive } from '../lib/install.mjs'
import {
  parseDataDeclaration, dataRoot, volumePath, materializeVolumes,
  describeVolumes, purgeVolumes, exportConfigVolumes, importConfigVolumes,
} from '../lib/data.mjs'
import { makeHome, makePackage } from './helpers.mjs'

const VOLUMES = declaration => parseDataDeclaration({ volumes: declaration })

/** A package that declares the canonical three-class volume set. */
async function makeManagedPackage(overrides = {}) {
  const root = await makePackage({
    manifest: {
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        data: {
          volumes: overrides.volumes ?? [
            { id: 'providers', class: 'config', path: 'providers.json', seed: 'seeds/providers.json' },
            { id: 'prompts', class: 'config', path: 'prompt-overrides.json', seed: 'seeds/prompts.json' },
            { id: 'credentials', class: 'state', path: 'credentials.json' },
            { id: 'telemetry', class: 'state', path: 'telemetry-state.json' },
            { id: 'captcha', class: 'cache', path: 'captcha-profile/cookies' },
          ],
        },
      },
      version: overrides.version ?? '1.0.0',
    },
    extraFiles: {
      'seeds/providers.json': '{"provider":{}}\n',
      'seeds/prompts.json': '{}\n',
      ...(overrides.extraFiles ?? {}),
    },
  })
  return root
}

test('validates the declaration strictly', () => {
  assert.deepEqual(
    parseDataDeclaration(undefined),
    [],
    'an absent declaration is no volumes',
  )
  assert.equal(parseDataDeclaration({ volumes: [] }).length, 0)
  assert.equal(
    VOLUMES([{ id: 'a', class: 'config', path: 'a.json' }])[0].path,
    'a.json',
  )
  for (const bad of [
    { id: 'A', class: 'config', path: 'a' }, // uppercase id
    { id: 'a', class: 'etc', path: 'a' }, // unknown class
    { id: 'a', class: 'config' }, // no path
    { id: 'a', class: 'config', path: '/abs' }, // absolute
    { id: 'a', class: 'config', path: '../escape' }, // traversal
    { id: 'a', class: 'config', path: 'C:/win' }, // drive letter
    { id: 'a', class: 'config', path: 'a', extra: 1 }, // unknown field
  ]) {
    assert.throws(() => VOLUMES([bad]), undefined, `rejects ${JSON.stringify(bad)}`)
  }
  assert.throws(() => VOLUMES([
    { id: 'a', class: 'config', path: 'x' },
    { id: 'a', class: 'state', path: 'y' }, // duplicate id
  ]))
  assert.throws(() => VOLUMES([
    { id: 'a', class: 'config', path: 'x' },
    { id: 'b', class: 'state', path: 'x' }, // duplicate path
  ]))
})

test('seeds config volumes on first install and leaves unseeded ones absent', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makeManagedPackage())
  const result = await installArchive({
    file: 'x.dpk', buffer: packed.buffer, home, profile: 'test',
    installer: async () => {}, log: () => {},
  })
  const root = dataRoot(home, '@local/dpk-fixture')
  assert.ok(existsSync(join(root, 'config', 'providers.json')), 'seeded config volume exists')
  assert.equal(await readFile(join(root, 'config', 'providers.json'), 'utf8'), '{"provider":{}}\n')
  assert.ok(!existsSync(join(root, 'state', 'credentials.json')), 'unseeded state volume is NOT created by install')
  const byId = new Map(result.volumes.map(volume => [volume.id, volume]))
  assert.equal(byId.get('providers').action, 'seeded')
  assert.equal(byId.get('credentials').action, 'declared')
})

test('upgrade refreshes an unmodified seed and keeps a user-modified one (dpkg conffile rule)', async () => {
  const home = await makeHome()
  const v1 = await packDirectory(await makeManagedPackage({ version: '1.0.0' }))
  await installArchive({ file: 'a.dpk', buffer: v1.buffer, home, profile: 'test', installer: async () => {}, log: () => {} })

  // User edits providers.json after install; prompts.json stays pristine.
  const providers = join(dataRoot(home, '@local/dpk-fixture'), 'config', 'providers.json')
  await writeFile(providers, '{"provider":{},"edited":true}\n')

  const v2 = await packDirectory(await makeManagedPackage({
    version: '2.0.0',
    extraFiles: {
      'seeds/providers.json': '{"provider":{},"v2":true}\n',
      'seeds/prompts.json': '{"v2":true}\n',
    },
  }))
  const result = await installArchive({ file: 'b.dpk', buffer: v2.buffer, home, profile: 'test', installer: async () => {}, log: () => {} })
  const byId = new Map(result.volumes.map(volume => [volume.id, volume]))

  assert.equal(byId.get('providers').action, 'kept-local', 'the edited file is untouched')
  assert.equal(await readFile(providers, 'utf8'), '{"provider":{},"edited":true}\n')
  assert.ok(existsSync(`${providers}.dpk-new`), 'the new seed is staged beside it')
  assert.equal(await readFile(`${providers}.dpk-new`, 'utf8'), '{"provider":{},"v2":true}\n')

  assert.equal(byId.get('prompts').action, 'refreshed', 'the pristine seed is refreshed in place')
  const prompts = join(dataRoot(home, '@local/dpk-fixture'), 'config', 'prompt-overrides.json')
  assert.equal(await readFile(prompts, 'utf8'), '{"v2":true}\n')
})

test('re-installing the same digest never rewrites an edited file', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makeManagedPackage())
  await installArchive({ file: 'a.dpk', buffer: packed.buffer, home, profile: 'test', installer: async () => {}, log: () => {} })
  const providers = join(dataRoot(home, '@local/dpk-fixture'), 'config', 'providers.json')
  await writeFile(providers, '{"edited":true}\n')
  const second = await installArchive({ file: 'b.dpk', buffer: packed.buffer, home, profile: 'test', installer: async () => {}, log: () => {} })
  const byId = new Map(second.volumes.map(volume => [volume.id, volume]))
  assert.equal(byId.get('providers').action, 'kept-local')
  assert.equal(await readFile(providers, 'utf8'), '{"edited":true}\n')
})

test('a pre-management file is adopted, never overwritten', async () => {
  const home = await makeHome()
  const legacy = join(dataRoot(home, '@local/dpk-fixture'), 'config', 'providers.json')
  await mkdir(join(legacy, '..'), { recursive: true })
  await writeFile(legacy, '{"legacy":true}\n')
  const packed = await packDirectory(await makeManagedPackage())
  const result = await installArchive({ file: 'a.dpk', buffer: packed.buffer, home, profile: 'test', installer: async () => {}, log: () => {} })
  const byId = new Map(result.volumes.map(volume => [volume.id, volume]))
  assert.equal(byId.get('providers').action, 'adopted')
  assert.equal(await readFile(legacy, 'utf8'), '{"legacy":true}\n')
})

test('describeVolumes reports missing, seeded, user-owned, and pending states', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makeManagedPackage())
  // A real install unpacks the seeds into the store and materialises the
  // declared volumes; this test then only re-describes what happened.
  await installArchive({ file: 'a.dpk', buffer: packed.buffer, home, profile: 'test', installer: async () => {}, log: () => {} })
  const packageDir = join(home, 'dpk', 'store', packed.manifest.integrity.digest, 'package')
  const volumes = VOLUMES([
    { id: 'a', class: 'config', path: 'a.json', seed: 'seeds/providers.json' },
    { id: 'b', class: 'state', path: 'b.json' },
  ])
  let described = new Map((await describeVolumes(home, '@local/dpk-fixture', volumes, packageDir)).map(v => [v.id, v]))
  assert.equal(described.get('a').exists, false, 'declared but absent')

  await materializeVolumes(home, '@local/dpk-fixture', volumes, packageDir)
  described = new Map((await describeVolumes(home, '@local/dpk-fixture', volumes, packageDir)).map(v => [v.id, v]))
  assert.equal(described.get('a').seeded, true)
  assert.equal(described.get('b').seeded, undefined, 'unseeded volumes carry no seed state')

  await writeFile(volumePath(home, '@local/dpk-fixture', volumes[0]), '{"user":true}\n')
  await writeFile(`${volumePath(home, '@local/dpk-fixture', volumes[0])}.dpk-new`, '{"new":true}\n')
  described = new Map((await describeVolumes(home, '@local/dpk-fixture', volumes, packageDir)).map(v => [v.id, v]))
  assert.equal(described.get('a').seeded, false, 'marker digest no longer matches the file: user-owned')
  assert.ok(described.get('a').pendingSeed.endsWith('.dpk-new'))
})

test('purge deletes the whole data root; a second purge reports nothing to do', async () => {
  const home = await makeHome()
  const volumes = VOLUMES([{ id: 'a', class: 'state', path: 'deep/nested/a.json' }])
  const target = volumePath(home, '@local/dpk-fixture', volumes[0])
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, 'x')
  const first = await purgeVolumes(home, '@local/dpk-fixture')
  assert.equal(first.purged, true)
  assert.ok(!existsSync(dataRoot(home, '@local/dpk-fixture')))
  const second = await purgeVolumes(home, '@local/dpk-fixture')
  assert.equal(second.purged, false)
})

test('config export/import round-trips only config volumes, and imports never touch state', async () => {
  const home = await makeHome()
  const volumes = VOLUMES([
    { id: 'cfg', class: 'config', path: 'cfg.json' },
    { id: 'secret', class: 'state', path: 'secret.json' },
  ])
  const cfg = volumePath(home, '@local/dpk-fixture', volumes[0])
  const secret = volumePath(home, '@local/dpk-fixture', volumes[1])
  for (const [path, content] of [[cfg, '{"cfg":1}\n'], [secret, '{"secret":1}\n']]) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  const exported = await exportConfigVolumes(home, '@local/dpk-fixture', volumes)
  assert.equal(exported.length, 1)
  assert.equal(exported[0].path, 'config/cfg.json')

  const other = await makeHome()
  await importConfigVolumes(other, '@local/dpk-fixture', volumes, exported)
  assert.equal(await readFile(volumePath(other, '@local/dpk-fixture', volumes[0]), 'utf8'), '{"cfg":1}\n')
  assert.ok(!existsSync(volumePath(other, '@local/dpk-fixture', volumes[1])), 'state was not migrated')

  await assert.rejects(
    () => importConfigVolumes(other, '@local/dpk-fixture', volumes, [{ path: 'state/secret.json', bytes: Buffer.from('x') }]),
    /does not declare as config/,
    'an import carrying undeclared files is refused',
  )
})

test('pack refuses a volume whose seed is missing from the package', async () => {
  const root = await makePackage({
    manifest: {
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        data: { volumes: [{ id: 'a', class: 'config', path: 'a.json', seed: 'seeds/missing.json' }] },
      },
    },
  })
  await assert.rejects(() => packDirectory(root), /seed file does not exist/)
})

test('the manifest carries the declaration and verify still passes', async () => {
  const packed = await packDirectory(await makeManagedPackage())
  const strip = volume => Object.fromEntries(Object.entries(volume).filter(([, value]) => value !== undefined))
  assert.deepEqual(
    packed.manifest.data.volumes.map(strip),
    [
      { id: 'providers', class: 'config', path: 'providers.json', seed: 'seeds/providers.json' },
      { id: 'prompts', class: 'config', path: 'prompt-overrides.json', seed: 'seeds/prompts.json' },
      { id: 'credentials', class: 'state', path: 'credentials.json' },
      { id: 'telemetry', class: 'state', path: 'telemetry-state.json' },
      { id: 'captcha', class: 'cache', path: 'captcha-profile/cookies' },
    ],
  )
})
