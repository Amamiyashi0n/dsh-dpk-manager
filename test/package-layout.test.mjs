import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

test('the published package uses src as its source root', () => {
  assert.equal(manifest.main, './src/index.js')
  assert.equal(manifest.exports['.'], './src/index.js')
  assert.equal(manifest.exports['./client'], './src/client.js')
  assert.equal(manifest.exports['./src/*'], './src/*')
  assert.equal(manifest.exports['./lib/*'], './src/lib/*')
  assert.ok(manifest.files.includes('src'))
  assert.equal(existsSync(join(root, 'src', 'index.js')), true)
  assert.equal(existsSync(join(root, 'src', 'client.js')), true)
  assert.equal(existsSync(join(root, 'src', 'host-service.js')), true)
  assert.equal(existsSync(join(root, 'src', 'lib', 'actions.mjs')), true)
  assert.equal(existsSync(join(root, 'lib')), false)
})
