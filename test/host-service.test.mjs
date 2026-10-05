import assert from 'node:assert/strict'
import { existsSync, realpathSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createDpkRemoteService, REMOTE_NAMESPACE } from '../host-service.js'
import { detectProfileName } from '../lib/profile-policy.mjs'
import { dataRoot } from '../lib/data.mjs'
import { linkSpecifier, profileDir, readProfileManifest } from '../lib/profile-install.mjs'
import { packDirectory } from '../lib/pack.mjs'
import { readArchiveManifest } from '../lib/verify.mjs'
import { dpkRoot, readIndex, recordInstall, storeDir, writeIndex } from '../lib/store.mjs'
import { makeHome, makePackage, snapshot, storeEntry } from './helpers.mjs'

/** A profile directory with the parts every real profile has. */
async function makeProfile(home, profile, options = {}) {
  const dir = profileDir(home, profile)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: options.dependencies ?? {},
    dsh: { profile: { bundles: options.bundles ?? [] } },
  }, undefined, 2)}\n`)
  return dir
}

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

test('host service registers the structural Typert source-mode contract', () => {
  const provided = new Map()
  const ctx = {
    provide(name, value) {
      assert.equal(provided.has(name), false)
      provided.set(name, value)
      return () => provided.delete(name)
    },
  }

  const service = createDpkRemoteService(ctx, { home: 'unused-by-registration' })
  assert.equal(provided.get(REMOTE_NAMESPACE), service)
  assert.equal(Object.isFrozen(service.typertRemote), true)
  assert.deepEqual(service.typertRemote, {
    service,
    serviceKey: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
  })

  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(service),
    REMOTE_METHOD_DESCRIPTOR,
  )?.value
  assert.equal(descriptor.version, 1)
  assert.deepEqual(
    descriptor.methods,
    ['managed', 'importArchive', 'exportVolumes', 'exportArchive', 'removeArchive'].map(method => ({
      method,
      invocation: { kind: 'direct' },
    })),
  )
  assert.equal(Object.isFrozen(descriptor), true)
  assert.equal(Object.isFrozen(descriptor.methods), true)
})

test('managed ranks versions numerically, not by ledger order', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpk-home-'))
  const root = join(home, 'dpk')
  await mkdir(root, { recursive: true })
  // Ledger order is insertion order; '2.5.9' is lexically the greatest and
  // appended last, so a last-row-wins read reports the wrong version.
  await writeFile(join(root, 'index.json'), `${JSON.stringify({
    version: 1,
    entries: [
      { name: 'some-pkg', version: '2.5.37', digest: 'b', installedAt: '', source: '', profiles: [], path: '' },
      { name: 'some-pkg', version: '2.5.9', digest: 'a', installedAt: '', source: '', profiles: [], path: '' },
    ],
  }, undefined, 2)}\n`)

  const ctx = {
    provide() {},
    async get() { return undefined },
  }
  const service = createDpkRemoteService(ctx, { home })
  const listed = await service.managed()
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0].version, '2.5.37')
  assert.equal(listed.entries[0].digest, 'b')
})

test('managed reports the installed version over the ledger record when they differ', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpk-home-'))
  const root = join(home, 'dpk')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'index.json'), `${JSON.stringify({
    version: 1,
    entries: [
      { name: 'dsh-dpk-manager', version: '2.0.0', digest: 'c', installedAt: '', source: 'fallback.dpk', profiles: ['web'], path: '' },
    ],
  }, undefined, 2)}
