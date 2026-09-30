#!/usr/bin/env node
/**
 * Probe the official zcode.cjs app-server (stdio NDJSON) and report what its
 * Provider Registry actually resolves.
 *
 * Logs every server notification, all stderr, and probes workspace/generateText
 * against a list of candidate providers to reveal which are registered.
 *
 * Usage: node probe-registry.mjs [waitMs] [providerId ...]
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const nodePath = 'C:\\Program Files\\nodejs\\node.exe'
const cliPath = 'C:\\Users\\Amamiya\\Dev-ws-next\\repos\\zcode-dev\\re-zcode\\zcode-unpacked\\resources\\glm\\zcode.cjs'
const cwd = 'C:\\Users\\Amamiya\\Dev-ws-next\\repos\\zcode-dev'
const waitMs = Number(process.argv[2] || 3000)
const providers = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['account:bigmodel-individual-coding-plan', 'deepseek', 'builtin:bigmodel-coding-plan']

const env = {
  ...process.env,
  ...(process.env.PROBE_WIRE ? {
    NODE_OPTIONS: '--require C:/Users/Amamiya/Dev-ws-next/repos/zcode-dev/.zcode-analysis/wire-hook.cjs',
    ZCODE_WIRE_LOG: 'C:/Users/Amamiya/Dev-ws-next/repos/zcode-dev/re-app-server/engine-wire.jsonl',
    ZCODE_WIRE_MAX: '60',
    ZCODE_WIRE_MAX_BODY: String(Number(process.env.PROBE_WIRE_BODY || 2000)),
  } : {}),
  ...(process.env.PROBE_MITM ? {
    ZCODE_HTTP_PROXY: 'http://127.0.0.1:8899',
    ZCODE_AGENT_CA_CERT: 'C:\Users\Amamiya\Dev-ws-next\repos\zcode-dev\.zcode-analysis\mitm\ca.pem',
    NODE_EXTRA_CA_CERTS: 'C:\Users\Amamiya\Dev-ws-next\repos\zcode-dev\.zcode-analysis\mitm\ca.pem',
  } : {}),
  ZCODE_STORAGE_DIR: 'C:\\Users\\Amamiya\\.zcode\\v2',
  ...(process.env.PROBE_ALIGN ? {
    ZCODE_APP_VERSION: '3.14.3',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:/Users/Amamiya/.zcode/v2/runtime/provider/windows-x86_64/3.14.3/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json',
  } : {}),
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:\\Users\\Amamiya\\Dev-ws-next\\repos\\zcode-dev\\re-zcode\\zcode-unpacked\\resources\\config\\provider\\zcode-builtin.json',
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: 'C:\\Users\\Amamiya\\.zcode\\v2\\provider_config.json',
}

// Registry refresh gate: basedOnZCodeBuiltinRevision must equal
// `zcode-builtin:<catalogRevision>:<sha256(resolve(activeCatalogPath))>` — see README §2.3.
const builtinPathHash = createHash('sha256').update(resolve(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE)).digest('hex')
const BUILTIN_REV = process.env.PROBE_BUILTIN_REV || `zcode-builtin:30:${builtinPathHash}`

const child = spawn(nodePath, [cliPath, 'app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buffer = ''
let stderr = ''
let nextId = 1
const results = []

const redact = (s) => s.replace(/(Bearer\s+|key-)[A-Za-z0-9._-]+/gi, '$1<redacted>')

child.stdout.setEncoding('utf-8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let nl = buffer.indexOf('\n')
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line) handleLine(line)
    nl = buffer.indexOf('\n')
  }
})
child.stderr.setEncoding('utf-8')
child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-6000) })
child.on('close', (code) => { console.log(`\n[probe] child exited code=${code}`); finish() })

function handleLine(line) {
  let msg
  try { msg = JSON.parse(line) } catch { console.log('[probe] non-JSON:', redact(line.slice(0, 200))); return }
  if (typeof msg.method === 'string' && msg.id === undefined) {
    const limit = msg.method === 'state.updated' ? 1400 : 160
    const detail = JSON.stringify(msg.params ?? {}).slice(0, limit)
    console.log(`[notify] ${msg.method} ${detail}`)
  } else if (msg.id !== undefined && typeof msg.method === 'string') {
    console.log(`[server-request] ${msg.method} ${JSON.stringify(msg.params ?? {}).slice(0, 160)}`)
    if (msg.method === 'interaction/requestProviderRuntimeHeaders') {
      const providerId = String(msg.params?.providerId ?? msg.params?.modelSelection?.providerId ?? '')
      const apiKey = JSON.parse(process.env.PROBE_APIKEY_JSON ?? '{}')[providerId] ?? ''
      console.log(`[host] providerRuntimeHeaders ${providerId} -> ${apiKey ? 'apiKey(len ' + apiKey.length + ')' : 'EMPTY'}`)
      reply(msg.id, { headersApplied: Boolean(apiKey), ...(apiKey ? { requestAuth: { apiKey } } : {}) })
    } else if (msg.method === 'session/requestRuntimePreferences') {
      reply(msg.id, {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
      })
    } else if (msg.method === 'interaction/requestPermission') {
      reply(msg.id, { decision: 'allow' })
    } else if (msg.method === 'interaction/requestUserInput') {
      reply(msg.id, { answers: [] })
    } else {
      reply(msg.id, {})
    }
  } else if (msg.id !== undefined) {
    const pending = results.find((r) => r.id === msg.id)
    if (pending) pending.resolve(msg)
  }
}

function reply(id, result) { child.stdin.write(JSON.stringify({ id, result }) + '\n') }
function request(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    results.push({ id, resolve })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}

async function probeProvider(providerId, modelId) {
  let messages
  if (process.env.PROBE_SYS) {
    const blocks = JSON.parse(await import('node:fs').then((m) => m.readFileSync('C:/Users/Amamiya/Dev-ws-next/repos/zcode-dev/re-app-server/official-system-blocks.json', 'utf-8')))
    messages = [
      { role: 'system', content: blocks.join('\n\n') },
      { role: 'user', content: '只回复OK' },
    ]
  }
  const res = await request('workspace/generateText', {
    workspace: { workspacePath: cwd, workspaceKey: cwd },
    selection: { providerId, modelId: modelId ?? 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } },
    maxOutputTokens: 2048,
    ...(messages ? { messages } : { prompt: '只回复OK' }),
    querySource: 're-app-server-probe',
    operationId: `probe-${providerId}-${Date.now()}`,
  })
  if (res.error) {
    console.log(`[probe] ${providerId} => ERROR ${res.error.code ?? ''} ${String(res.error.message ?? '').slice(0, 120)}`)
  } else {
    console.log(`[probe] ${providerId} => OK text=${JSON.stringify((res.result?.text ?? '').slice(0, 40))} provider=${res.result?.selection?.providerId ?? '?'} usage=${JSON.stringify(res.result?.usage ?? {})}`)
  }
}

const ACCOUNT_PROVIDER_IDS = [
  'account:zai-individual-coding-plan',
  'account:zai-team-coding-plan',
  'account:zai-start-plan',
  'account:bigmodel-individual-coding-plan',
  'account:bigmodel-team-coding-plan',
  'account:bigmodel-start-plan',
  'account:zai-offpeak-idle-plan',
  'account:bigmodel-offpeak-idle-plan',
]

async function injectAccountConfig() {
  const providers = {}
  const states = {}
  // connectionKey values captured from the desktop host's own delivery (see README §0.4-A)
  const CONNECTION_KEYS = {
    'account:bigmodel-individual-coding-plan': 'e7226f88a76394071ba4394650bae71467599116c88e06ccb146df42b7ca3d8f',
    'account:bigmodel-start-plan': '80784cde2fcaab5551dfa6c6889896eec7aff2e4afe341a78840237824a075aa',
  }
  for (const id of ACCOUNT_PROVIDER_IDS) {
    providers[id] = { access: { type: 'zhipu-account', entitled: true } }
    states[id] = {
      availability: 'available',
      entitled: true,
      current: id === 'account:bigmodel-individual-coding-plan' || id === 'account:bigmodel-start-plan',
      ...(CONNECTION_KEYS[id] ? { connectionKey: CONNECTION_KEYS[id] } : {}),
    }
  }
  const payload = {
    revision: `re-probe-${Date.now()}`,
    basedOnZCodeBuiltinRevision: BUILTIN_REV,
    providers,
    states,
  }
  const res = await request('provider/updateAccountConfig', payload)
  console.log(`[probe] provider/updateAccountConfig => ${JSON.stringify(res).slice(0, 400)}`)
}

let activeSessionId

async function fullDesktopSequence() {
  await injectAccountConfig()
  await sleep(1000)
  const created = await request('session/create', { workspace: { workspacePath: cwd, workspaceKey: cwd } })
  console.log(`[probe] session/create result keys: ${JSON.stringify(Object.keys(created.result ?? {}))}`)
  console.log(`[probe] session/create full: ${JSON.stringify(created).slice(0, 900)}`)
  const sessionId = created.result?.session?.sessionId
  activeSessionId = sessionId
  if (sessionId) {
    const pres = await request('workspace/readPresentation', { sessionId, workspace: { workspacePath: cwd, workspaceKey: cwd } })
    const presStr = JSON.stringify(pres)
    console.log(`[probe] readPresentation => ${presStr.length} chars`)
    const models = presStr.match(/"label":"[^"]+"/g) ?? []
    console.log('[probe] model labels:', models.slice(0, 30).join(' '))
  }
  if (sessionId) {
    const set = await request('session/setModel', {
      sessionId,
      model: process.env.PROBE_SESSION_MODEL ? JSON.parse(process.env.PROBE_SESSION_MODEL) : { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } },
    })
    console.log(`[probe] session/setModel => ${JSON.stringify(set).slice(0, 300)}`)
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function usageStats() {
  const res = await request('usage/stats', { range: process.env.PROBE_USAGE_RANGE || '7d' })
  console.log(`[probe] usage/stats => ${JSON.stringify(res).slice(0, 700)}`)
}

async function offPeakList() {
  const res = await request('offPeak/list', {})
  console.log(`[probe] offPeak/list => ${JSON.stringify(res).slice(0, 400)}`)
}

async function fetchMessages(sessionId) {
  const res = await request('session/messages', { sessionId, limit: 12 })
  const msgs = res.result?.messages ?? res.result ?? []
  const text = JSON.stringify(msgs)
  console.log(`[probe] session/messages => ${text.length} chars`)
  console.log(`[messages-raw] ${text.slice(2000, 5200)}`)
}

async function sessionSendExperiment(sessionId) {
  let res = await request('session/subscribe', { sessionId, mode: 'desktop-continuous' })
  console.log(`[probe] session/subscribe => ${JSON.stringify(res).slice(0, 200)}`)
  res = await request('session/send', { sessionId, content: '只回复两个字符:OK' })
  console.log(`[probe] session/send => ${JSON.stringify(res).slice(0, 300)}`)
  // give the engine a few seconds to stream session events as notifications
  await sleep(Number(process.env.PROBE_SEND_WAIT_MS || 15000))
  await fetchMessages(sessionId)
}

let finished = false
function finish() {
  if (finished) return
  finished = true
  if (stderr.trim()) console.log('\n[probe] stderr tail:\n' + redact(stderr.trim().slice(-2000)))
  process.exit(0)
}

console.log(`[probe] spawning app-server (wait ${waitMs}ms before probing)`)
setTimeout(async () => {
  if (process.env.PROBE_FULL) await fullDesktopSequence()
  else if (process.env.PROBE_INJECT) {
    await injectAccountConfig()
    const settle = Number(process.env.PROBE_SETTLE_MS || 0)
    if (settle) { console.log(`[probe] settling ${settle}ms after inject...`); await sleep(settle) }
  }
  if (process.env.PROBE_USAGE) await usageStats()
  if (process.env.PROBE_OFFPEAK) await offPeakList()
  if (process.env.PROBE_SEND && activeSessionId) await sessionSendExperiment(activeSessionId)
  for (const p of providers) { const [pid, mid] = p.split('|'); await probeProvider(pid, mid) }
  child.kill()
  setTimeout(finish, 1500)
}, waitMs).unref()
setTimeout(() => { console.log('[probe] hard timeout'); child.kill(); finish() }, waitMs + 120000).unref()
