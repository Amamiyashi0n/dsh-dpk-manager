/** Managed data volumes (SPEC §13): declaration validation, dpkg-style install/upgrade semantics, purge, and config export/import. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packDirectory } from '../lib/pack.mjs'
import { installArchive } from '../lib/install.mjs'
import { verifyArchive } from '../lib/verify.mjs'
import {
  parseDataDeclaration, dataRoot, volumePath, materializeVolumes,
  describeVolumes, purgeVolumes, exportVolumes, importDataVolumes,
} from '../lib/data.mjs'
import { makeHome, makePackage, snapshot } from './helpers.mjs'

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
            { id: 'providers', class: 'app', path: 'providers.json', seed: 'seeds/providers.json' },
            { id: 'prompts', class: 'app', path: 'prompt-overrides.json', seed: 'seeds/prompts.json' },
            { id: 'credentials', class: 'app', path: 'credentials.json' },
            { id: 'telemetry', class: 'app', path: 'telemetry-state.json' },
            { id: 'captcha', class: 'app', path: 'captcha-profile/cookies' },
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
    VOLUMES([{ id: 'a', class: 'data', path: 'a.json' }])[0].path,
    'a.json',
  )
  for (const bad of [
    { id: 'A', class: 'data', path: 'a' }, // uppercase id
    { id: 'a', class: 'etc', path: 'a' }, // unknown class
    { id: 'a', class: 'data' }, // no path
    { id: 'a', class: 'data', path: '/abs' }, // absolute
    { id: 'a', class: 'data', path: '../escape' }, // traversal
    { id: 'a', class: 'data', path: 'C:/win' }, // drive letter
    { id: 'a', class: 'data', path: 'a', extra: 1 }, // unknown field
  ]) {
    assert.throws(() => VOLUMES([bad]), undefined, `rejects ${JSON.stringify(bad)}`)
  }
  assert.throws(() => VOLUMES([
    { id: 'a', class: 'data', path: 'x' },
    { id: 'a', class: 'app', path: 'y' }, // duplicate id
  ]))
  assert.throws(() => VOLUMES([
    { id: 'a', class: 'data', path: 'x' },
    { id: 'b', class: 'data', path: 'x' }, // duplicate path
  ]))
  assert.throws(() => VOLUMES([
    { id: 'a', class: 'data', path: 'settings' },
    { id: 'b', class: 'data', path: 'settings/extra.json' }, // file/dir collision
  ]))
  assert.equal(VOLUMES([
    { id: 'a', class: 'data', path: 'settings' },
    { id: 'b', class: 'app', path: 'settings/extra.json' },
  ]).length, 2, 'different volume classes have separate roots')
})

test('seeds config volumes on first install and leaves unseeded ones absent', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makeManagedPackage())
  const result = await installArchive({
    file: 'x.dpk', buffer: packed.buffer, home, profile: 'test',
    installer: async () => {}, log: () => {},
  })
  const root = dataRoot(home, '@local/dpk-fixture')
  assert.ok(existsSync(join(root, 'app', 'providers.json')), 'seeded app volume exists')
  assert.equal(await readFile(join(root, 'app', 'providers.json'), 'utf8'), '{"provider":{}}\n')
  assert.ok(!existsSync(join(root, 'app', 'credentials.json')), 'unseeded state volume is NOT created by install')
  const byId = new Map(result.volumes.map(volume => [volume.id, volume]))
  assert.equal(byId.get('providers').action, 'seeded')
  assert.equal(byId.get('credentials').action, 'declared')
})

test('upgrade refreshes an unmodified seed and keeps a user-modified one (dpkg conffile rule)', async () => {
  const home = await makeHome()
  const v1 = await packDirectory(await makeManagedPackage({ version: '1.0.0' }))
  await installArchive({ file: 'a.dpk', buffer: v1.buffer, home, profile: 'test', installer: async () => {}, log: () => {} })

  // User edits providers.json after install; prompts.json stays pristine.
  const providers = join(dataRoot(home, '@local/dpk-fixture'), 'app', 'providers.json')
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
  const prompts = join(dataRoot(home, '@local/dpk-fixture'), 'app', 'prompt-overrides.json')
  assert.equal(await readFile(prompts, 'utf8'), '{"v2":true}\n')
})

test('re-installing the same digest never rewrites an edited file', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makeManagedPackage())
  await installArchive({ file: 'a.dpk', buffer: packed.buffer, home, profile: 'test', installer: async () => {}, log: () => {} })
  const providers = join(dataRoot(home, '@local/dpk-fixture'), 'app', 'providers.json')
  await writeFile(providers, '{"edited":true}\n')
  const second = await installArchive({ file: 'b.dpk', buffer: packed.buffer, home, profile: 'test', installer: async () => {}, log: () => {} })
  const byId = new Map(second.volumes.map(volume => [volume.id, volume]))
  assert.equal(byId.get('providers').action, 'kept-local')
  assert.equal(await readFile(providers, 'utf8'), '{"edited":true}\n')
})

test('a pre-management file is adopted, never overwritten', async () => {
  const home = await makeHome()
  const legacy = join(dataRoot(home, '@local/dpk-fixture'), 'app', 'providers.json')
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
    { id: 'a', class: 'data', path: 'a.json', seed: 'seeds/providers.json' },
    { id: 'b', class: 'app', path: 'b.json' },
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
  const volumes = VOLUMES([{ id: 'a', class: 'app', path: 'deep/nested/a.json' }])
  const target = volumePath(home, '@local/dpk-fixture', volumes[0])
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, 'x')
  const first = await purgeVolumes(home, '@local/dpk-fixture')
  assert.equal(first.purged, true)
  assert.ok(!existsSync(dataRoot(home, '@local/dpk-fixture')))
  const second = await purgeVolumes(home, '@local/dpk-fixture')
  assert.equal(second.purged, false)
})

test('the single-package export carries app volumes only, and imports land as user-owned', async () => {
  const home = await makeHome()
  const volumes = VOLUMES([
    { id: 'settings', class: 'data', path: 'settings.json' },
    { id: 'sessions', class: 'app', path: 'sessions.json' },
  ])
  const settings = volumePath(home, '@local/dpk-fixture', volumes[0])
  const sessions = volumePath(home, '@local/dpk-fixture', volumes[1])
  for (const [path, content] of [[settings, '{"settings":1}\n'], [sessions, '{"sessions":1}\n']]) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  // A single-package hand-off is the plugin's runtime state: `data` volumes are
  // the ones the whole-machine snapshot (`export all`) carries.
  const exported = await exportVolumes(home, '@local/dpk-fixture', volumes, { classes: ['app'] })
  assert.deepEqual(exported.map(entry => entry.path), ['app/sessions.json'])

  const other = await makeHome()
  await importDataVolumes(other, '@local/dpk-fixture', volumes, exported)
  assert.equal(existsSync(volumePath(other, '@local/dpk-fixture', volumes[0])), false, 'the data volume is not carried')
  assert.equal(await readFile(volumePath(other, '@local/dpk-fixture', volumes[1]), 'utf8'), '{"sessions":1}\n', 'the app volume lands')

  // The whole-machine scope carries both, and the class prefix in the entry is
  // what keeps two volumes that share a relative path apart.
  const whole = await exportVolumes(home, '@local/dpk-fixture', volumes)
  assert.deepEqual(whole.map(entry => entry.path).sort(), ['app/sessions.json', 'data/settings.json'])
  const twin = VOLUMES([
    { id: 'shared-data', class: 'data', path: 'state.json' },
    { id: 'shared-app', class: 'app', path: 'state.json' },
  ])
  const twinHome = await makeHome()
  await importDataVolumes(twinHome, '@local/dpk-fixture', twin, [
    { path: 'data/state.json', bytes: Buffer.from('{"class":"data"}\n') },
    { path: 'app/state.json', bytes: Buffer.from('{"class":"app"}\n') },
  ])
  assert.equal(await readFile(volumePath(twinHome, '@local/dpk-fixture', twin[0]), 'utf8'), '{"class":"data"}\n')
  assert.equal(await readFile(volumePath(twinHome, '@local/dpk-fixture', twin[1]), 'utf8'), '{"class":"app"}\n')

  const seeded = VOLUMES([{ id: 'cfg', class: 'data', path: 'cfg.json', seed: 'seeds/cfg.json' }])
  const seedPackage = await mkdtemp(join(tmpdir(), 'dpk-seed-package-'))
  await mkdir(join(seedPackage, 'seeds'), { recursive: true })
  await writeFile(join(seedPackage, 'seeds', 'cfg.json'), '{"seed":1}\n')
  await materializeVolumes(other, '@local/dpk-fixture', seeded, seedPackage)
  await importDataVolumes(other, '@local/dpk-fixture', seeded, [{ path: 'data/cfg.json', bytes: Buffer.from('{"imported":true}\n') }])
  await writeFile(join(seedPackage, 'seeds', 'cfg.json'), '{"seed":2}\n')
  const adopted = await materializeVolumes(other, '@local/dpk-fixture', seeded, seedPackage)
  assert.equal(adopted[0].action, 'adopted', 'import clears the seed marker and protects imported data')

  await assert.rejects(
    () => importDataVolumes(other, '@local/dpk-fixture', volumes, [{ path: 'undeclared/secret.json', bytes: Buffer.from('x') }]),
    /does not declare as a data volume/,
    'an import carrying undeclared paths is refused',
  )
})

test('pack refuses a volume whose seed is missing from the package', async () => {
  const root = await makePackage({
    manifest: {
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        data: { volumes: [{ id: 'a', class: 'data', path: 'a.json', seed: 'seeds/missing.json' }] },
      },
    },
  })
  await assert.rejects(() => packDirectory(root), /seed file does not exist/)
})

test('the manifest carries the declaration and verify still passes', async () => {
  const packed = await packDirectory(await makeManagedPackage())
  const strip = volume => Object.fromEntries(Object.entries(volume).filter(([, value]) => value !== undefined))
  assert.deepEqual(
    packed.manifest.dsh.data.volumes.map(strip),
    [
      { id: 'providers', class: 'app', path: 'providers.json', seed: 'seeds/providers.json' },
      { id: 'prompts', class: 'app', path: 'prompt-overrides.json', seed: 'seeds/prompts.json' },
      { id: 'credentials', class: 'app', path: 'credentials.json' },
      { id: 'telemetry', class: 'app', path: 'telemetry-state.json' },
      { id: 'captcha', class: 'app', path: 'captcha-profile/cookies' },
    ],
  )
  // The written archive itself carries the declaration in exactly one place:
  // the verbatim dsh copy. A top-level `data` key is an unknown field and
  // every reader rejects the whole archive over it.
  const { readZipEntry, readZipIndex } = await import('../lib/zip.mjs')
  const written = JSON.parse(readZipEntry(packed.buffer, readZipIndex(packed.buffer).entries.find(entry => entry.path === 'dpk.json')))
  assert.equal(written.data, undefined, 'no top-level data key is written')
  assert.equal(JSON.stringify(written.dsh.data.volumes), JSON.stringify(packed.manifest.dsh.data.volumes), 'dsh.data.volumes carries the declaration')
})

test('a top-level data key is rejected as an unknown field', async () => {
  const packed = await packDirectory(await makeManagedPackage())
  const { readZipEntry, readZipIndex, writeZip } = await import('../lib/zip.mjs')
  const index = readZipIndex(packed.buffer)
  const entries = index.entries.map(entry => ({
    path: entry.path,
    data: readZipEntry(packed.buffer, entry),
    mode: 0o644,
  }))
  const manifestEntry = entries.find(entry => entry.path === 'dpk.json')
  // An archive from the generation that duplicated the volume declaration at the
  // top level (2.1.8–2.1.9). That generation is not supported and the field is
  // not recognized: it is an unknown field like any other.
  manifestEntry.data = Buffer.from(JSON.stringify({
    ...JSON.parse(manifestEntry.data.toString('utf8')),
    data: { volumes: packed.manifest.dsh.data.volumes },
  }, undefined, 2), 'utf8')
  const legacy = writeZip(entries)
  await assert.rejects(() => verifyArchive(legacy), error =>
    error.code === 'DPK_MANIFEST_UNKNOWN_FIELD' && /unknown field: data/.test(error.message))
})

test('a bare-named archive verifies and the scope is still added at install time', async () => {
  const root = await makePackage({
    manifest: {
      name: 'bare-named-tool',
      dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' }, data: { volumes: [{ id: 'cfg', class: 'data', path: 'cfg.json' }] } },
    },
  })
  const packed = await packDirectory(root)
  assert.equal(packed.manifest.name, 'bare-named-tool', 'pack never burns a scope into the archive')
  const verified = await verifyArchive(packed.buffer, { deep: true })
  assert.equal(verified.manifest.name, 'bare-named-tool', 'verify accepts the bare name on both sides of the comparison')
  const home = await makeHome()
  const installer = async () => {}
  const result = await installArchive({
    file: 'bare.dpk', buffer: packed.buffer, home, profile: 'test',
    installer, log: () => {},
  })
  const stored = JSON.parse(await readFile(join(result.packageDir, 'package.json'), 'utf8'))
  assert.equal(stored.name, '@local/bare-named-tool', 'the install action adds the @local marking')
})

test('the declaration refuses unclean seed paths', () => {
  for (const bad of [
    { id: 'a', class: 'data', path: 'a.json', seed: '../escape.json' },
    { id: 'a', class: 'data', path: 'a.json', seed: 'seeds/../../escape.json' },
    { id: 'a', class: 'data', path: 'a.json', seed: 'C:\escape.json' },
    { id: 'a', class: 'data', path: 'a.json', seed: '/absolute/seed.json' },
    { id: 'a', class: 'data', path: 'a.json', seed: './seed.json' },
  ]) {
    assert.throws(() => VOLUMES([bad]), /seed/, `seed ${bad.seed} must be refused`)
  }
  assert.equal(VOLUMES([{ id: 'a', class: 'data', path: 'a.json', seed: 'seeds/a.json' }]).length, 1)
})

test('materializeVolumes refuses a seed that escapes the package, even unvalidated', async () => {
  const home = await makeHome()
  const pkg = await makePackage({ extraFiles: { 'outside.txt': 'secret\n' } })
  // A declaration that skipped parseDataDeclaration (defense in depth): the
  // seed resolves outside packageDir and must be refused at materialise time.
  const escaping = [{ id: 'evil', class: 'data', path: 'evil.json', seed: '../outside.txt' }]
  await assert.rejects(
    () => materializeVolumes(home, '@local/x', escaping, pkg, {}),
    /stay inside the package/,
  )
})

test('a volume declaration survives the way it was spelled', async () => {
  // One declaration in three spellings: keys written in another order, and the
  // volumes listed in another order — what a key-sorting formatter, a
  // hand-edit, or a differently built packer produces. A claim does not depend
  // on where or how it was written, so all three must pack and import.
  const declarations = {
    canonical: [
      { id: 'cfg', class: 'data', path: 'cfg.json', seed: 'seeds/cfg.json' },
      { id: 'app', class: 'app', path: 'app.json' },
    ],
    'reordered keys': [
      { class: 'data', seed: 'seeds/cfg.json', path: 'cfg.json', id: 'cfg' },
      { class: 'app', path: 'app.json', id: 'app' },
    ],
    'reordered list': [
      { id: 'app', class: 'app', path: 'app.json' },
      { id: 'cfg', class: 'data', path: 'cfg.json', seed: 'seeds/cfg.json' },
    ],
  }
  const expected = parseDataDeclaration({ volumes: declarations.canonical })
  const byId = volumes => [...volumes].sort((left, right) => (left.id < right.id ? -1 : 1))
  for (const [label, volumes] of Object.entries(declarations)) {
    const root = await makePackage({
      manifest: {
        dsh: {
          manifestVersion: 1,
          bundle: { patch: './cordis.patch.yml' },
          data: { volumes },
        },
      },
      extraFiles: { 'seeds/cfg.json': '{}\n' },
    })
    const packed = await packDirectory(root)
    const verified = await verifyArchive(packed.buffer, { deep: true })
    assert.equal(verified.manifest.integrity.digest, packed.manifest.integrity.digest,
      `${label}: the packer's own archive imports`)
    assert.deepEqual(byId(verified.packageFacts.dataVolumes), byId(expected),
      `${label}: the same declaration reads back`)
  }
})

test('a trailing slash on a volume path is normalized on both sides', async () => {
  const packed = await packDirectory(await makePackage({
    manifest: {
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        data: { volumes: [{ id: 'cookies', class: 'app', path: 'captcha/cookies/' }] },
      },
    },
  }))
  const verified = await verifyArchive(packed.buffer, { deep: true })
  assert.equal(verified.manifest.dsh.data.volumes[0].path, 'captcha/cookies/',
    'the archive keeps the declaration exactly as the package wrote it')
  assert.equal(verified.packageFacts.dataVolumes[0].path, 'captcha/cookies',
    'the fact is the normalized path the installer materialises')
})

test('a declaration that really differs is still refused, and names the volume', async () => {
  const packed = await packDirectory(await makeManagedPackage())
  const { readZipEntry, readZipIndex, writeZip } = await import('../lib/zip.mjs')
  const index = readZipIndex(packed.buffer)
  const entries = index.entries.map(entry => ({
    path: entry.path,
    data: readZipEntry(packed.buffer, entry),
    mode: 0o644,
  }))
  const manifestEntry = entries.find(entry => entry.path === 'dpk.json')
  const tampered = JSON.parse(manifestEntry.data.toString('utf8'))
  // The digest covers the package files and never dpk.json itself, so this
  // cross-check is the only thing standing between a rewritten manifest and an
  // installer that would materialise a volume the package never declared.
  tampered.dsh.data.volumes = [
    ...tampered.dsh.data.volumes,
    { id: 'smuggled', class: 'app', path: 'smuggled.json' },
  ]
  manifestEntry.data = Buffer.from(JSON.stringify(tampered, undefined, 2), 'utf8')
  await assert.rejects(
    () => verifyArchive(writeZip(entries), { deep: true }),
    error => error.code === 'DPK_MANIFEST_MISMATCH'
      && /data: dpk\.json volume declaration differs/.test(error.message)
      && /smuggled/.test(error.message),
    'the mismatch is refused and the offending volume is named',
  )
})

test('export/import actions round-trip app volumes through the tool layer', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makeManagedPackage())
  await installArchive({
    file: 'x.dpk', buffer: packed.buffer, home, profile: 'test',
    installer: async () => {}, log: () => {},
  })
  const root = dataRoot(home, '@local/dpk-fixture')
  await mkdir(join(root, 'app'), { recursive: true })
  await writeFile(join(root, 'app', 'providers.json'), '{"provider":{"edited":true}}\n', 'utf8')
  const { runDpkAction } = await import('../lib/actions.mjs')
  const outDir = await mkdtemp(join(tmpdir(), 'dpk-export-'))
  try {
    // An export is generated on demand and leaves no trace in dpk's own state:
    // the only new file is the one the caller named.
    const before = await snapshot(home)
    const exported = await runDpkAction('export', { name: '@local/dpk-fixture', output: join(outDir, 'data.json') }, { home, log: () => {} })
    assert.match(exported.text, /2 app volume/, 'both app volumes exported')
    assert.deepEqual(await snapshot(home), before, 'the export wrote nothing into the DSH home')
    const carried = JSON.parse(await readFile(join(outDir, 'data.json'), 'utf8'))
    assert.equal(carried.format, 'dpk-config-data/1')
    assert.equal(carried.package, '@local/dpk-fixture')
    assert.equal(carried.files.length, 2)
    assert.equal(carried.files[0].path, 'app/providers.json')
    // reset the volume, then import the carried copy back
    await writeFile(join(root, 'app', 'providers.json'), '{}\n', 'utf8')
    const imported = await runDpkAction('import', { name: '@local/dpk-fixture', file: join(outDir, 'data.json') }, { home, log: () => {} })
    assert.match(imported.text, /2 volume/, 'both volumes imported')
    assert.equal(
      await readFile(join(root, 'app', 'providers.json'), 'utf8'),
      '{"provider":{"edited":true}}\n',
      'the carried app content lands verbatim',
    )
    await assert.rejects(
      () => runDpkAction('import', { name: '@local/dpk-fixture', file: join(outDir, 'missing.json') }, { home }),
      /no such file/,
    )
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('a failed service install restores the previous seed before the manager can retry', async () => {
  const home = await makeHome()
  const v1 = await packDirectory(await makeManagedPackage({ version: '1.0.0' }))
  await installArchive({
    file: 'v1.dpk', buffer: v1.buffer, home, profile: 'test', installMode: 'service',
    installer: async () => ({ application: 'applied', changed: true }), log: () => {},
  })
  const providers = join(dataRoot(home, '@local/dpk-fixture'), 'app', 'providers.json')
  assert.equal(await readFile(providers, 'utf8'), '{"provider":{}}\n')

  const v2 = await packDirectory(await makeManagedPackage({
    version: '2.0.0',
    extraFiles: { 'seeds/providers.json': '{"provider":{"v2":true}}\n' },
  }))
  await assert.rejects(
    installArchive({
      file: 'v2.dpk', buffer: v2.buffer, home, profile: 'test', installMode: 'service',
      installer: async () => { throw new Error('manager refused') }, log: () => {},
    }),
    /manager refused/,
  )
  assert.equal(await readFile(providers, 'utf8'), '{"provider":{}}\n', 'the failed service attempt did not poison the old seed')
  assert.equal(existsSync(`${providers}.dpk-new`), false)
})

test('import validates every carried volume before writing any of them', async () => {
  const home = await makeHome()
  const volumes = VOLUMES([
    { id: 'first', class: 'data', path: 'first.json' },
    { id: 'second', class: 'data', path: 'second.json' },
  ])
  await assert.rejects(
    importDataVolumes(home, '@local/import-check', volumes, [
      { path: 'data/first.json', bytes: Buffer.from('first\n') },
      { path: 'data/not-declared.json', bytes: Buffer.from('bad\n') },
    ]),
    error => error.code === 'DPK_DATA_IMPORT_UNDECLARED',
  )
  assert.equal(existsSync(join(dataRoot(home, '@local/import-check'), 'data', 'first.json')), false)
})

test('a class outside data/app is refused with the two words that exist', async () => {
  // Invalid input must fail at the declaration, loudly: a silent no-volume
  // would surface much later as "the plugin cannot find its file". The names
  // older generations used get the same plain refusal as any other unknown
  // value — those generations are not served, so there is no migration to hint at.
  for (const klass of ['state', 'cache', 'config', 'etc']) {
    try {
      VOLUMES([{ id: 'old', class: klass, path: 'old.json' }])
      assert.fail(`class "${klass}" was accepted`)
    } catch (error) {
      assert.match(error.message, /must be one of data, app/)
      assert.equal(error.message.includes('renamed'), false, `no migration hint for "${klass}"`)
    }
  }
  try {
    VOLUMES([{ id: 'old', class: 'etc', path: 'old.json' }])
    assert.fail('class "etc" was accepted')
  } catch (error) {
    assert.match(error.message, /must be one of data, app/)
    assert.equal(error.message.includes('renamed'), false)
  }
})
