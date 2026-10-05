/** Action layer: the behaviour shared by the in-session `dpk` tool and the panel. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { DpkActionError, runDpkAction } from '../lib/actions.mjs'
import { archiveFileName } from '../lib/dpk-manifest.mjs'
import { packDirectory } from '../lib/pack.mjs'
import { dpkRoot, recordInstall, storeDir } from '../lib/store.mjs'
import { makeHome, makePackage, profileUsing, storeEntry } from './helpers.mjs'

async function packedFixture() {
  const root = await makePackage()
  return packDirectory(root)
}

/** Install the fixture into a fresh profile and return what the test needs. */
async function installedFixture(profile = 'probe') {
  const home = await makeHome()
  const packed = await packedFixture()
  const file = join(home, 'fixture.dpk')
  await writeFile(file, packed.buffer)
  await profileUsing(home, profile)
  const result = await runDpkAction('install', { file }, { home, profile })
  return { home, packed, result, profile, digest: packed.manifest.integrity.digest }
}

test('verify needs a file', async () => {
  await assert.rejects(runDpkAction('verify', {}, {}), error => error instanceof DpkActionError && /needs `file`/.test(error.message))
})

test('verify and show work on a real archive', async () => {
  const packed = await packedFixture()
  const home = await makeHome()
  const file = join(home, 'fixture.dpk')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, packed.buffer)

  const verified = await runDpkAction('verify', { file }, {})
  assert.equal(verified.data.name, '@local/dpk-fixture')
  assert.equal(verified.data.files, 5)
  assert.match(verified.text, /verdict {2}valid/)

  const described = await runDpkAction('show', { file }, {})
  assert.equal(described.data.manifest.integrity.digest, packed.manifest.integrity.digest)
  assert.match(described.text, /"generator": "dpk\//)
})

test('show on an installed package answers version, store path, profiles and volumes', async () => {
  const { home, digest, profile } = await installedFixture()

  const result = await runDpkAction('show', { name: 'dpk-fixture' }, { home, profile })

  assert.equal(result.data.name, '@local/dpk-fixture')
  assert.equal(result.data.digest, digest)
  assert.ok(result.data.packageDir.endsWith(join(digest, 'package')))
  assert.deepEqual(result.data.profiles, [profile])
  assert.deepEqual(result.data.broken, [])
  assert.match(result.text, /used by {2}probe {2}ok/)
})

test('show needs exactly one of file and name', async () => {
  await assert.rejects(
    runDpkAction('show', { file: 'x.dpk', name: 'x' }, {}),
    (error) => error instanceof DpkActionError && /exactly one of/.test(error.message),
  )
})

test('pack writes an archive and reports its digest', async () => {
  const root = await makePackage()
  const home = await makeHome()
  const output = join(home, 'out.dpk')
  const result = await runDpkAction('build', { directory: root, output }, {})
  assert.ok(existsSync(output))
  assert.equal(result.data.digest, (await packDirectory(root)).manifest.integrity.digest)
  assert.equal((await readFile(output)).length, result.data.bytes)
})

test('build without `output` writes <package>/dpk-dist/<name>-<version>.dpk', async () => {
  // The archive belongs next to the package it came from, not in whatever
  // directory the caller stood in — and that directory is dpk's to create.
  const root = await makePackage()
  const packed = await packDirectory(root)
  const standard = archiveFileName(packed.manifest.name, packed.manifest.version)
  const result = await runDpkAction('build', { directory: root }, {})
  const expected = join(root, 'dpk-dist', standard)
  assert.equal(result.data.output, expected)
  assert.equal(existsSync(expected), true)
  assert.deepEqual(await readFile(expected), packed.buffer)

  // Packing the same tree again must not refuse itself over the archive it
  // just wrote there: `dpk-dist/` is never-packed, like `dist/`.
  const again = await runDpkAction('build', { directory: root }, {})
  assert.equal(again.data.digest, result.data.digest)
})

