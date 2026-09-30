import assert from 'node:assert/strict'
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
