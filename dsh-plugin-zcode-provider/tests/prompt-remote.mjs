#!/usr/bin/env node
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { createPromptRemoteService, PROMPT_REMOTE_NAMESPACE } = await import(
  pathToFileURL(join(process.cwd(), 'lib', 'prompt-remote.js')).href,
)

let value = {}
let revision = 0
let service
const context = {
  provide(name, candidate) {
    assert.equal(name, PROMPT_REMOTE_NAMESPACE)
    service = candidate
  },
}
createPromptRemoteService(context, {
  read: () => ({ ...value }),
  write: next => { value = { ...next }; revision += 1 },
  revision: () => revision,
})

const initial = await service.snapshot()
assert.equal(initial.revision, 0)
assert.deepEqual(initial.value, {})
assert.equal(typeof initial.defaults.identity, 'string')
const saved = await service.mutate({ value: { placement: 'after', after: { identity: 'custom identity' } } })
assert.equal(saved.revision, 1)
assert.deepEqual(saved.value, { placement: 'after', after: { identity: 'custom identity' } })
assert.deepEqual(await service.snapshot(), saved)

const controller = new AbortController()
controller.abort()
await assert.rejects(() => service.snapshot(controller.signal), /aborted/)
console.log('PASS prompt overrides use the plugin-owned Remote persistence channel')