test('build writes into a directory when `output` names one, creating it if needed', async () => {
  const root = await makePackage()
  const home = await makeHome()
  const packed = await packDirectory(root)
  const standard = archiveFileName(packed.manifest.name, packed.manifest.version)

  // A path written with a trailing separator, a path that already IS a
  // directory, and a fresh nested directory all land the standard file name
  // inside — and the directory is created rather than reported as ENOENT, so
  // `build … output=<package>/dpk-dist/` needs no mkdir (and no build script).
  const trailing = join(home, 'dpk-dist') + sep
  const fromTrailing = await runDpkAction('build', { directory: root, output: trailing }, {})
  assert.equal(fromTrailing.data.output, join(home, 'dpk-dist', standard))
  assert.equal(existsSync(fromTrailing.data.output), true)

  await mkdir(join(home, 'existing'), { recursive: true })
  const fromExisting = await runDpkAction('build', { directory: root, output: join(home, 'existing') }, {})
  assert.equal(fromExisting.data.output, join(home, 'existing', standard))

  const nested = join(home, 'a', 'b', 'c.dpk')
  const fromNested = await runDpkAction('build', { directory: root, output: nested }, {})
  assert.equal(fromNested.data.output, nested, 'a file path is still a file path')
  assert.equal(existsSync(nested), true, 'its parent directories are created')

  // All three carried the same bytes as a plain pack of the same tree.
  for (const file of [fromTrailing, fromExisting, fromNested]) {
    assert.deepEqual(await readFile(file.data.output), packed.buffer, file.data.output)
  }
})

test('pack can record real build provenance on request', async () => {
  const root = await makePackage()
  const home = await makeHome()
  const result = await runDpkAction('build', { directory: root, output: join(home, 'now.dpk'), createdAt: 'now' }, {})
  assert.notEqual(result.data.digest, undefined)
  assert.match(result.text, /wrote/)
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
  assert.ok(existsSync(join(result.data.storePath, 'package.json')))
  assert.match(result.text, /installed by the plugin manager service/)

  const listed = await runDpkAction('list', {}, { home })
  assert.equal(listed.data.entries.length, 1)
  assert.equal(listed.data.entries[0].version, '1.0.0')
  assert.equal(listed.data.entries[0].digest, result.data.digest)
  // The injected installer wrote no profile row, so no profile references the
  // digest and `list` says so instead of repeating what the ledger once saw.
  assert.deepEqual(listed.data.entries[0].profiles, [])
  assert.match(listed.text, /no profile references/)

  const shown = await runDpkAction('show', { name: '@local/dpk-fixture' }, { home })
  const normalise = value => value.replaceAll('\\', '/')
  assert.ok(normalise(shown.text).includes(normalise(result.data.storePath)))
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
  await assert.rejects(runDpkAction('show', { name: 'nope' }, { home }), error => error instanceof DpkActionError)
})

test('a request may name a @local/ package by its own name', async () => {
  const { home, digest } = await installedFixture()

  // The ledger holds the localized name; the user types the package's own.
  const quoted = await runDpkAction('show', { name: 'dpk-fixture' }, { home })
  assert.equal(quoted.data.digest, digest)
  assert.equal(quoted.data.name, '@local/dpk-fixture')
})

test('a bare name answers with the newest version, not the ledger\'s first row', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  // Two versions of one package is what two profiles resolving different
  // digests leave behind. The ledger is written name-then-version order, so its
  // first match for a bare name is the older one — and these two versions sort
  // that way lexically as well, which is exactly the trap.
  for (const [version, digest] of [['2.1.10', 'a'.repeat(64)], ['2.1.11', 'b'.repeat(64)]]) {
    await storeEntry(root, digest, {
      manifest: {
        name: '@local/two-versions',
        version,
        dsh: { data: { volumes: [{ id: 'sessions', class: 'app', path: 'sessions.json' }] } },
      },
    })
    await recordInstall(root, { name: '@local/two-versions', version, digest, source: `${version}.dpk` })
  }

  const shown = await runDpkAction('show', { name: 'two-versions' }, { home })

  assert.equal(shown.data.entry.version, '2.1.11', 'the newest recorded version answers')
  assert.equal(shown.data.digest, 'b'.repeat(64))
  // An explicit name@version still selects exactly that one.
  const pinned = await runDpkAction('show', { name: 'two-versions@2.1.10' }, { home })
  assert.equal(pinned.data.entry.version, '2.1.10')
})