`)

  const ctx = makeCtx({
    pluginManager: {
      listBundles: async () => [
        { name: 'dsh-dpk-manager', version: '2.1.1', installed: true, enabled: true },
      ],
    },
  })
  const service = createDpkRemoteService(ctx, { home })
  const listed = await service.managed()
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0].version, '2.1.1', 'the card shows the version that actually runs')
  assert.equal(listed.entries[0].dpkVersion, '2.0.0', 'the ledger import version stays as provenance')
  assert.equal(listed.entries[0].installed, true)
})

test('managed reports a restart only while the ledger holds an install this process has not loaded', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const service = createDpkRemoteService(makeCtx({ pluginManager: { listBundles: async () => [] } }), { home })

  assert.equal((await service.managed()).restartRequired, undefined, 'nothing installed yet')

  // Installed just now, by this process: the running Harness cannot have it.
  await recordInstall(root, { name: 'fresh-pkg', version: '1.0.0', digest: 'a'.repeat(64), source: 'fresh.dpk' })
  assert.equal((await service.managed()).restartRequired, true)
  assert.equal(existsSync(join(root, '.first-run-restart-notice')), false, 'no marker file: the ledger answers this')

  // An install from before this process started is already loaded.
  await writeIndex(root, {
    entries: [{ name: 'old-pkg', version: '1.0.0', digest: 'b'.repeat(64), installedAt: '2020-01-01T00:00:00.000Z', source: null }],
  })
  assert.equal((await service.managed()).restartRequired, undefined)
})

/** A minimal host context: services come back from `get`, `provide` records nothing. */
function makeCtx(services) {
  return { provide() {}, get: name => services[name] }
}

/** Run `fn` with the profile the Host would export, restoring the previous value. */
async function withProfile(name, fn) {
  const previous = process.env.DSH_PROFILE
  process.env.DSH_PROFILE = name
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = previous
  }
}

test('removeArchive forgets this profile and keeps a shared entry for the others', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const digest = 'a'.repeat(64)
  const packageDir = join(storeDir(root, digest), 'package')
  await recordInstall(root, { name: 'shared-pkg', version: '1.0.0', digest, source: 'a.dpk' })
  await mkdir(packageDir, { recursive: true })
  // Two profiles really resolve it: that is what "shared" means now.
  await makeProfile(home, 'web', { dependencies: { 'shared-pkg': `link:${packageDir}` } })
  await makeProfile(home, 'desktop', { dependencies: { 'shared-pkg': `link:${packageDir}` } })

  const service = createDpkRemoteService(makeCtx({}), { home })
  const outcome = await withProfile('desktop', () => service.removeArchive({ name: 'shared-pkg' }))

  assert.deepEqual(outcome.dropped, [], 'another profile still references the store copy')
  const index = await readIndex(root)
  assert.equal(index.entries.length, 1, 'the ledger row stays while a profile uses the digest')
  assert.equal(existsSync(packageDir), true, 'the shared store copy stays')
  assert.equal(existsSync(join(profileDir(home, 'desktop'), 'node_modules', 'shared-pkg')), false)
})

test('removeArchive deletes the store copy and the row once no profile references it', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const digest = 'b'.repeat(64)
  const packageDir = join(storeDir(root, digest), 'package')
  await recordInstall(root, { name: 'solo-pkg', version: '1.0.0', digest, source: 'b.dpk' })
  await mkdir(packageDir, { recursive: true })
  await makeProfile(home, 'desktop', { dependencies: { 'solo-pkg': `link:${packageDir}` } })

  const service = createDpkRemoteService(makeCtx({}), { home })
  const outcome = await withProfile('desktop', () => service.removeArchive({ name: 'solo-pkg' }))

  assert.deepEqual(outcome.dropped, [digest], 'nothing references the copy any more')
  const index = await readIndex(root)
  assert.equal(index.entries.length, 0, 'the ledger row is dropped')
  assert.equal(existsSync(storeDir(root, digest)), false, 'the store copy is deleted')
})

test('detectProfileName finds the profile whose node_modules holds this package', async () => {
  const home = await makeHome()
  const previous = process.env.DSH_PROFILE
  delete process.env.DSH_PROFILE
  try {
    const packageRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
    const holder = join(home, 'profiles', 'probe', 'node_modules', 'dsh-dpk-manager')
    await mkdir(dirname(holder), { recursive: true })
    symlinkSync(packageRoot, holder, 'junction')
    assert.equal(detectProfileName(home), 'probe')
    assert.equal(detectProfileName(await makeHome()), undefined, 'a home without this package stays undetermined')
  } finally {
    if (previous !== undefined) process.env.DSH_PROFILE = previous
  }
})

test('importArchive writes the profile itself and never calls the official manager', async () => {
  const home = await makeHome()
  await makeProfile(home, 'desktop')
  const packed = await packDirectory(await makePackage())
  const seen = []
  const manager = {
    installBundle: async () => { seen.push('install'); return { application: 'applied', changed: true } },
    removeBundle: async name => { seen.push(`remove:${name}`); return { changed: true } },
  }
  const service = createDpkRemoteService(makeCtx({ pluginManager: manager }), { home })

  const result = await withProfile('desktop', () => service.importArchive({
    fileName: 'fixture.dpk',
    base64: packed.buffer.toString('base64'),
  }))

  assert.deepEqual(seen, [], 'no pnpm run, no manager call')
  assert.equal(result.name, '@local/dpk-fixture')
  assert.equal(result.via, 'profile')
  const profile = await readProfileManifest(profileDir(home, 'desktop'))
  assert.equal(profile.dependencies['@local/dpk-fixture'], linkSpecifier(result.storePath))
  assert.deepEqual(profile.dsh.profile.bundles, ['@local/dpk-fixture'])
  const index = await readIndex(dpkRoot(home))
  assert.equal(index.entries.length, 1, 'the import records in the ledger')
})

test('the panel can still hand an import to the official manager when configured', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makePackage())
  const seen = []
  const manager = {
    installBundle: async () => {
      seen.push('install')
      return seen.filter(call => call === 'install').length === 1
        ? { application: 'failed', error: { diagnostic: 'ambiguous-install' } }
        : { application: 'applied', changed: true }
    },
    removeBundle: async name => { seen.push(`remove:${name}`); return { changed: true } },
  }
  const service = createDpkRemoteService(makeCtx({ pluginManager: manager }), { home, installMode: 'service' })

  await withProfile('desktop', () => service.importArchive({
    fileName: 'fixture.dpk',
    base64: packed.buffer.toString('base64'),
  }))

  // The profile has no row for it yet, so the retry is a real remove+install.
  assert.deepEqual(seen, ['install', 'remove:@local/dpk-fixture', 'install'])
})

test('the panel hands the browser the app scope or the app+data scope', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  const digest = 'e'.repeat(64)
  await storeEntry(root, digest, {
    manifest: {
      name: '@local/dpk-fixture',
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
  await recordInstall(root, { name: '@local/dpk-fixture', version: '1.0.0', digest, source: 'fixture.dpk' })
  for (const [klass, file, body] of [['app', 'sessions.json', '{"sessions":1}\n'], ['data', 'settings.json', '{"settings":1}\n']]) {
    const path = join(dataRoot(home, '@local/dpk-fixture'), klass, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
  }
  const before = await snapshot(home)
  const service = createDpkRemoteService(makeCtx({}), { home })

  const exported = await service.exportVolumes({ name: '@local/dpk-fixture', verb: 'export' })
  assert.equal(exported.fileName, 'dpk-fixture-data.json')
  assert.equal(exported.verb, 'export')
  assert.deepEqual(carriedPaths(exported), ['app/sessions.json'], 'app volumes only')

  const snapshotted = await service.exportVolumes({ name: '@local/dpk-fixture', verb: 'snap' })
  assert.equal(snapshotted.name, '@local/dpk-fixture')
  assert.equal(snapshotted.fileName, 'dpk-fixture-snap.json')
  assert.deepEqual(carriedPaths(snapshotted), ['app/sessions.json', 'data/settings.json'])

  // The file is built in a scratch directory that does not survive the call:
  // the panel is transport, not a second place dpk writes data.
  assert.deepEqual(await snapshot(home), before, 'building the file wrote nothing into the DSH home')

  await assert.rejects(
    () => service.exportVolumes({ name: '@local/dpk-fixture', verb: 'pack' }),
    /needs verb "export" or "snap"/,
  )
  await assert.rejects(() => service.exportVolumes({ name: '@local/absent', verb: 'snap' }), /no stored package matches/)
})

/** The volume paths a `exportVolumes` answer carries, decoded from its bytes. */
function carriedPaths(answer) {
  const payload = JSON.parse(Buffer.from(answer.base64, 'base64').toString('utf8'))
  return payload.files.map(file => file.path)
}

test('the panel export is generated on demand and stores nothing', async () => {
  const home = await makeHome()
  const packed = await packDirectory(await makePackage())
  const root = dpkRoot(home)
  const packageDir = await storeEntry(root, packed.manifest.integrity.digest, { name: '@local/dpk-fixture' })
  await recordInstall(root, {
    name: '@local/dpk-fixture',
    version: packed.manifest.version,
    digest: packed.manifest.integrity.digest,
    source: 'fixture.dpk',
  })
  await withProfile('desktop', async () => {
    await makeProfile(home, 'desktop', { dependencies: { '@local/dpk-fixture': `link:${packageDir}` } })
  })
  const before = await snapshot(home)
  const service = createDpkRemoteService(makeCtx({}), { home })

  const first = await service.exportArchive({ name: '@local/dpk-fixture' })

  // What comes back is a whole archive built in memory, and it is the only
  // place that archive exists: nothing under the DSH home changed.
  const bytes = Buffer.from(first.base64, 'base64')
  assert.equal(bytes.length, first.bytes)
  const manifest = readArchiveManifest(bytes)
  assert.equal(manifest.name, '@local/dpk-fixture')
  assert.deepEqual(await snapshot(home), before, 'the export wrote nothing into the DSH home')

  // On demand also means repeatable: the same store copy packs to the same bytes.
  const second = await service.exportArchive({ name: '@local/dpk-fixture' })
  assert.equal(second.base64, first.base64)
  assert.equal(second.fileName, 'local-dpk-fixture@1.0.0.dpk')

  // A version-pinned request resolves through the other branch (`matchEntries`
  // rather than `latestEntry`) — the branch that was never exercised, which is
  // how a missing import in this method went unnoticed since 2.0.3.
  const pinned = await service.exportArchive({ name: '@local/dpk-fixture', version: '1.0.0' })
  assert.equal(pinned.base64, first.base64)
  await assert.rejects(
    () => service.exportArchive({ name: '@local/dpk-fixture', version: '9.9.9' }),
    /no stored package matches/,
  )
})
