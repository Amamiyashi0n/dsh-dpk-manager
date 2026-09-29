import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const image = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}
const attachmentData = Uint8Array.of(1, 2, 3)
const attachments = {
  async readImage(ref) {
    return { ref, data: attachmentData }
  },
}
const adapters = new Map()
const bodies = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  if (Array.isArray(body.messages)) bodies.push(body)
  const sse = [
    'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n\n')
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const ctx = {
  fiber: { entry: { options: { id: 'image-wire-test' } } },
  get(name) { return name === 'attachments' ? attachments : undefined },
  inject(_names, callback) {
    callback({ get() { return undefined }, logger: { debug() {} } })
    return { dispose() {} }
  },
  logger: { info() {}, warn() {}, debug() {} },
  llm: {
    registerAdapter(routes, adapter) { for (const route of routes) adapters.set(route, adapter) },
    registerConfigurableProviders() {},
  },
}

try {
  await apply(ctx, {
    providerConfigPath: 'C:\\fixture\\providers.json',
    routes: {
      vision: {
        id: 'vision', display: 'Vision', kind: 'anthropic', baseURL: 'https://example.test', apiKey: 'test-key',
        models: [{ id: 'vision-model', contextWindow: 4096, maxTokens: 512, inputModalities: ['text', 'image'] }],
        access: { type: '', mode: '' }, credential: 'config',
      },
    },
  })
  const adapter = adapters.get('vision')
  assert.ok(adapter)
  try {
    for await (const _chunk of adapter.stream({
      provider: 'vision', model: 'vision-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: image }] }],
    })) {}
  } catch (_fixtureStreamEnd) {
    // The request body is captured before the deliberately minimal SSE fixture ends.
  }
  const body = bodies.find((candidate) => candidate.model === 'vision-model')
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
  ])
  console.log('OK Anthropic durable image converted to base64 source')

} finally {
  globalThis.fetch = originalFetch
}