test('show reports a package whose stored declaration cannot be read instead of throwing', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  // A store copy older than the class rename still on disk — exactly the
  // package a user runs `show` on to find out what is wrong with it.
  await storeEntry(root, 'e'.repeat(64), {
    name: '@local/legacy',
    manifest: {
      name: '@local/legacy',
      version: '1.0.0',
      dsh: { data: { volumes: [{ id: 'providers', class: 'config', path: 'providers.json' }] } },
    },
  })
  await recordInstall(root, { name: '@local/legacy', version: '1.0.0', digest: 'e'.repeat(64), source: 'legacy.dpk' })

  const result = await runDpkAction('show', { name: 'legacy' }, { home })

  assert.equal(result.data.name, '@local/legacy', 'the identity is reported')
  assert.match(result.text, /version {2}1\.0\.0/, 'version and store facts survive')
  assert.match(result.text, /declaration unreadable: .*class must be one of data, app/)
  assert.match(result.text, /\(declaration unreadable; see the broken line above\)/)
  assert.deepEqual(result.data.volumes, [], 'no volume rows pretend the declaration was read')
})

test('uninstall by the package\'s own name removes the row and reclaims the copy', async () => {
  const { home, profile, digest } = await installedFixture()

  const removed = await runDpkAction('remove', { name: 'dpk-fixture' }, { home, profile })

  assert.equal(removed.data.name, '@local/dpk-fixture')
  assert.deepEqual(removed.data.dropped, [digest])
  assert.equal(existsSync(storeDir(dpkRoot(home), digest)), false)
  const listed = await runDpkAction('list', {}, { home })
  assert.equal(listed.data.entries.length, 0)
  assert.deepEqual(listed.data.broken, [], 'nothing left to load, nothing broken')
})

test('uninstalling collects only the copy that profile resolved', async () => {
  const { home, profile, digest } = await installedFixture()
  const root = dpkRoot(home)
  // An unrelated unreferenced digest, the kind only `autoremove` may collect.
  const unrelated = await storeEntry(root, 'b'.repeat(64), { manifest: { name: '@local/unrelated', version: '9.9.9' } })
  await recordInstall(root, { name: '@local/unrelated', version: '9.9.9', digest: 'b'.repeat(64), source: 'C:/gone/unrelated.dpk' })

  const removed = await runDpkAction('remove', { name: 'dpk-fixture' }, { home, profile })

  assert.deepEqual(removed.data.dropped, [digest], 'only the dropped package\'s digest')
  assert.equal(existsSync(unrelated), true, 'the unrelated copy survives')
})

test('uninstalling what the profile does not hold fails instead of claiming success', async () => {
  const { home, profile } = await installedFixture()

  await assert.rejects(
    runDpkAction('remove', { name: 'something-else' }, { home, profile }),
    (error) => error instanceof DpkActionError
      && /does not hold @local\/something-else; nothing was removed/.test(error.message)
      && /it holds @local\/dpk-fixture/.test(error.message),
  )
})

test('unknown actions and missing arguments are caller mistakes', async () => {
  await assert.rejects(runDpkAction('frobnicate', {}, {}), error => error instanceof DpkActionError)
  await assert.rejects(runDpkAction('build', {}, {}), error => /build needs `directory`/.test(error.message))
  await assert.rejects(runDpkAction('show', {}, {}), error => /show needs exactly one of/.test(error.message))
  await assert.rejects(runDpkAction('install', {}, {}), error => /needs `file`/.test(error.message))
})
