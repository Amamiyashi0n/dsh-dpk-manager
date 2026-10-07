/** Install semantics: store layout, idempotency, the official-installer hand-off, and the profile policy write. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packDirectory } from '../src/lib/pack.mjs'
import { installArchive, installOverwriting, serviceInstall } from '../src/lib/install.mjs'
import { linkSpecifier, profileDir, readProfileManifest, referencedDigests } from '../src/lib/profile-install.mjs'
import { disableReleaseAgeCooldown } from '../src/lib/profile-policy.mjs'
import { dpkRoot, readIndex, storeDir } from '../src/lib/store.mjs'
import { compareVersions } from '../src/lib/versions.mjs'
import { archiveCopies, makeHome, makePackage } from './helpers.mjs'

/** A profile directory with the parts every real profile has. */
async function makeProfile(home, profile) {
  const dir = profileDir(home, profile)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, undefined, 2)}\n`)
  return dir
}

/** An installer that records the call instead of running pnpm. */
function recorder() {
  const calls = []
  return { calls, installer: async (packageDir, meta) => { calls.push([packageDir, meta]) } }
}

/** A manager whose first install cannot diff the unchanged row, like the official one on a re-import. */
function ambiguousManager() {
  const seen = []
  const manager = {
    seen,
    installBundle: async (dir) => {
      seen.push(['install', dir])
      return seen.filter(call => call[0] === 'install').length === 1
        ? { application: 'failed', error: { diagnostic: 'ambiguous-install' } }
        : { application: 'applied', changed: true }
    },
    removeBundle: async (name) => { seen.push(['remove', name]); return { changed: true } },
  }
  return manager
}

async function packFixture(manifest) {
  const root = await makePackage(manifest === undefined ? {} : { manifest })
  return packDirectory(root)
}

/** The workspace file an install may touch, as the install itself resolves it. */
function workspaceOf(home, profile) {
  return join(home, 'profiles', profile, 'pnpm-workspace.yaml')
}

test('verifies, extracts into the store, and hands the official installer an absolute package path', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const exec = recorder()
  const result = await installArchive({
    file: 'fixture.dpk',
    buffer: packed.buffer,
    home,
    profile: 'test',
    installer: exec.installer,
    log: () => {},
  })

  const root = dpkRoot(home)
  const packageDir = join(storeDir(root, packed.manifest.integrity.digest), 'package')
  assert.equal(result.packageDir, packageDir)
  assert.equal(result.created, true)
  assert.ok(existsSync(join(packageDir, 'package.json')), 'the store holds the package root')

  assert.equal(exec.calls.length, 1)
  assert.equal(exec.calls[0][0], packageDir)
  assert.deepEqual(
    { ...exec.calls[0][1], isSatisfied: undefined },
     { name: '@local/dpk-fixture', version: '1.0.0', digest: packed.manifest.integrity.digest, profile: 'test', isSatisfied: undefined },
  )
  assert.equal(typeof exec.calls[0][1].isSatisfied, 'function', 'the installer can ask whether the profile already resolves this package')
  assert.equal(result.via, 'service')

  const index = await readIndex(root)
  assert.equal(index.entries.length, 1)
  assert.equal(index.entries[0].name, '@local/dpk-fixture')
  assert.equal(index.entries[0].digest, packed.manifest.integrity.digest)
  // The ledger records provenance only; which profile uses the digest is read
  // from the profile itself (this installer stub writes no profile row).
  assert.equal(index.entries[0].profiles, undefined)
  assert.equal(Object.hasOwn(index.entries[0], 'path'), false, 'the store path stays derivable from the digest')
})

test('is idempotent: the same digest is extracted once', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const first = await installArchive({ file: 'a.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  const second = await installArchive({ file: 'b.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  const entries = await readdir(join(dpkRoot(home), 'store'))
  assert.deepEqual(entries, [packed.manifest.integrity.digest])
  const index = await readIndex(dpkRoot(home))
  assert.equal(index.entries.length, 1, 'one ledger row per identity')
  // The cold install settles DSH conformance by extracting once; the re-import
  // must not pay for that tree again — it re-hashes the archive and says so.
  assert.ok(first.checks.some(check => check.startsWith('dsh: package.json passes strict conformance')), 'the cold path ran the deep check')
  assert.equal(first.warnings.some(warning => warning.includes('deep check skipped')), false)
  assert.ok(second.warnings.some(warning => warning.includes('deep check skipped')), second.warnings.join(' | '))
  assert.ok(second.notes.concat(second.checks).every(entry => !entry.startsWith('dsh: package.json passes strict conformance')))
})

test('strict live mode refuses a service replacement before changing the profile', async () => {
  const home = await makeHome()
  await makeProfile(home, 'test')
  const first = await packFixture({ version: '1.0.0' })
  const firstResult = await installArchive({ file: 'first.dpk', buffer: first.buffer, home, profile: 'test', log: () => {} })
  const second = await packFixture({ version: '2.0.0' })
  let called = false

  await assert.rejects(
    installArchive({
      file: 'second.dpk',
      buffer: second.buffer,
      home,
      profile: 'test',
      installMode: 'service',
      requireLive: true,
      installer: async () => { called = true },
      log: () => {},
    }),
    /cannot guarantee a live swap; install was refused/,
  )
  assert.equal(called, false, 'strict mode refuses before invoking the service installer')
  const manifest = await readProfileManifest(profileDir(home, 'test'))
  assert.equal(manifest.dependencies['@local/dpk-fixture'], linkSpecifier(firstResult.packageDir))
  assert.equal(existsSync(join(dpkRoot(home), 'store', second.manifest.integrity.digest)), false)
})

test('strict live mode refuses a profile write when no live service is available', async () => {
  const home = await makeHome()
  await makeProfile(home, 'test')
  const packed = await packFixture()

  await assert.rejects(
    installArchive({
      file: 'missing-live-service.dpk',
      buffer: packed.buffer,
      home,
      profile: 'test',
      requireLive: true,
      log: () => {},
    }),
    /was not applied to the running Harness/,
  )
  const manifest = await readProfileManifest(profileDir(home, 'test'))
  assert.deepEqual(manifest.dependencies, {}, 'strict install restores the profile without a live service')
  assert.equal(existsSync(join(dpkRoot(home), 'store', packed.manifest.integrity.digest)), false)
  assert.equal((await readIndex(dpkRoot(home))).entries.length, 0)
})

test('one digest installed into two profiles is one ledger row and two profile rows', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await makeProfile(home, 'web')
  await makeProfile(home, 'desktop')
  for (const profile of ['web', 'desktop']) {
    await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile, log: () => {} })
  }

  const root = dpkRoot(home)
  const digest = packed.manifest.integrity.digest
  const index = await readIndex(root)
  assert.equal(index.entries.length, 1, 'the ledger keys on identity, not on where it was installed')

  // "Which profile uses it" is answered by the profiles, and every profile that
  // resolves the digest is in the answer.
  const { references } = await referencedDigests({ home, root })
  assert.deepEqual([...references.keys()], [digest])
  assert.deepEqual([...references.get(digest)].sort(), ['desktop', 'web'])
  for (const profile of ['web', 'desktop']) {
    const manifest = await readProfileManifest(profileDir(home, profile))
    assert.equal(manifest.dependencies['@local/dpk-fixture'], linkSpecifier(join(storeDir(root, digest), 'package')))
  }
})

test('a failing installer rolls the store copy back and records nothing', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await assert.rejects(
    installArchive({
      file: 'x.dpk', buffer: packed.buffer, home, profile: 'test',
      installer: async () => { throw new Error('the plugin manager refused') },
      log: () => {},
    }),
    error => error instanceof Error && error.message.includes('plugin manager refused'),
  )
  assert.equal(existsSync(join(dpkRoot(home), 'index.json')), false, 'nothing was recorded')
  // The copy this call placed goes with it: the next attempt re-extracts rather
  // than finding a digest no profile resolves.
  assert.equal(existsSync(join(dpkRoot(home), 'store', packed.manifest.integrity.digest)), false)
})

test('a ledger failure rolls back a successful official-manager install', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const root = dpkRoot(home)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'index.json'), '{ broken ledger')
  const seen = []
  const manager = {
    installBundle: async () => { seen.push('install'); return { application: 'applied', changed: true } },
    removeBundle: async name => { seen.push(`remove:${name}`); return { changed: true } },
  }

  await assert.rejects(
    installArchive({
      file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', installMode: 'service',
      installer: (packageDir, meta) => serviceInstall(manager, packageDir, meta), log: () => {},
    }),
    /index\.json is not valid JSON/,
  )
  assert.deepEqual(seen, ['install', 'remove:@local/dpk-fixture'])
  assert.equal(existsSync(join(dpkRoot(home), 'store', packed.manifest.integrity.digest)), false)
})

test('without an installer the install writes the profile itself', async () => {
  const home = await makeHome()
  await makeProfile(home, 'test')
  const packed = await packFixture()

  const result = await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', log: () => {} })

  assert.equal(result.via, 'profile')
  assert.equal(result.installOutcome.application, 'applied')
  const manifest = JSON.parse(await readFile(join(home, 'profiles', 'test', 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@local/dpk-fixture'], `link:${result.packageDir}`.replace(/\\/g, '/'))
  assert.ok(existsSync(join(home, 'profiles', 'test', 'node_modules', '@local', 'dpk-fixture', 'package.json')))
  assert.equal(existsSync(join(dpkRoot(home), 'index.json')), true)
})

test('an unscoped multi-patch bundle localizes every patch file', async () => {
  const root = await makePackage({
    manifest: {
      name: 'multi-patch',
      dsh: { manifestVersion: 1, bundle: { patch: ['./cordis.patch.yml', './second.yml'] } },
    },
  })
  await writeFile(join(root, 'cordis.patch.yml'), "- insert:\n    - id: first\n      name: 'multi-patch'\n")
  await writeFile(join(root, 'second.yml'), "- insert:\n    - id: second\n      name: 'multi-patch'\n")
  const packed = await packDirectory(root)
  const home = await makeHome()
  await makeProfile(home, 'test')

  const result = await installArchive({ file: 'multi.dpk', buffer: packed.buffer, home, profile: 'test', log: () => {} })
  const stored = await readFile(join(result.packageDir, 'package.json'), 'utf8')
  const firstPatch = await readFile(join(result.packageDir, 'cordis.patch.yml'), 'utf8')
  const secondPatch = await readFile(join(result.packageDir, 'second.yml'), 'utf8')
  const profile = await readProfileManifest(profileDir(home, 'test'))

  assert.match(stored, /"name": "@local\/multi-patch"/)
  assert.match(firstPatch, /name: '@local\/multi-patch'/)
  assert.match(secondPatch, /name: '@local\/multi-patch'/)
  assert.deepEqual(profile.dsh.profile.bundles, ['@local/multi-patch'])
})

test('a corrupt archive never reaches the installer', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const exec = recorder()
  const corrupt = Buffer.from(packed.buffer)
  corrupt[40] ^= 0xff
  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: corrupt, home, profile: 'test', installer: exec.installer, log: () => {} }),
  )
  assert.equal(exec.calls.length, 0)
})

test('an install that cannot materialise its volumes leaves no half install', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makePackage({
    manifest: {
      name: '@local/dpk-fixture',
      version: '1.0.0',
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
    extraFiles: {
      'seeds/good.json': '{"v":1}\n',
      // Over the 1 MiB seed ceiling: pack and verify accept it, materialisation
      // refuses it — after the store copy exists, before the profile is written.
      'seeds/huge.json': Array.from({ length: 17000 }, (unused, index) => createHash('sha256').update(String(index)).digest('hex')).join(''),
    },
  }))
  await makeProfile(home, 'test')
  const before = await readFile(join(profileDir(home, 'test'), 'package.json'), 'utf8')

  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} }),
    /volume huge: seed exceeds/,
  )

  assert.equal(existsSync(join(dpkRoot(home), 'store', packed.manifest.integrity.digest)), false,
    'the copy this call placed is rolled back')
  assert.equal(await readFile(join(profileDir(home, 'test'), 'package.json'), 'utf8'), before, 'the profile is untouched')
  assert.equal(existsSync(join(home, 'data', '@local', 'dpk-fixture')), false, 'no volume was seeded')
  assert.equal(existsSync(join(dpkRoot(home), 'index.json')), false, 'nothing was recorded')
})

test('--reinstall re-extracts the same digest', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  const first = await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  await writeFile(join(first.packageDir, 'stray.txt'), 'leftover\n')
  const second = await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', reinstall: true, installer: recorder().installer, log: () => {} })
  assert.equal(second.created, true)
  assert.equal(existsSync(join(second.packageDir, 'stray.txt')), false, 'the directory was rebuilt')
  // The displaced previous copy is cleaned up in the same run: a reinstall must
  // not leave a second copy of the digest behind for `autoremove` to find.
  const stray = (await readdir(join(dpkRoot(home), 'store'))).filter(name => name.includes('.tmp-'))
  assert.deepEqual(stray, [], 'no displaced copy survives a successful reinstall')
})

test('an install keeps no second copy of the archive bytes', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await installArchive({
    file: 'x.dpk', buffer: packed.buffer, home, profile: 'test',
    installer: recorder().installer, log: () => {},
  })
  // The claim is about dpk's own behaviour: it must not store the .dpk it
  // consumed. What else lives in the dpk root is not dpk's business, so this
  // asks "did dpk keep a copy", not "does the directory have exactly N entries".
  const copies = await archiveCopies(join(dpkRoot(home)), packed.manifest.integrity.digest)
  assert.deepEqual(copies, [], 'the .dpk is the user\'s file; `export` rebuilds one on demand')
})

test('refuses to install without a DSH home', async () => {
  const packed = await packFixture()
  const exec = recorder()
  await assert.rejects(
    installArchive({ file: 'x.dpk', buffer: packed.buffer, home: '', installer: exec.installer, log: () => {} }),
    error => error.code === 'DPK_NO_HOME',
  )
  assert.equal(exec.calls.length, 0)
})

test('an install opts the profile out of the pnpm release-age cooldown', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await mkdir(join(home, 'profiles', 'test'), { recursive: true })
  await writeFile(workspaceOf(home, 'test'), 'packages:\n  - .\nnodeLinker: hoisted\n')
  await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  const text = await readFile(workspaceOf(home, 'test'), 'utf8')
  assert.ok(text.startsWith('packages:\n  - .\nnodeLinker: hoisted\n'), 'the existing settings are preserved')
  assert.ok(text.includes('minimumReleaseAge: 0'), 'the cooldown is disabled for the profile')
})

test('a policy the user configured explicitly is never rewritten', async () => {
  const home = await makeHome()
  const packed = await packFixture()
  await mkdir(join(home, 'profiles', 'test'), { recursive: true })
  await writeFile(workspaceOf(home, 'test'), 'packages:\n  - .\nminimumReleaseAge: 1440\n')
  await installArchive({ file: 'x.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  const text = await readFile(workspaceOf(home, 'test'), 'utf8')
  assert.equal(text, 'packages:\n  - .\nminimumReleaseAge: 1440\n', 'the explicit value stays')
})

test('disableReleaseAgeCooldown creates the workspace file when absent', async () => {
  const dir = await makeHome()
  assert.equal(await disableReleaseAgeCooldown(dir), true)
  assert.equal(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'), 'minimumReleaseAge: 0\n')
  assert.equal(await disableReleaseAgeCooldown(dir), false, 'the second call changes nothing')
})

test('installOverwriting retries an ambiguous re-import as remove+install', async () => {
  const manager = ambiguousManager()
  const outcome = await installOverwriting(manager, 'C:/store/pkg', 'fixture')
  assert.equal(outcome.application, 'applied')
  assert.deepEqual(manager.seen, [
    ['install', 'C:/store/pkg'],
    ['remove', 'fixture'],
    ['install', 'C:/store/pkg'],
  ])
})

test('installOverwriting does not touch the manager when the end state already holds', async () => {
  const manager = ambiguousManager()
  const outcome = await installOverwriting(manager, 'C:/store/pkg', 'fixture', { isSatisfied: async () => true })
  assert.equal(outcome.application, 'unchanged')
  assert.equal(outcome.unchanged, true)
  assert.deepEqual(manager.seen, [], 'no pnpm run at all')
})

test('installOverwriting reports unchanged instead of removing when the retry is refused', async () => {
  // The official manager refuses the remove half while the bundle is live
  // (`not-removable`), so an already-satisfied import must not reach it.
  const seen = []
  let installs = 0
  const manager = {
    installBundle: async () => {
      installs += 1
      seen.push('install')
      return { application: 'failed', error: { diagnostic: 'ambiguous-install' } }
    },
    removeBundle: async () => { seen.push('remove'); return { application: 'failed', error: { code: 'not-removable' } } },
  }
  const outcome = await installOverwriting(manager, 'C:/store/pkg', 'fixture', { isSatisfied: async () => true })
  assert.equal(outcome.unchanged, true)
  assert.equal(installs, 0)
  assert.deepEqual(seen, [])
})

test('installOverwriting surfaces a failure that is not the ambiguous case', async () => {
  const manager = {
    installBundle: async () => ({ application: 'failed', error: { diagnostic: 'registry refused' } }),
    removeBundle: async () => { throw new Error('must not be reached') },
  }
  const outcome = await installOverwriting(manager, 'C:/store/pkg', 'fixture')
  assert.equal(outcome.application, 'failed')
  assert.equal(outcome.error.diagnostic, 'registry refused')
})

test('installOverwriting reports a failing remove during the retry', async () => {
  const manager = {
    installBundle: async () => ({ application: 'failed', error: { code: 'ambiguous-install' } }),
    removeBundle: async () => ({ application: 'failed', error: { diagnostic: 'unload refused' } }),
  }
  await assert.rejects(
    installOverwriting(manager, 'C:/store/pkg', 'fixture'),
    error => error.message.includes('unload refused'),
  )
})

test('an unscoped source installs under the @local scope in store, ledger, and patch rows', async () => {
  const home = await makeHome()
  const dir = await makePackage({
    manifest: { name: 'plain-tool' },
    extraFiles: { 'cordis.patch.yml': "- insert:\n    - id: plain-tool\n      name: 'plain-tool'" },
  })
  const packed = await packDirectory(dir)
  assert.equal(packed.manifest.name, 'plain-tool', 'the archive manifest carries the bare name; the scope is an install-time marking')
  const exec = recorder()
  const result = await installArchive({
    file: 'plain.dpk', buffer: packed.buffer, home, profile: 'test',
    installer: exec.installer, log: () => {},
  })

  const stored = JSON.parse(await readFile(join(result.packageDir, 'package.json'), 'utf8'))
  assert.equal(stored.name, '@local/plain-tool', 'the store copy is re-scoped')
  const patch = await readFile(join(result.packageDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes("name: '@local/plain-tool'"), `patch rows name the scoped package:\n${patch}`)
  assert.ok(!/name:\s*'plain-tool'/.test(patch), 'no row keeps the unscoped name')

  const index = await readIndex(dpkRoot(home))
  assert.equal(index.entries[0].name, '@local/plain-tool', 'the ledger records the scoped name')
})

test('unscoped patch localization also handles an inline YAML comment', async () => {
  const home = await makeHome()
  const dir = await makePackage({
    manifest: { name: 'commented-tool' },
    extraFiles: { 'cordis.patch.yml': '- insert:\n    - id: commented-tool\n      name: commented-tool # keep this note' },
  })
  const packed = await packDirectory(dir)
  const result = await installArchive({ file: 'commented.dpk', buffer: packed.buffer, home, profile: 'test', installer: recorder().installer, log: () => {} })
  const patch = await readFile(join(result.packageDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch, '- insert:\n    - id: commented-tool\n      name: @local/commented-tool # keep this note')
})

test('version comparison follows SemVer prerelease and build rules', () => {
  assert.equal(compareVersions('1.0.1+build.1', '1.0.1+build.2'), 0)
  assert.equal(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2') > 0, true)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1') > 0, true)
})

test('writeIndex leaves no temp file behind and reads back identically', async () => {
  const { writeIndex, readIndex, dpkRoot } = await import('../src/lib/store.mjs')
  const { readdir } = await import('node:fs/promises')
  const home = await makeHome()
  const root = dpkRoot(home)
  const index = { entries: [{ name: '@local/x', version: '1.0.0', digest: 'a'.repeat(64), installedAt: '2026-01-01T00:00:00.000Z', source: 'x.dpk' }] }
  await writeIndex(root, index)
  const files = (await readdir(root)).filter(name => name.includes('.tmp-'))
  assert.deepEqual(files, [], 'no temp file survives a successful write')
  assert.deepEqual((await readIndex(root)).entries, index.entries)
})

test('the ledger is read back as written', async () => {
  const { writeIndex, readIndex, dpkRoot } = await import('../src/lib/store.mjs')
  const home = await makeHome()
  const root = dpkRoot(home)
  await writeIndex(root, {
    entries: [{
      name: '@local/x',
      version: '1.0.0',
      digest: 'a'.repeat(64),
      installedAt: '2026-01-01T00:00:00.000Z',
      source: 'x.dpk',
    }],
  })
  const [entry] = (await readIndex(root)).entries
  assert.deepEqual(Object.keys(entry).sort(), ['digest', 'installedAt', 'name', 'source', 'version'])
})

test('concurrent ledger writes serialize: both apply in order, no temp left, no lost rename', async () => {
  const { writeIndex, readIndex, dpkRoot } = await import('../src/lib/store.mjs')
  const { readdir } = await import('node:fs/promises')
  const home = await makeHome()
  const root = dpkRoot(home)
  const entry = suffix => ({ name: '@local/x', version: `1.0.${String(suffix)}`, digest: 'a'.repeat(64), installedAt: '', source: '', profiles: ['test'], path: '' })
  // 卸载→立刻装新版的真实形态:两个 writeIndex 几乎同时进入
  await Promise.all([
    writeIndex(root, { entries: [entry(1)] }),
    writeIndex(root, { entries: [entry(1), entry(2)] }),
  ])
  const files = (await readdir(root)).filter(name => name.includes('.tmp-'))
  assert.deepEqual(files, [], 'no temp file survives concurrent writes')
  const after = (await readIndex(root)).entries.map(e => e.version)
  assert.deepEqual(after, ['1.0.1', '1.0.2'], 'the later write wins whole, never interleaved')
})
