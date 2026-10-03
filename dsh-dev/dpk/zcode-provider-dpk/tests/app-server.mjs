#!/usr/bin/env node

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const { OpenZCodeAppServerTransport, appServerResultToStreamChunks, toWorkspaceMessages } = await import(
  pathToFileURL(join(root, 'lib', 'openzcode-app-server.js')).href,
)


async function collect(gen) {
  const chunks = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

const failures = []
let passed = 0
function check(label, value) {
  if (value) { passed += 1; console.log(`PASS  ${label}`) }
  else { failures.push(label); console.log(`FAIL  ${label}`) }
}

const fixture = join(here, 'fixtures', 'app-server.mjs')
const transport = new OpenZCodeAppServerTransport({
  enabled: true,
  nodePath: process.execPath,
  cliPath: fixture,
  cwd: root,
})
try {
  const chunks = await collect(transport.generate({
    provider: 'builtin:bigmodel-coding-plan',
    model: 'GLM-5.3-Flash',
    reasoningEffort: 'max',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [{ name: 'Read', description: 'Read a file', parameters: { type: 'object' } }],
  }, { family: 'bigmodel', access: { mode: 'individual-coding-plan' } }, 'C:/workspace'))
  check('app-server maps text into a DSH text block', chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text.includes('workspace=C:/workspace')))
  check('app-server maps tool calls', chunks.some((chunk) => chunk.type === 'tool-call-delta' && chunk.name === 'Read'))
  check('app-server maps usage', chunks.some((chunk) => chunk.type === 'usage' && chunk.usage.totalTokens === 5))
  check('app-server maps finish reason', chunks.at(-1)?.type === 'finish' && chunks.at(-1).reason.kind === 'tool-calls')
  const direct = appServerResultToStreamChunks({ text: 'ok', finishReason: 'max_tokens' })
  check('app-server result mapper supports max tokens', direct.at(-1)?.reason.kind === 'max-tokens')
  const projected = toWorkspaceMessages({
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_read', name: 'Read', arguments: '{"path":"README.md"}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'contents' }], toolCallId: 'call_read' },
    ],
  })
  check('app-server recovers tool name from assistant call', projected[1]?.toolName === 'Read')
  const fallback = toWorkspaceMessages({
    messages: [{ role: 'tool', content: [{ type: 'text', text: 'orphan' }], toolCallId: 'missing' }],
  })
  check('app-server keeps orphan tool result schema-valid', fallback[0]?.toolName === 'tool')

  const accountTransport = new OpenZCodeAppServerTransport({
    enabled: true,
    nodePath: process.execPath,
    cliPath: fixture,
    cwd: root,
    storageDir: 'C:/fixture/.zcode/v2',
  })
  try {
    const accountChunks = await collect(accountTransport.generate({
      provider: 'builtin:bigmodel-coding-plan',
      model: 'GLM-5.3-Flash',
      reasoningEffort: 'max',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'account route' }] }],
    }, {
      family: 'bigmodel',
      access: { type: 'zhipu-account', mode: 'individual-coding-plan' },
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'fixture-key',
      models: [{ id: 'GLM-5.3-Flash' }],
    }, 'C:/workspace'))
    const accountText = accountChunks.find((chunk) => chunk.type === 'text-delta')?.text ?? ''
    check('account app-server preserves the official entitlement provider id',
      accountText.includes('provider=account:bigmodel-individual-coding-plan'))
    check('account app-server sends the official account access shape',
      accountText.includes('"type":"zhipu-account"')
      && accountText.includes('"entitled":true'))
    check('account app-server retries after an asynchronous Registry refresh race',
      accountText.includes('provider=account:bigmodel-individual-coding-plan'))
    check('account app-server derives the Personal catalog path for legacy profiles',
      accountText.includes('personal=C:\\fixture\\.zcode\\v2\\provider_config.json'))
  } finally {
    accountTransport.dispose()
  }

  const startPlanTransport = new OpenZCodeAppServerTransport({
    enabled: true,
    nodePath: process.execPath,
    cliPath: fixture,
    cwd: root,
    storageDir: 'C:/fixture/.zcode/v2',
  })
  try {
    const startPlanChunks = await collect(startPlanTransport.generate({
      provider: 'builtin:bigmodel-start-plan',
      model: 'GLM-5.3-Flash',
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'start-plan route' }] }],
    }, {
      family: 'bigmodel',
      access: { type: 'zhipu-account', mode: 'start-plan' },
      baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
      apiKey: 'fixture-jwt',
      models: [{ id: 'GLM-5.3-Flash' }],
    }, 'C:/workspace'))
    const startPlanText = startPlanChunks.map((chunk) => (chunk.type === 'text-delta' ? chunk.text : '')).join('')
    check('start-plan delegates through an engine session', startPlanText.includes('session-turn-ok:sess_fixture'))
    const usage = startPlanChunks.find((chunk) => chunk.type === 'usage')
    check('start-plan session turn projects usage', usage?.usage?.inputTokens === 11 && usage?.usage?.cacheReadTokens === 8)
    const finish = startPlanChunks.at(-1)
    check('start-plan session turn finishes cleanly', finish?.type === 'finish' && finish.reason.kind === 'stop')
  } finally {
    startPlanTransport.dispose()
  }

  // 额度耗尽(委托路径):引擎把 providerErrorCode 原样带回,分类必须与直连 wire
  // 一致成 QUOTA——否则 start-plan 的欠费只会得到一个 SERVER,DSH 的欠费提醒
  // (失败行额度文案 + 全局 shell.quota-notice)不会出现。
  process.env.ZCODE_FIXTURE_TURN_ERROR = JSON.stringify({
    message: '余额不足或无可用资源包,请充值。',
    data: { providerErrorCode: '1113' },
  })
  const quotaTransport = new OpenZCodeAppServerTransport({
    enabled: true,
    nodePath: process.execPath,
    cliPath: fixture,
    cwd: root,
    storageDir: 'C:/fixture/.zcode/v2',
  })
  try {
    let quotaError
    try {
      await collect(quotaTransport.generate({
        provider: 'builtin:bigmodel-start-plan',
        model: 'GLM-5.3-Flash',
        reasoningEffort: 'low',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'quota route' }] }],
      }, {
        family: 'bigmodel',
        access: { type: 'zhipu-account', mode: 'start-plan' },
        baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
        apiKey: 'fixture-jwt',
        models: [{ id: 'GLM-5.3-Flash' }],
      }, 'C:/workspace'))
    } catch (error) { quotaError = error }
    check('start-plan quota failure classifies as QUOTA', quotaError?.code === 'QUOTA')
    check('start-plan quota failure keeps the provider message',
      String(quotaError?.message).includes('余额不足'))
    check('start-plan quota failure names the provider code',
      String(quotaError?.message).includes('1113'))
  } finally {
    delete process.env.ZCODE_FIXTURE_TURN_ERROR
    quotaTransport.dispose()
  }
} finally {
  transport.dispose()
}

console.log(`\n${passed}/${passed + failures.length} tests passed`)
if (failures.length) {
  console.error(`Failures:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
