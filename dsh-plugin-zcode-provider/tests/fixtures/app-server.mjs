#!/usr/bin/env node

process.stdin.setEncoding('utf8')
let buffer = ''
let announced = false
let accountConfig
let accountGenerateAttempts = 0

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(JSON.parse(line))
    newline = buffer.indexOf('\n')
  }
})

function handle(request) {
  if (request.method === 'provider/updateAccountConfig') {
    accountConfig = request.params
    send({
      id: request.id,
      result: {
        receivedRevision: request.params.revision,
        providerCount: Object.keys(request.params.providers ?? {}).length,
        status: 'received',
      },
    })
    return
  }
  if (request.method === 'workspace/cancelGenerateText') {
    send({ id: request.id, result: { operationId: request.params.operationId, cancelled: true } })
    return
  }
  if (request.method === 'session/create') {
    send({ method: 'session/requestRuntimePreferences', id: `fx-${Date.now()}`, params: { sessionId: 'sess_fixture', scope: 'runtime-materialization' } })
    send({
      id: request.id,
      result: {
        messages: [],
        session: { sessionId: 'sess_fixture', model: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash' }, status: 'idle' },
      },
    })
    return
  }
  if (request.method === 'session/setModel') {
    send({ id: request.id, result: { messages: [] } })
    return
  }
  if (request.method === 'session/send') {
    send({ id: request.id, result: { accepted: true, sessionId: 'sess_fixture', stateRevision: 2 } })
    return
  }
  if (request.method === 'session/messages') {
    send({
      id: request.id,
      result: {
        messages: [{
          info: {
            role: 'assistant',
            completed: 1,
            finish: 'stop',
            semantics: { kind: 'assistant_response' },
            tokens: { input: 11, output: 2, reasoning: 0, cache: { read: 8, write: 0 } },
          },
          parts: [{ type: 'text', text: `session-turn-ok:${request.params.sessionId}` }],
        }],
      },
    })
    return
  }
  if (request.method === 'session/close') {
    send({ id: request.id, result: {} })
    return
  }
  if (request.method !== 'workspace/generateText') {
    send({ id: request.id, error: { code: -32601, message: 'method not found' } })
    return
  }
  if (!announced) {
    announced = true
    send({ method: 'startup/storageState', params: { phase: 'ready' } })
  }
  const params = request.params
  if (accountConfig !== undefined && accountGenerateAttempts++ === 0) {
    send({
      id: request.id,
      error: {
        code: -32004,
        message: `Provider Registry 中不存在 Provider: ${params.selection.providerId}`,
      },
    })
    return
  }
  send({
    id: request.id,
    result: {
      text: `workspace=${params.workspace.workspacePath};provider=${params.selection.providerId};model=${params.selection.modelId};message=${params.messages?.[0]?.content ?? ''};account=${JSON.stringify(accountConfig?.providers?.[params.selection.providerId]?.access ?? null)};personal=${process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? ''}`,
      selection: params.selection,
      finishReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      toolCalls: [{ id: 'call_fixture', name: 'Read', input: { path: 'README.md' } }],
    },
  })
}
