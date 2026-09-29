#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const module = await import(pathToFileURL(join(process.cwd(), 'lib', 'auth-backend.js')).href)
const root = mkdtempSync(join(tmpdir(), 'zcode-auth-backend-'))
const path = join(root, 'auth-backend.json')
try {
  assert.equal(module.readAuthBackend(path), 'openzcode-app-server')
  module.writeAuthBackend(path, 'closezcode-app-server')
  assert.equal(module.readAuthBackend(path), 'closezcode-app-server')
  assert.match(readFileSync(path, 'utf8'), /closezcode-app-server/)

  let value = module.readAuthBackend(path)
  let revision = 0
  let service
  module.createAuthBackendRemoteService({
    provide(name, candidate) {
      assert.equal(name, module.AUTH_BACKEND_REMOTE_NAMESPACE)
      service = candidate
    },
  }, {
    read: () => value,
    write: next => { value = next; revision += 1 },
    revision: () => revision,
  })
  assert.equal((await service.snapshot()).backend, 'closezcode-app-server')
  const saved = await service.mutate({ backend: 'openzcode-app-server' })
  assert.equal(saved.backend, 'openzcode-app-server')
  assert.equal(saved.revision, 1)
  await assert.rejects(() => service.mutate({ backend: 'unsupported' }), /unknown zcode authentication backend/)
  console.log('PASS authentication backend selection persists and validates through Remote')
} finally {
  rmSync(root, { recursive: true, force: true })
}
