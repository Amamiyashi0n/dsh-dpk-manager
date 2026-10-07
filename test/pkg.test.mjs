/**
 * `dpk pkg`: reading and adjusting one data file on disk.
 *
 * What the file *is* follows from how many packages it holds — one package is
 * the JSON document, several are the `.dpks` archive — so these tests are mostly
 * about that transition happening in both directions, and about the reader
 * accepting a file that was made by hand and says something other than what it
 * holds.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { runDpkAction } from '../src/lib/cli.mjs'
import { dataRoot } from '../src/lib/data.mjs'
import { DATA_FORMAT_SINGLE, buildDataFile, readDataFile } from '../src/lib/data-file.mjs'
import { dpkRoot, recordInstall } from '../src/lib/store.mjs'
import { readZipEntry, readZipIndex, writeZip } from '../src/lib/zip.mjs'
import { makeHome, profileUsing, storeEntry } from './helpers.mjs'

/** Two installed packages: `one` declares app only, `two` declares app + data. */
async function twoPackages() {
  const home = await makeHome()
  const root = dpkRoot(home)
  const one = await storeEntry(root, 'a'.repeat(64), {
    manifest: { name: '@local/one', version: '1.0.0', dsh: { data: { volumes: [{ id: 'sessions', class: 'app', path: 'sessions.json' }] } } },
  })
  const two = await storeEntry(root, 'b'.repeat(64), {
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
  await recordInstall(root, { name: '@local/one', version: '1.0.0', digest: 'a'.repeat(64), source: 'one.dpk' })
  await recordInstall(root, { name: '@local/two', version: '1.0.0', digest: 'b'.repeat(64), source: 'two.dpk' })
  await profileUsing(home, 'probe', { '@local/one': one, '@local/two': two })
  for (const [name, klass, file, body] of [
    ['one', 'app', 'sessions.json', '{"from":"one"}\n'],
    ['two', 'app', 'sessions.json', '{"from":"two"}\n'],
    ['two', 'data', 'settings.json', '{"settings":"two"}\n'],
  ]) {
    const path = join(dataRoot(home, `@local/${name}`), klass, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
  }
  return { home }
}

test('pkg list reports what a file carries, whichever form it is in', async () => {
  const { home } = await twoPackages()
  const document = join(home, 'one.json')
  const archive = join(home, 'both.dpks')
  await runDpkAction('export', { name: 'one', output: document }, { home })
  await runDpkAction('snap', { all: true, output: archive }, { home })

  const one = await runDpkAction('pkg', { file: document, op: 'list' }, { home })
  assert.match(one.text, /one package \(json document\), 1 volume\(s\)/)
  assert.match(one.text, /@local\/one {2}1 volume\(s\) \(data: 0, app: 1\)/)
  assert.equal(one.data.form, 'dpk')

  const both = await runDpkAction('pkg', { file: archive, op: 'list' }, { home })
  assert.match(both.text, /2 packages \(dpks archive\), 3 volume\(s\)/)
  assert.equal(both.data.form, 'dpks')
  assert.deepEqual(both.data.packages.map(pkg => pkg.package), ['@local/one', '@local/two'])
})

test('adding a second package promotes the file to the archive form, and removing demotes it', async () => {
  const { home } = await twoPackages()
  const path = join(home, 'bundle.json')
  await runDpkAction('snap', { name: 'one', output: path }, { home })

  // One package: the document. Adding another makes it an archive — and the
  // form is the file's own consequence, so the name moves with it.
  const added = await runDpkAction('pkg', { file: path, op: 'add', name: '@local/two' }, { home })
  const archivePath = join(home, 'bundle.dpks')
  assert.equal(added.data.file, archivePath)
  assert.equal(added.data.previous, path)
  assert.equal(existsSync(path), false, 'the document is gone; its content moved')
  assert.match(added.text, /2 packages \(dpks archive\)/)
  assert.match(added.text, /moved {4}.*bundle\.json was removed/)
  assert.deepEqual(added.data.packages.map(pkg => pkg.package), ['@local/one', '@local/two'])

  // Still readable as the archive it now is, and its volumes survive the trip.
  const listed = await runDpkAction('pkg', { file: archivePath, op: 'list' }, { home })
  assert.equal(listed.data.form, 'dpks')
  const bytes = await readFile(archivePath)
  assert.deepEqual(
    readDataFile(bytes, { where: archivePath }).find(pkg => pkg.package === '@local/two').files.map(file => file.path).sort(),
    ['app/sessions.json', 'data/settings.json'],
  )

  // Removing back down to one package demotes it: the archive is an archive
  // because it holds several, not because it was made that way.
  const removed = await runDpkAction('pkg', { file: archivePath, op: 'remove', name: '@local/two' }, { home })
  assert.equal(removed.data.file, path)
  assert.equal(existsSync(archivePath), false)
  assert.match(removed.text, /one package \(json document\)/)
  const back = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(back.format, DATA_FORMAT_SINGLE)
  assert.equal(back.package, '@local/one')
  assert.deepEqual(back.files.map(file => file.path), ['app/sessions.json'])
})

test('pkg set renames the package the file records, volumes untouched', async () => {
  const { home } = await twoPackages()
  const path = join(home, 'one.json')
  await runDpkAction('snap', { name: 'two', output: path }, { home })

  // `set` adjusts what the file says about a package: its name. The volumes are
  // not re-read from this machine, so they survive the rename byte for byte.
  const before = readDataFile(await readFile(path))[0]
  const renamed = await runDpkAction('pkg', { file: path, op: 'set', name: 'two', to: '@local/two-renamed' }, { home })

  assert.deepEqual(renamed.data.renamed, { from: '@local/two', to: '@local/two-renamed' })
  assert.match(renamed.text, /@local\/two → @local\/two-renamed/)
  const after = readDataFile(await readFile(path))[0]
  assert.equal(after.package, '@local/two-renamed')
  assert.deepEqual(after.files, before.files, 'the carried bytes are exactly what they were')

  // A name this machine does not have is allowed — a file handed to another
  // machine is the whole point — and the report says import will skip it here.
  assert.match(renamed.text, /is not installed here/)

  // Refusals: an entry the file does not carry, a name already in the file, the
  // same name, and something that is not a package name at all.
  await assert.rejects(
    () => runDpkAction('pkg', { file: path, op: 'set', name: 'one', to: '@local/x' }, { home }),
    /does not carry one; use op=add/,
  )
  await assert.rejects(
    () => runDpkAction('pkg', { file: path, op: 'remove', name: '@local/one' }, { home }),
    /does not carry @local\/one; use op=add/,
  )
  await assert.rejects(
    () => runDpkAction('pkg', { file: path, op: 'set', name: '@local/two', to: '@local/two-renamed' }, { home }),
    /does not carry @local\/two; use op=add/,
  )
  await assert.rejects(
    () => runDpkAction('pkg', { file: path, op: 'set', name: '@local/two-renamed', to: '@local/two-renamed' }, { home }),
    /already names it/,
  )
  await assert.rejects(
    () => runDpkAction('pkg', { file: path, op: 'set', name: '@local/two-renamed' }, { home }),
    /needs `to`/,
  )
  await assert.rejects(
    () => runDpkAction('pkg', { file: path, op: 'set', name: '@local/two-renamed', to: 'Not A Name' }, { home }),
    /is not a package name/,
  )
  assert.equal(JSON.parse(await readFile(path, 'utf8')).package, '@local/two-renamed', 'a refused rename wrote nothing')
})

test('renaming inside an archive rewrites the entry paths that carry the volumes', async () => {
  const { home } = await twoPackages()
  const path = join(home, 'both.dpks')
  await runDpkAction('snap', { all: true, output: path }, { home })

  const two = await runDpkAction('pkg', { file: path, op: 'set', name: 'two', to: 'two-fork' }, { home })

  assert.equal(two.data.form, 'dpks', 'the file still holds two packages, so it is still an archive')
  assert.deepEqual(two.data.packages.map(pkg => pkg.package), ['@local/one', 'two-fork'])
  const buffer = await readFile(path)
  const entryPaths = readZipIndex(buffer).entries.map(entry => entry.path)
  // The bytes live under the package name in the archive, so the rename has to
  // move them with it — otherwise the manifest would point at nothing.
  assert.equal(entryPaths.includes('data/two-fork/app/sessions.json'), true, entryPaths.join(' '))
  assert.equal(entryPaths.includes('data/two-fork/data/settings.json'), true)
  assert.equal(entryPaths.some(entry => entry.startsWith('data/@local/two/')), false, 'no entry keeps the old name')
  // And the manifest's own entry is refused a duplicate name.
  await assert.rejects(
    () => runDpkAction('pkg', { file: path, op: 'set', name: 'one', to: 'two-fork' }, { home }),
    /already carries two-fork; two entries cannot share a name/,
  )
})

test('pkg add refreshes an entry the file already carries', async () => {
  const { home } = await twoPackages()
  const path = join(home, 'one.json')
  await runDpkAction('export', { name: 'two', output: path }, { home })
  assert.deepEqual(readDataFile(await readFile(path))[0].files.map(file => file.path), ['app/sessions.json'])

  // `add` is the one operation that reads this machine, so an entry that is
  // already there is brought up to date instead of being refused: that is how a
  // file follows what is installed now. `verb` picks the class scope.
  const refreshed = await runDpkAction('pkg', { file: path, op: 'add', name: 'two' }, { home })
  assert.equal(refreshed.data.refreshed, true)
  assert.match(refreshed.text, /refresh @local\/two/)
  assert.deepEqual(
    readDataFile(await readFile(path))[0].files.map(file => file.path).sort(),
    ['app/sessions.json', 'data/settings.json'],
  )

  const narrowed = await runDpkAction('pkg', { file: path, op: 'add', name: 'two', verb: 'export' }, { home })
  assert.equal(narrowed.data.form, 'dpk')
  assert.deepEqual(readDataFile(await readFile(path))[0].files.map(file => file.path), ['app/sessions.json'])

  // A bare name resolves through the ledger, so `two` and `@local/two` are the
  // same package to every verb here.
  const again = await runDpkAction('pkg', { file: path, op: 'add', name: '@local/two' }, { home })
  assert.equal(again.data.packages.length, 1, 'the same package is one entry, however it is spelled')
})

test('a hand-made document holding several packages is read, not refused', async () => {
  const { home } = await twoPackages()
  // Someone bypassed the tool: the document says one package and lists entries
  // for two. The entries name their own package, so the file is readable — and
  // `pkg` normalizes it into the form its content calls for on the next write.
  const path = join(home, 'forced.json')
  await writeFile(path, `${JSON.stringify({
    format: DATA_FORMAT_SINGLE,
    package: '@local/one',
    files: [
      { path: 'app/sessions.json', bytes: Buffer.from('{"from":"one"}\n').toString('base64') },
      { package: '@local/two', path: 'app/sessions.json', bytes: Buffer.from('{"from":"two"}\n').toString('base64') },
    ],
  }, undefined, 2)}\n`)

  const listed = await runDpkAction('pkg', { file: path, op: 'list' }, { home })
  assert.equal(listed.data.form, 'dpks', 'two packages are the archive form, whatever the document says')
  assert.deepEqual(listed.data.packages.map(pkg => pkg.package), ['@local/one', '@local/two'])

  // Importing from it lands both packages, since both are recorded here.
  await rm(dataRoot(home, '@local/one'), { recursive: true, force: true })
  await rm(dataRoot(home, '@local/two'), { recursive: true, force: true })
  const imported = await runDpkAction('import', { file: path }, { home })
  assert.match(imported.text, /imported 1 volume\(s\) for @local\/one/)
  assert.match(imported.text, /imported 1 volume\(s\) for @local\/two/)

  // And a write straightens it out into the archive it always was.
  const removed = await runDpkAction('pkg', { file: path, op: 'remove', name: '@local/two' }, { home })
  assert.equal(removed.data.form, 'dpk')
  assert.deepEqual(JSON.parse(await readFile(removed.data.file, 'utf8')).files.map(file => file.path), ['app/sessions.json'])
})

test('a pkg write is atomic and leaves no staging file behind', async () => {
  const { home } = await twoPackages()
  const path = join(home, 'atomic.json')
  await runDpkAction('snap', { name: 'one', output: path }, { home })

  // `add` grows the file to two packages, so it lands under the archive name.
  const added = await runDpkAction('pkg', { file: path, op: 'add', name: 'two' }, { home })

  // The write lands by rename, so the directory only ever holds the file itself
  // — no `.tmp-` sibling left behind.
  assert.deepEqual((await readdir(home)).filter(name => name.startsWith('atomic')), [added.data.file.split('\\').pop()])

  // A file that cannot be read is reported, not half-rewritten.
  const broken = join(home, 'broken.json')
  await writeFile(broken, 'not json at all\n')
  await assert.rejects(() => runDpkAction('pkg', { file: broken, op: 'add', name: 'one' }, { home }), /not valid JSON/)
  assert.equal(await readFile(broken, 'utf8'), 'not json at all\n')

  await assert.rejects(() => runDpkAction('pkg', { file: added.data.file, op: 'add' }, { home }), /needs `name`/)
  await assert.rejects(() => runDpkAction('pkg', { file: added.data.file, op: 'merge', name: 'one' }, { home }), /pkg needs `op`/)
  await assert.rejects(
    () => runDpkAction('pkg', { file: added.data.file, op: 'add', name: 'one', verb: 'pack' }, { home }),
    /pkg needs `verb`/,
  )
  await assert.rejects(() => runDpkAction('pkg', { file: join(home, 'absent.json'), op: 'list' }, { home }), /no such file/)
})

test('a package archive is not a data file, and pkg says so', async () => {
  const { home } = await twoPackages()
  // A `.dpk` is a package archive: a zip whose manifest is `dpk.json`. Reading
  // it as a data file has to fail with something a caller can act on.
  const archive = writeZip([
    { path: 'dpk.json', data: Buffer.from('{"name":"x"}', 'utf8'), mode: 0o644 },
  ])
  const path = join(home, 'package.dpk')
  await writeFile(path, archive)
  await assert.rejects(() => runDpkAction('pkg', { file: path, op: 'list' }, { home }), /has no dpks\.json/)
})

test('the reader takes the archive form too, and buildDataFile round-trips it', async () => {
  const packages = [
    { package: '@local/a', files: [{ path: 'app/x.json', bytes: Buffer.from('a') }] },
    { package: '@local/b', files: [{ path: 'data/y.json', bytes: Buffer.from('b') }] },
  ]
  const archive = buildDataFile(packages, { form: 'dpks' })
  assert.equal(archive.extension, '.dpks')
  const read = readDataFile(archive.buffer, { where: 'x.dpks' })
  assert.deepEqual(read.map(pkg => [pkg.package, pkg.files.map(file => file.path)]), [
    ['@local/a', ['app/x.json']],
    ['@local/b', ['data/y.json']],
  ])
  assert.equal(read[1].files[0].bytes.toString('utf8'), 'b')
  assert.equal(readZipIndex(archive.buffer).entries.some(entry => entry.path === 'data/@local/b/data/y.json'), true)
  assert.equal(
    JSON.parse(readZipEntry(archive.buffer, readZipIndex(archive.buffer).entries.find(entry => entry.path === 'dpks.json')).toString('utf8')).packages.length,
    2,
  )

  const document = buildDataFile([packages[0]], { form: 'dpk' })
  assert.equal(document.extension, '.json')
  assert.deepEqual(readDataFile(document.buffer, { where: 'x.json' }).map(pkg => pkg.package), ['@local/a'])
})
