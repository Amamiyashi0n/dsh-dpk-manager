/** Action layer: the behaviour shared by the in-session `dpk` tool and the panel. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { DpkActionError, runDpkAction } from '../src/lib/actions.mjs'
import { archiveFileName } from '../src/lib/dpk-manifest.mjs'
import { packDirectory } from '../src/lib/pack.mjs'
import { dpkRoot, readIndex, recordInstall, restartPending, storeDir } from '../src/lib/store.mjs'
import { dataRoot, volumePath } from '../src/lib/data.mjs'
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

test('an install the official service applies needs no restart', async () => {
  // The profile write alone is only loadable, and dpk used to say so: "live at
  // the next Harness start". With the service composed, dpk asks it to apply
  // (`setBundleEnabled` — a reconcile, no pnpm) and reports what it got, so an
  // install is usable the moment it returns.
  const packed = await packedFixture()
  const home = await makeHome()
  const file = join(home, 'x.dpk')
  await profileUsing(home, 'probe')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, packed.buffer)

  const asked = []
  const live = await runDpkAction('install', { file }, {
    home,
    profile: 'probe',
    apply: async (name, enabled) => { asked.push([name, enabled]); return { application: 'applied', changed: true } },
  })
  assert.deepEqual(asked, [['@local/dpk-fixture', true]])
  assert.equal(live.data.live, true)
  assert.match(live.text, /live {5}applied to the running Harness/)
  const entries = (await readIndex(dpkRoot(home))).entries
  assert.equal(entries[0].live, true)
  assert.equal(restartPending(entries), false, 'an applied install owes no restart')

  // A startup profile (or another profile) answers restart-required, and then
  // the entry says so — dpk never passes one answer off as the other.
  const home2 = await makeHome()
  const file2 = join(home2, 'x.dpk')
  await profileUsing(home2, 'probe')
  await writeFile(file2, packed.buffer)
  const pending = await runDpkAction('install', { file: file2 }, {
    home: home2,
    profile: 'probe',
    apply: async () => ({ application: 'restart-required', changed: true }),
  })
  assert.equal(pending.data.live, false)
  // The reminder names the package and the moment it arrives: a restart the
  // user cannot act on is worse than one they can.
  assert.match(pending.text, /@local\/dpk-fixture@1\.0\.0 will be loaded at the next DeepSeek Harness start/)
  const entries2 = (await readIndex(dpkRoot(home2))).entries
  assert.equal(entries2[0].live, undefined)
  assert.equal(restartPending(entries2), true)

  // The panel/tool strict mode refuses the same restart-only answer and rolls
  // the new profile and store copy back instead of leaving pending state.
  const home3 = await makeHome()
  const file3 = join(home3, 'x.dpk')
  await profileUsing(home3, 'probe')
  await writeFile(file3, packed.buffer)
  const strictApplyCalls = []
  await assert.rejects(
    runDpkAction('install', { file: file3 }, {
      home: home3,
      profile: 'probe',
      requireLive: true,
      apply: async (_name, enabled) => {
        strictApplyCalls.push(enabled)
        return { application: 'restart-required', changed: true }
      },
    }),
    /refusing a restart-only install/,
  )
  assert.deepEqual(strictApplyCalls, [true, false], 'a restart-only install is unloaded before its profile rollback')
  const manifest3 = JSON.parse(await readFile(join(home3, 'profiles', 'probe', 'package.json'), 'utf8'))
  assert.deepEqual(manifest3.dependencies, {}, 'strict install restores the profile')
  assert.equal(existsSync(join(dpkRoot(home3), 'store', packed.manifest.integrity.digest)), false, 'strict install removes its new store copy')

  // `live` describes that one process, not the package: a later run that does
  // not apply must clear it, or a restart would look unnecessary forever.
  const again = await runDpkAction('install', { file, reinstall: true }, { home, profile: 'probe' })
  assert.equal(again.data.live, false)
  assert.equal(restartPending((await readIndex(dpkRoot(home))).entries), true)
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

test('remove keeps managed data and purge deletes it explicitly', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makePackage({
    manifest: {
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        data: { volumes: [{ id: 'session', class: 'app', path: 'session.json' }] },
      },
    },
  }))
  const file = join(home, 'fixture.dpk')
  await writeFile(file, packed.buffer)
  const profile = 'probe'
  await profileUsing(home, profile)
  await runDpkAction('install', { file }, { home, profile })
  const data = volumePath(home, '@local/dpk-fixture', { id: 'session', class: 'app', path: 'session.json' })
  await mkdir(join(data, '..'), { recursive: true })
  await writeFile(data, '{"keep":true}\n')

  await runDpkAction('remove', { name: 'dpk-fixture' }, { home, profile })
  assert.equal(await readFile(data, 'utf8'), '{"keep":true}\n', 'remove leaves the data volume in place')

  await runDpkAction('purge', { name: 'dpk-fixture' }, { home })
  assert.equal(existsSync(dataRoot(home, '@local/dpk-fixture')), false, 'purge removes the complete data root')
})

test('uninstalling unloads the bundle from the running Harness', async () => {
  // Install and removal are one behaviour in two directions: the profile write
  // decides what the next start loads, and the official service is asked to
  // reconcile the running process now. Without that, a removed package keeps
  // running until a restart — the gap this test exists to keep closed.
  const { home, profile } = await installedFixture()

  const asked = []
  const removed = await runDpkAction('remove', { name: 'dpk-fixture' }, {
    home,
    profile,
    apply: async (name, enabled) => { asked.push([name, enabled]); return { application: 'applied', changed: true } },
  })

  assert.deepEqual(asked, [['@local/dpk-fixture', false]], 'asked the service to unload exactly this bundle')
  assert.equal(removed.data.live, true)
  assert.match(removed.text, /live {5}unloaded from the running Harness/)

  // A service that answers restart-required (or is absent) is reported as such:
  // dpk never claims an unload it did not get.
  const { home: home2, profile: profile2 } = await installedFixture()
  const pending = await runDpkAction('remove', { name: 'dpk-fixture' }, {
    home: home2,
    profile: profile2,
    apply: async () => ({ application: 'restart-required', changed: true }),
  })
  assert.equal(pending.data.live, false)
  assert.match(pending.text, /@local\/dpk-fixture will be unloaded at the next DeepSeek Harness start/)

  const { home: home3, profile: profile3 } = await installedFixture()
  const bare = await runDpkAction('remove', { name: 'dpk-fixture' }, { home: home3, profile: profile3 })
  assert.equal(bare.data.live, false)
  assert.match(bare.text, /@local\/dpk-fixture will be unloaded at the next DeepSeek Harness start/)

  const strictFixture = await installedFixture()
  const strictProfileFile = join(strictFixture.home, 'profiles', strictFixture.profile, 'package.json')
  const strictApplyCalls = []
  await assert.rejects(
    runDpkAction('remove', { name: 'dpk-fixture' }, {
      home: strictFixture.home,
      profile: strictFixture.profile,
      requireLive: true,
      apply: async (_name, enabled) => {
        strictApplyCalls.push(enabled)
        const manifest = JSON.parse(await readFile(strictProfileFile, 'utf8'))
        manifest.dsh.profile.bundles = enabled ? ['@local/dpk-fixture'] : []
        await writeFile(strictProfileFile, `${JSON.stringify(manifest)}\n`)
        return { application: 'restart-required', changed: true }
      },
    }),
    /live unload .* was not applied; the local uninstall was not performed/,
  )
  assert.deepEqual(strictApplyCalls, [false, true], 'a restart-only unload restores the official bundle selection')
  const strictManifest = JSON.parse(await readFile(strictProfileFile, 'utf8'))
  assert.equal(Object.hasOwn(strictManifest.dependencies, '@local/dpk-fixture'), true, 'strict uninstall keeps the profile')
  assert.deepEqual(strictManifest.dsh.profile.bundles, ['@local/dpk-fixture'], 'strict uninstall restores the bundle list')
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

test('remove name@version refuses to remove a different version held by the profile', async () => {
  const home = await makeHome()
  const profile = 'probe'
  await profileUsing(home, profile)
  const v1 = await packDirectory(await makePackage({ manifest: { version: '1.0.0' } }))
  const v2 = await packDirectory(await makePackage({ manifest: { version: '2.0.0' } }))
  const first = join(home, 'one.dpk')
  const second = join(home, 'two.dpk')
  await writeFile(first, v1.buffer)
  await writeFile(second, v2.buffer)
  await runDpkAction('install', { file: first }, { home, profile })
  await runDpkAction('install', { file: second }, { home, profile })

  await assert.rejects(
    runDpkAction('remove', { name: 'dpk-fixture@1.0.0' }, { home, profile }),
    error => error instanceof DpkActionError && /does not hold @local\/dpk-fixture@1\.0\.0/.test(error.message),
  )
  const manifest = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
  assert.match(manifest.dependencies['@local/dpk-fixture'], new RegExp(v2.manifest.integrity.digest))
})

test('unknown actions and missing arguments are caller mistakes', async () => {
  await assert.rejects(runDpkAction('frobnicate', {}, {}), error => error instanceof DpkActionError)
  await assert.rejects(runDpkAction('build', {}, {}), error => /build needs `directory`/.test(error.message))
  await assert.rejects(runDpkAction('show', {}, {}), error => /show needs exactly one of/.test(error.message))
  await assert.rejects(runDpkAction('install', {}, {}), error => /needs `file`/.test(error.message))
})
