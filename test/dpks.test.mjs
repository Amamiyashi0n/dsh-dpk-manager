/**
 * `export all` / `import` 的多包形态:`dpks-data/1` 文件把**全部已装包**的数据卷
 * 装进一个文件——换机迁移的单一交接物。钉住的行为:
 *  - export all 覆盖账本里每个包(每包独立条目),import 全部写回;
 *  - 只装了一半的机器:未记录的包跳过并提示,不失败;
 *  - bundle + name= 可从 bundle 里挑一个包导入;
 *  - 单包格式(dpk-config-data/1)继续工作,两种格式互不干扰。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { runDpkAction } from '../lib/actions.mjs'
import { packDirectory } from '../lib/pack.mjs'
import { dpkRoot, readIndex, recordInstall, storeDir } from '../lib/store.mjs'
import { dataRoot, volumePath } from '../lib/data.mjs'
import { readZipEntry, readZipIndex, writeZip } from '../lib/zip.mjs'
import { makeHome, makePackage, profileUsing, storeEntry } from './helpers.mjs'

/**
 * Two packages, deliberately different in shape, recorded in the ledger:
 * `@local/one` declares an `app` volume only, `@local/two` declares both an
 * `app` and a `data` volume. One snapshot has to carry both without a mode.
 */
async function twoPackages() {
  const home = await makeHome()
  const root = dpkRoot(home)
  const one = await storeEntry(root, 'c'.repeat(64), { manifest: { name: '@local/one', version: '1.0.0', dsh: { data: { volumes: [{ id: 'sessions', class: 'app', path: 'sessions.json' }] } } } })
  const two = await storeEntry(root, 'd'.repeat(64), {
    manifest: {
      name: '@local/two',
      version: '1.0.0',
      dsh: {
        data: {
          volumes: [
            { id: 'sessions', class: 'app', path: 'sessions.json' },
            { id: 'settings', class: 'data', path: 'settings.json' },
          ],
        },
      },
    },
  })
  await recordInstall(root, { name: '@local/one', version: '1.0.0', digest: 'c'.repeat(64), source: 'one.dpk' })
  await recordInstall(root, { name: '@local/two', version: '1.0.0', digest: 'd'.repeat(64), source: 'two.dpk' })
  await profileUsing(home, 'probe', { '@local/one': one, '@local/two': two })
  for (const [name, klass, file, content] of [
    ['one', 'app', 'sessions.json', '{"from":"one"}\n'],
    ['two', 'app', 'sessions.json', '{"from":"two"}\n'],
    ['two', 'data', 'settings.json', '{"settings":"two"}\n'],
  ]) {
    const path = join(dataRoot(home, `@local/${name}`), klass, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return { home, root }
}

test('export all bundles every recorded package into one dpks-data file', async () => {
  const { home } = await twoPackages()
  const out = join(home, 'all.dpks')

  const result = await runDpkAction('export', { all: true, output: out }, { home })

  // `export` is the runtime-state scope: each package contributes its `app`
  // volumes and nothing else, so `@local/two`'s `data` volume stays behind
  // (`snap all` is the scope that carries it).
  assert.match(result.text, /exported 2 package\(s\), 2 volume\(s\) \(data: 0, app: 2\)/)
  const buffer = await readFile(out)
  const zipIndex = readZipIndex(buffer)
  const manifest = JSON.parse(readZipEntry(buffer, zipIndex.entries.find(entry => entry.path === 'dpks.json')).toString('utf8'))
  assert.equal(manifest.format, 'dpks-data/1')
  assert.deepEqual(manifest.packages.map(pkg => pkg.package).sort(), ['@local/one', '@local/two'])
  assert.deepEqual(manifest.packages.find(pkg => pkg.package === '@local/one').files.map(file => file.path), ['app/sessions.json'])
  assert.deepEqual(
    manifest.packages.find(pkg => pkg.package === '@local/two').files.map(file => file.path),
    ['app/sessions.json'],
    'the data volume is not part of this scope',
  )
  // The manifest lists paths only: content lives in the archive entries below,
  // exactly once. An inline base64 copy would double the file and add 4/3 size
  // for the copy inside the JSON.
  assert.ok(
    manifest.packages.every(pkg => pkg.files.every(file => file.bytes === undefined)),
    'the manifest carries no inline content',
  )
  // 每个卷文件真实存在于归档里(data/<package>/<class>/<file>)
  for (const pkg of manifest.packages) {
    for (const file of pkg.files) {
      const name = `data/${pkg.package}/${file.path}`
      assert.ok(zipIndex.entries.some(entry => entry.path === name), name)
    }
  }
})

test('export all defaults to a .dpks file that import reads back', async () => {
  const { home } = await twoPackages()
  // The default output lands in the working directory, so the test moves there
  // and restores it: what is pinned is the name, and that the name composes
  // with the reader (the 2.1.36 default was `dpks.dpk`, which the reader's
  // suffix dispatch then refused as "not valid JSON").
  const scratch = await mkdtemp(join(tmpdir(), 'dpk-default-name-'))
  const cwd = process.cwd()
  process.chdir(scratch)
  try {
    const exported = await runDpkAction('export', { all: true }, { home })
    const name = basename(exported.data.output)
    assert.match(name, /\.dpks$/, `the default name carries the archive extension, got ${name}`)
    assert.ok(existsSync(exported.data.output))

    await rm(dataRoot(home, '@local/one'), { recursive: true, force: true })
    const imported = await runDpkAction('import', { file: exported.data.output }, { home })
    assert.match(imported.text, /imported 1 volume\(s\) for @local\/one/)
    assert.equal(
      await readFile(volumePath(home, '@local/one', { class: 'app', path: 'sessions.json' }), 'utf8'),
      '{"from":"one"}\n',
    )
  } finally {
    process.chdir(cwd)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('import reads an archive by content, so a renamed one still imports', async () => {
  const { home } = await twoPackages()
  const out = join(home, 'snapshot.dpks')
  await runDpkAction('export', { all: true, output: out }, { home })
  // The name the 2.1.35–2.1.36 default wrote, and any other name a user gives it.
  const renamed = join(home, 'snapshot.dpk')
  await writeFile(renamed, await readFile(out))
  await rm(dataRoot(home, '@local/one'), { recursive: true, force: true })

  const imported = await runDpkAction('import', { file: renamed }, { home })

  assert.match(imported.text, /imported 1 volume\(s\) for @local\/one/)
})

test('an archive with no content entries is refused, not read from a manifest copy', async () => {
  const { home } = await twoPackages()
  // The 2.1.35–2.1.36 shape inlined the bytes in dpks.json. This reader knows one
  // shape — content in `data/<package>/…` entries — so an archive that carries
  // none is refused rather than half-read.
  const payload = {
    format: 'dpks-data/1',
    exportedAt: new Date().toISOString(),
    packages: [{
      package: '@local/one',
      files: [{ path: 'app/sessions.json', bytes: Buffer.from('{"legacy":true}\n').toString('base64') }],
    }],
  }
  const file = join(home, 'inline.dpks')
  await writeFile(file, writeZip([{ path: 'dpks.json', data: Buffer.from(JSON.stringify(payload), 'utf8'), mode: 0o644 }], { compress: true }))

  await assert.rejects(
    () => runDpkAction('import', { file }, { home }),
    /the archive carries no content for @local\/one\/app\/sessions\.json/,
  )
})

test('export all skips a package whose stored declaration cannot be read', async () => {
  const { home, root } = await twoPackages()
  // A store copy older than the class rename still on disk (this happens on a
  // real machine: the installed copy can predate the source by a release). One
  // unreadable package must not cost the user every other package's data.
  await storeEntry(root, 'e'.repeat(64), {
    manifest: {
      name: '@local/legacy',
      version: '1.0.0',
      dsh: { data: { volumes: [{ id: 'providers', class: 'config', path: 'providers.json' }] } },
    },
  })
  await recordInstall(root, { name: '@local/legacy', version: '1.0.0', digest: 'e'.repeat(64), source: 'legacy.dpk' })
  const out = join(home, 'all.dpks')

  const result = await runDpkAction('export', { all: true, output: out }, { home })

  assert.match(result.text, /exported 2 package\(s\)/)
  assert.match(result.text, /skip {5}@local\/legacy: .*class must be one of data, app/)
  assert.deepEqual(result.data.skipped.map(item => item.package), ['@local/legacy'])
  assert.ok(existsSync(out), 'the archive is still written for the packages that could be read')
  // Named explicitly, the same package fails loudly instead: there the user
  // asked for exactly it, and a silent empty export would be the worse answer.
  await assert.rejects(
    () => runDpkAction('export', { name: 'legacy', output: join(home, 'legacy.json') }, { home }),
    /class must be one of data, app/,
  )
})

test('import restores every package the dpks-data file carries', async () => {
  const { home } = await twoPackages()
  const out = join(home, 'all.dpks')
  await runDpkAction('export', { all: true, output: out }, { home })

  // 模拟"换机后数据被清空":两个卷都被删掉
  await rm(dataRoot(home, '@local/one'), { recursive: true, force: true })
  await rm(dataRoot(home, '@local/two'), { recursive: true, force: true })

  const result = await runDpkAction('import', { file: out }, { home })

  assert.match(result.text, /imported 1 volume\(s\) for @local\/one/)
  assert.match(result.text, /imported 1 volume\(s\) for @local\/two/)
  assert.equal(
    await readFile(volumePath(home, '@local/one', { class: 'app', path: 'sessions.json' }), 'utf8'),
    '{"from":"one"}\n',
  )
  assert.equal(
    await readFile(volumePath(home, '@local/two', { class: 'app', path: 'sessions.json' }), 'utf8'),
    '{"from":"two"}\n',
  )
})

test('a failed package in a multi-package import rolls back earlier packages', async () => {
  const { home, root } = await twoPackages()
  const out = join(home, 'all.dpks')
  await runDpkAction('snap', { all: true, output: out }, { home })
  await rm(dataRoot(home, '@local/one'), { recursive: true, force: true })
  await rm(dataRoot(home, '@local/two'), { recursive: true, force: true })

  // The archive is valid, but the second installed package has an invalid
  // declaration. `one` is processed first by name; its write must be undone
  // when `two` fails so migration never leaves a half-restored machine.
  await writeFile(
    join(storeDir(root, 'd'.repeat(64)), 'package', 'package.json'),
    JSON.stringify({ name: '@local/two', version: '1.0.0', dsh: { data: { volumes: [{ id: 'settings', class: 'config', path: 'settings.json' }] } } }),
  )

  await assert.rejects(
    () => runDpkAction('import', { file: out }, { home }),
    /class must be one of data, app/,
  )
  assert.equal(existsSync(join(dataRoot(home, '@local/one'), 'app', 'sessions.json')), false, 'the earlier package was rolled back')
  assert.equal(existsSync(join(dataRoot(home, '@local/two'), 'data', 'settings.json')), false, 'the failing package wrote nothing')
})

test('a dpks archive with unlisted content is refused', async () => {
  const home = await makeHome()
  const manifest = {
    format: 'dpks-data/1',
    packages: [{ package: '@local/one', files: [{ path: 'app/session.json' }] }],
  }
  const archive = writeZip([
    { path: 'dpks.json', data: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
    { path: 'data/@local/one/app/session.json', data: Buffer.from('ok\n'), mode: 0o644 },
    { path: 'data/@local/one/app/forgotten.json', data: Buffer.from('silent loss\n'), mode: 0o644 },
  ], { compress: true })
  const file = join(home, 'extra.dpks')
  await writeFile(file, archive)

  await assert.rejects(
    () => runDpkAction('import', { file }, { home }),
    /carries unlisted content: data\/@local\/one\/app\/forgotten\.json/,
  )
})

test('import of a dpks bundle skips packages this machine does not record', async () => {
  const { home } = await twoPackages()
  const out = join(home, 'all.dpks')
  await runDpkAction('export', { all: true, output: out }, { home })

  // 新机器:只装了 one(声明与新机一致,否则导入会被正确拒绝)
  const fresh = await makeHome()
  const freshRoot = dpkRoot(fresh)
  const one = await storeEntry(freshRoot, 'c'.repeat(64), {
    manifest: {
      name: '@local/one', version: '1.0.0',
      dsh: { data: { volumes: [{ id: 'sessions', class: 'app', path: 'sessions.json' }] } },
    },
  })
  await recordInstall(freshRoot, { name: '@local/one', version: '1.0.0', digest: 'c'.repeat(64), source: 'one.dpk' })
  await profileUsing(fresh, 'probe', { '@local/one': one })

  const result = await runDpkAction('import', { file: out }, { fresh: undefined, ...{}, ...{ home: fresh } })

  assert.match(result.text, /imported 1 volume\(s\) for @local\/one/)
  assert.match(result.text, /skip {5}@local\/two: not recorded here/)
  assert.equal(result.data.skipped.length, 1)
})

test('import name= selects one package from a dpks bundle', async () => {
  const { home } = await twoPackages()
  const out = join(home, 'all.dpks')
  await runDpkAction('export', { all: true, output: out }, { home })
  await rm(dataRoot(home, '@local/two'), { recursive: true, force: true })

  const result = await runDpkAction('import', { file: out, name: 'two' }, { home })

  assert.match(result.text, /imported 1 volume\(s\) for @local\/two/)
  assert.equal(result.data.applied.length, 1, 'the app volume this archive carries comes back')
})

test('the single-package format keeps working beside the bundle format', async () => {
  const { home } = await twoPackages()
  const single = join(home, 'two-data.json')
  await runDpkAction('export', { name: '@local/two', output: single }, { home })
  const carried = JSON.parse(await readFile(single, 'utf8'))
  assert.equal(carried.format, 'dpk-config-data/1')
  assert.equal(carried.package, '@local/two')
  // The single-package scope is the plugin's runtime state: `@local/two` also
  // declares a `data` volume, and it stays behind — `export all` is the snapshot
  // that carries those.
  assert.deepEqual(carried.files.map(file => file.path), ['app/sessions.json'])

  await rm(dataRoot(home, '@local/two'), { recursive: true, force: true })
  // The file names its own package, so `name=` is not required for this shape —
  // it is what picks one package out of a multi-package archive, and here there
  // is only one. A caller that passes it anyway must mean the same package.
  const result = await runDpkAction('import', { file: single }, { home })
  assert.match(result.text, /imported 1 volume\(s\) from/)
  assert.equal(existsSync(join(dataRoot(home, '@local/two'), 'data', 'settings.json')), false, 'the data volume did not travel')

  await assert.rejects(
    () => runDpkAction('import', { file: single, name: '@local/one' }, { home }),
    /was exported for @local\/two, not @local\/one/,
    'naming a different package is a caller mistake, not a redirect',
  )
})

test('snap carries app and data for one package, export carries app only', async () => {
  const { home } = await twoPackages()
  // `@local/two` declares both classes. The two verbs are the same code path with
  // one axis between them: which classes travel.
  const exported = join(home, 'two-export.json')
  const snapshotted = join(home, 'two-snap.json')

  const exportedResult = await runDpkAction('export', { name: 'two', output: exported }, { home })
  const snapResult = await runDpkAction('snap', { name: 'two', output: snapshotted }, { home })

  assert.match(exportedResult.text, /exported 1 app volume\(s\)/)
  assert.match(exportedResult.text, /carries app volumes only/)
  assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')).files.map(file => file.path), ['app/sessions.json'])

  assert.match(snapResult.text, /snapshotted 2 volume\(s\) \(data: 1, app: 1\)/)
  assert.deepEqual(JSON.parse(await readFile(snapshotted, 'utf8')).files.map(file => file.path).sort(), ['app/sessions.json', 'data/settings.json'])
})

test('snap all carries app and data for every recorded package', async () => {
  const { home } = await twoPackages()
  const out = join(home, 'snap.dpks')

  const result = await runDpkAction('snap', { all: true, output: out }, { home })

  // `one` declares app only, `two` declares both: the report counts what each
  // class actually contributed.
  assert.match(result.text, /snapshotted 2 package\(s\), 3 volume\(s\) \(data: 1, app: 2\)/)
  assert.match(result.text, /carries app and data volumes/)
  const buffer = await readFile(out)
  const zipIndex = readZipIndex(buffer)
  const manifest = JSON.parse(readZipEntry(buffer, zipIndex.entries.find(entry => entry.path === 'dpks.json')).toString('utf8'))
  assert.deepEqual(
    manifest.packages.find(pkg => pkg.package === '@local/two').files.map(file => file.path).sort(),
    ['app/sessions.json', 'data/settings.json'],
  )

  // The snapshot round-trips through the same reader the export files use.
  await rm(dataRoot(home, '@local/two'), { recursive: true, force: true })
  const imported = await runDpkAction('import', { file: out }, { home })
  assert.match(imported.text, /imported 2 volume\(s\) for @local\/two/)
  assert.equal(await readFile(join(dataRoot(home, '@local/two'), 'data', 'settings.json'), 'utf8'), '{"settings":"two"}\n')
})

test('the two verbs never default to the same output file', async () => {
  const { home } = await twoPackages()
  const scratch = await mkdtemp(join(tmpdir(), 'dpk-verb-defaults-'))
  const cwd = process.cwd()
  process.chdir(scratch)
  try {
    const exported = await runDpkAction('export', { name: 'two' }, { home })
    const snapshotted = await runDpkAction('snap', { name: 'two' }, { home })
    const exportedAll = await runDpkAction('export', { all: true }, { home })
    const snapshottedAll = await runDpkAction('snap', { all: true }, { home })

    // Taking an export and then a snapshot is the normal thing to do, so the
    // second must not land on the first one's file: before this, both defaults
    // were `<package>-data.json` / `dpks.dpks` and the second silently won.
    assert.notEqual(exported.data.output, snapshotted.data.output)
    assert.notEqual(exportedAll.data.output, snapshottedAll.data.output)
    assert.deepEqual((await readdir(scratch)).sort(), ['dpks.dpks', 'snap.dpks', 'two-data.json', 'two-snap.json'])
    // Each file still holds what its own verb carries.
    assert.deepEqual(JSON.parse(await readFile(exported.data.output, 'utf8')).files.map(file => file.path), ['app/sessions.json'])
    assert.deepEqual(
      JSON.parse(await readFile(snapshotted.data.output, 'utf8')).files.map(file => file.path).sort(),
      ['app/sessions.json', 'data/settings.json'],
    )
  } finally {
    process.chdir(cwd)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('a single-package snapshot imports back, data volume included', async () => {
  const { home } = await twoPackages()
  const file = join(home, 'two-snap.json')
  await runDpkAction('snap', { name: 'two', output: file }, { home })
  await rm(dataRoot(home, '@local/two'), { recursive: true, force: true })

  // A single-package file is one JSON document with base64 fields, so it takes a
  // different read path from the archive (`carriedFiles` with fromArchive false);
  // the data volume has to land the same way it does through a .dpks.
  const result = await runDpkAction('import', { file }, { home })

  assert.match(result.text, /imported 2 volume\(s\) from/)
  assert.equal(await readFile(join(dataRoot(home, '@local/two'), 'data', 'settings.json'), 'utf8'), '{"settings":"two"}\n')
  assert.equal(await readFile(join(dataRoot(home, '@local/two'), 'app', 'sessions.json'), 'utf8'), '{"from":"two"}\n')
})

test('a malformed dpks file is refused', async () => {
  const home = await makeHome()
  const bad = join(home, 'bad.json')
  await writeFile(bad, JSON.stringify({ format: 'dpks-data/1' }))

  await assert.rejects(
    () => runDpkAction('import', { file: bad }, { home }),
    /no packages array/,
  )
})
