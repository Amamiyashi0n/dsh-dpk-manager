import assert from 'node:assert/strict'
import { existsSync, realpathSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createDpkRemoteService, REMOTE_NAMESPACE } from '../host-service.js'
import { detectProfileName } from '../lib/profile-policy.mjs'
import { packDirectory } from '../lib/pack.mjs'
import { dpkRoot, readIndex, recordInstall, storeDir } from '../lib/store.mjs'
import { makeHome, makePackage } from './helpers.mjs'

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
    ['managed', 'importArchive', 'exportArchive', 'removeArchive'].map(method => ({
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
  await recordInstall(root, { name: 'shared-pkg', version: '1.0.0', digest: 'a'.repeat(64), path: 'store/a/package', profile: 'web' })
  await recordInstall(root, { name: 'shared-pkg', version: '1.0.0', digest: 'a'.repeat(64), path: 'store/a/package', profile: 'desktop' })
  await mkdir(join(storeDir(root, 'a'.repeat(64)), 'package'), { recursive: true })

  const manager = { removeBundle: async () => ({ changed: true }) }
  const service = createDpkRemoteService(makeCtx({ pluginManager: manager }), { home })
  const outcome = await withProfile('desktop', () => service.removeArchive({ name: 'shared-pkg' }))

  assert.equal(outcome.removed, true)
  assert.equal(outcome.pruned, false, 'another profile still references the store copy')
  const index = await readIndex(root)
  assert.deepEqual(index.entries[0].profiles, ['web'])
  assert.equal(existsSync(storeDir(root, 'a'.repeat(64))), true, 'the shared store copy stays')
})

test('removeArchive deletes the store copy and the row once no profile references it', async () => {
  const home = await makeHome()
  const root = dpkRoot(home)
  await recordInstall(root, { name: 'solo-pkg', version: '1.0.0', digest: 'b'.repeat(64), path: 'store/b/package', profile: 'desktop' })
  await mkdir(join(storeDir(root, 'b'.repeat(64)), 'package'), { recursive: true })

  const manager = { removeBundle: async () => ({ changed: true }) }
  const service = createDpkRemoteService(makeCtx({ pluginManager: manager }), { home })
  const outcome = await withProfile('desktop', () => service.removeArchive({ name: 'solo-pkg' }))

  assert.equal(outcome.pruned, true, 'nothing references the copy any more')
  const index = await readIndex(root)
  assert.equal(index.entries.length, 0, 'the ledger row is dropped')
  assert.equal(existsSync(storeDir(root, 'b'.repeat(64))), false, 'the store copy is deleted')
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

test('importArchive installs over an unchanged dependency row by removing first', async () => {
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
  const service = createDpkRemoteService(makeCtx({ pluginManager: manager }), { home })

  const result = await service.importArchive({
    fileName: 'fixture.dpk',
    base64: packed.buffer.toString('base64'),
  })

  assert.deepEqual(seen, ['install', 'remove:@local/dpk-fixture', 'install'])
  assert.equal(result.name, '@local/dpk-fixture')
  const index = await readIndex(dpkRoot(home))
  assert.equal(index.entries.length, 1, 'the re-import records in the ledger')
})
