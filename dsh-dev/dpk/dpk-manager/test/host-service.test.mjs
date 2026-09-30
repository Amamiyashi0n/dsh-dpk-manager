import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDpkRemoteService, REMOTE_NAMESPACE } from '../host-service.js'

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
