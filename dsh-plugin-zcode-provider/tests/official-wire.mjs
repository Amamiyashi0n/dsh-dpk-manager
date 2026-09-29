/**
 * 官方线格式对齐测试:用桩 fetch 驱动插件注册的适配器,断言出站请求与
 * ZCode 3.14.3 协议逐字段一致(头集合、请求体骨架),并端到端验证签名链路
 * (门闩 → 握手 → Ed25519 → PoW)。
 *
 * 用法:node tests/official-wire.mjs [官方抓包日志路径]
 */
import { createHash, createHmac, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, verify as ed25519Verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const { apply } = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)
const prompt = await import(pathToFileURL(join(pkgRoot, 'lib', 'official-prompt.js')).href)
/** 整模块绑定:版本类断言要读 `ZCODE_CLIENT_VERSION` 这个真源。 */
const wire = await import(pathToFileURL(join(pkgRoot, 'lib', 'official-wire.js')).href)

const failures = []
const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok })
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

// ---- 官方基准(来自抓包) ----
const OFFICIAL_HEADER_NAMES = [
  'anthropic-beta', 'anthropic-version', 'authorization', 'content-type', 'http-referer',
  'user-agent', 'x-api-key', 'x-app-id', 'x-client-language', 'x-client-nonce', 'x-client-pow',
  'x-client-sig', 'x-client-timezone', 'x-client-ts', 'x-client-version', 'x-os-category',
  'x-os-version', 'x-platform', 'x-query-id', 'x-release-channel', 'x-request-id', 'x-session-id',
  'x-title', 'x-zcode-agent', 'x-zcode-app-version', 'x-zcode-session-type', 'x-zcode-trace-id',
]
const OFFICIAL_CAPTURE = process.argv[2]
const SIGNATURE_HEADERS = ['x-app-id', 'x-client-nonce', 'x-client-pow', 'x-client-sig', 'x-client-ts', 'x-client-version']
let captureHeaders
let captureHandshake
if (OFFICIAL_CAPTURE) {
  try {
    const rows = readFileSync(OFFICIAL_CAPTURE, 'utf8').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l))
    captureHeaders = rows.find((r) => (r.url ?? '').includes('api/anthropic'))?.headers
    const handshake = rows.find((r) => (r.url ?? '').includes('c1f3a7e2'))
    captureHandshake = handshake ? JSON.parse(handshake.body) : undefined
  } catch (_noCapture) { /* 显式传入的可选样本不可读时继续使用内嵌基准 */ }
}

// 凭证:设备配置里的 apiKey 是回落值,凭证库里的是账号级 provisioned key(官方优先用后者)。
// 两者形状都与官方一致(`<id>.<secret>`),都不含任何真实密钥。
const CONFIG_KEY = 'test-key-id.test-key-secret'
const key = 'fixture-plan-provisioned-key.cccccccccccccccc'
const BASE = 'https://open.bigmodel.cn/api/anthropic'
const DEVICE_MID = JSON.parse(readFileSync(join(pkgRoot, 'tests', 'fixtures', 'telemetry-state.json'), 'utf8')).deviceMid
const debugLogs = []
const accountProvider = {
  id: 'builtin:bigmodel-coding-plan',
  display: 'BigModel Coding Plan',
  kind: 'anthropic',
  baseURL: BASE,
  apiKey: key,
  models: [{ id: 'GLM-5.3', contextWindow: 1000000, maxTokens: 128000, efforts: ['low', 'max', 'high'], defaultEffort: 'max' }],
  family: 'bigmodel',
  access: { type: 'zhipu-account', mode: 'individual-coding-plan' },
}

/** 把插件注册出来的适配器抓在手里(设置层的 routes 是唯一数据源)。 */
async function buildAdapter(overrides = {}, config = {}) {
  let adapter
  const targetRoute = overrides.id ?? 'fixture:direct-wire'
  const ctx = {
    logger: { info() {}, debug(message) { debugLogs.push(String(message)) }, warn(message) { debugLogs.push(String(message)) } },
    get: () => undefined,
    // 本文件不测工具注册:tools 视为未就绪,插件只跳过该工具
    inject: () => ({ dispose() {} }),
    llm: {
      registerAdapter(routes, instance) { if (routes.includes(targetRoute)) adapter = instance },
      registerConfigurableProviders() {},
    },
    fiber: { entry: { options: { id: 'zcode-provider' } } },
  }
  await apply(ctx, {
    providerConfigPath: join(pkgRoot, 'tests', 'fixtures', 'device-config.json'),
    credentialsPath: join(pkgRoot, 'tests', 'fixtures', 'credentials.json'),
    telemetryStatePath: join(pkgRoot, 'tests', 'fixtures', 'telemetry-state.json'),
    // 隔离机器上的真实提示词覆写状态:本文件断言官方三块
    promptOverridesPath: join(pkgRoot, 'tests', 'fixtures', 'prompt-overrides.isolated.json'),
    sourceTitle: 'electron',
    ...config,
    routes: { [targetRoute]: { ...accountProvider, id: targetRoute, ...overrides } },
  })
  if (!adapter) throw new Error('适配器未注册')
  return adapter
}

/**
 * 安装一个只关心模型/签名请求的桩 fetch:命中权益/用量端点的请求(激活期异步取数)
 * 一律回中性 JSON,避免它们污染本文件的断言;其余 URL 交给 `handler`。
 *
 * 新增用量端点时**必须**同步加到这里,否则它会落到 `handler` 里被当成模型请求记录
 * (曾经因为漏了 `/model-usage` 让"模型请求只发一次"这条断言假红)。
 */
function stubFetch(handler) {
  const USAGE_PATHS = [
    '/api/monitor/usage/quota/limit',
    '/api/monitor/usage/model-usage',
    '/api/biz/subscription/list',
    '/api/v1/zcode-plan/billing/current',
  ]
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.includes('/api/biz/subscription/list')) {
      return Response.json({ code: 200, data: [{ productId: 'coding', productName: 'Coding', status: 'VALID', inCurrentPeriod: true }] })
    }
    if (USAGE_PATHS.some((p) => href.includes(p))) {
      return Response.json({ code: 200, data: { limits: [] } })
    }
    return await handler(href, init)
  }
}

const SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  'data: {"type":"message_stop"}',
  '',
].join('\n\n')

const streamOptions = {
  provider: accountProvider.id,
  model: 'GLM-5.3',
  reasoningEffort: 'max',
  sessionId: 'sess_aabc17af-af64-48c6-92d9-9613c54d3390',
  system: 'DSH_OPTION_SYSTEM_SENTINEL',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'DSH_HISTORY_SYSTEM_SENTINEL' }] },
    { role: 'user', content: [{ type: 'text', text: 'ping' }] },
  ],
  tools: [{ name: 'Bash', description: 'run a command', parameters: { type: 'object', properties: {} } }],
}

async function drive(adapter, options = streamOptions) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

// ---- 1. 未签名路径(门闩关闭):头与体 ----
{
  const calls = []
  stubFetch(async (url, init) => {
    calls.push({ url, init })
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  const adapter = await buildAdapter({ access: { type: 'api-key', mode: '' } }, { signingEnabled: false }) // 本节只验头/体,签名单独测
  const chunks = await drive(adapter)
  check('未签名路径:模型请求只发一次', calls.length === 1, `calls=${calls.length}`)
  const req = calls[0]
  check('未签名路径:URL = {baseURL}/v1/messages', req.url === `${BASE}/v1/messages`, req.url)
  const headers = Object.fromEntries(Object.entries(req.init.headers).map(([k, v]) => [k.toLowerCase(), v]))
  const expectUnsigned = OFFICIAL_HEADER_NAMES.filter((h) => !SIGNATURE_HEADERS.includes(h))
  const missing = expectUnsigned.filter((h) => !(h in headers))
  check('未签名路径:官方头集合(不含签名头)全覆盖', missing.length === 0, missing.join(','))
  check('未签名路径:不出现签名头', !SIGNATURE_HEADERS.some((h) => h in headers), SIGNATURE_HEADERS.filter((h) => h in headers).join(','))
  check('未签名路径:x-api-key 与 Authorization 双写', headers['x-api-key'] === key && headers['authorization'] === `Bearer ${key}`)
  check('未签名路径:凭证取账号级 provisioned key(优先于配置层回落)',
    headers['x-api-key'] === key && headers['x-api-key'] !== CONFIG_KEY, `${headers['x-api-key']} vs config ${CONFIG_KEY}`)
  check('未签名路径:不带 accept(与官方一致)', !('accept' in headers))
  const body = JSON.parse(req.init.body)
  check('未签名路径:请求体键序与官方一致',
    JSON.stringify(Object.keys(body)) === JSON.stringify(['model', 'max_tokens', 'metadata', 'system', 'messages', 'tools', 'tool_choice', 'stream', 'thinking', 'output_config']),
    JSON.stringify(Object.keys(body)))
  check('未签名路径:max_tokens 取模型上限', body.max_tokens === 128000, String(body.max_tokens))
  check('未签名路径:thinking = {type:enabled}', JSON.stringify(body.thinking) === '{"type":"enabled"}', JSON.stringify(body.thinking))
  check('未签名路径:output_config.effort = max', body.output_config?.effort === 'max')
  check('未签名路径:tool_choice = {type:auto}', JSON.stringify(body.tool_choice) === '{"type":"auto"}')
  check('未签名路径:stream = true', body.stream === true)
  const expectedSystem = [
    prompt.OFFICIAL_SYSTEM_IDENTITY,
    prompt.OFFICIAL_SYSTEM_AGENT_PROMPT,
    prompt.officialRuntimePrompt('fixture:direct-wire', 'GLM-5.3'),
  ]
  check('未签名路径:system 恰好为官方三块且逐字一致',
    Array.isArray(body.system)
    && body.system.length === 3
    && JSON.stringify(body.system.map((block) => block.text)) === JSON.stringify(expectedSystem)
    && body.system.every((block) => block.type === 'text' && block.cache_control?.type === 'ephemeral'),
    `blocks=${body.system?.length} lengths=${body.system?.map((block) => block.text?.length).join(',')}`)
  check('未签名路径:DSH option/history system 均未进入请求体',
    !req.init.body.includes('DSH_OPTION_SYSTEM_SENTINEL')
    && !req.init.body.includes('DSH_HISTORY_SYSTEM_SENTINEL'))
  const userId = JSON.parse(body.metadata.user_id)
  check('未签名路径:metadata.user_id 三字段', ['device_id', 'account_uuid', 'session_id'].every((k) => k in userId), body.metadata.user_id)
  check('未签名路径:device_id 取自设备标识文件', userId.device_id === DEVICE_MID, `${userId.device_id} vs ${DEVICE_MID}`)
  check('未签名路径:x-session-id 去掉 sess_ 前缀', headers['x-session-id'] === 'aabc17af-af64-48c6-92d9-9613c54d3390', headers['x-session-id'])
  check('未签名路径:流式解析产出文本与收尾', chunks.some((c) => c.type === 'text-delta' && c.text === 'ok') && chunks.at(-1)?.type === 'finish')
}

// ---- 2. 签名路径:门闩 → 握手 → Ed25519 + PoW ----
{
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
  const [apiKeyId, apiKeySecret] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)]
  const derive = (secret, info) => Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('WD_CLIENT_SIGN_KDF_SALT', 'utf8'), Buffer.from(info, 'utf8'), 32))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derive(apiKeySecret, 'ed25519_priv'), iv)
  cipher.setAAD(Buffer.from(apiKeyId, 'utf8'))
  // 官方 privateCipher 的明文是一段 base64 文本,再解一次才是 PKCS8 DER
  const plaintext = Buffer.from(pkcs8.toString('base64'), 'utf8')
  const wrapped = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64')

  const seen = { gate: 0, handshake: 0, model: 0 }
  let modelHeaders
  let handshakeBody
  stubFetch(async (href, init) => {
    if (href.includes('/api/v1/agent/configs')) {
      seen.gate += 1
      const gateHeaders = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]))
      check('签名路径:门闩请求带 x-api-key', gateHeaders['x-api-key'] === key)
      check('签名路径:门闩请求带官方源码头', gateHeaders['x-title'] === 'Z Code@electron' && gateHeaders['x-zcode-agent'] === 'glm')
      return new Response(JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: true } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/api/paas/c1f3a7e2/v2/client')) {
      seen.handshake += 1
      handshakeBody = JSON.parse(init.body)
      const expectSig = createHmac('sha256', derive(apiKeySecret, 'getSignKey_hmac'))
        .update(`get_sign_key\n${apiKeyId}\n${handshakeBody.ts}\n${handshakeBody.nonce}`).digest('base64')
      check('签名路径:握手签名 = HMAC(HKDF(secret,getSignKey_hmac), get_sign_key\\nid\\nts\\nnonce)', handshakeBody.sig === expectSig)
      check('签名路径:握手 nonce 为 16 字节 hex', /^[0-9a-f]{32}$/.test(handshakeBody.nonce), handshakeBody.nonce)
      check('签名路径:握手 Authorization = 完整凭证', init.headers.Authorization === key)
      return new Response(JSON.stringify({ code: 200, data: { privateCipher: wrapped } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/v1/messages')) {
      seen.model += 1
      modelHeaders = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]))
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`unexpected fetch ${href}`)
  })

  const adapter = await buildAdapter() // access = zhipu-account/individual-coding-plan → 需要签名
  await drive(adapter)
  check('签名路径:门闩被调用', seen.gate === 1, String(seen.gate))
  check('签名路径:握手被调用', seen.handshake === 1, String(seen.handshake))
  check('签名路径:模型请求发出', seen.model === 1, String(seen.model))
  const signed = ['x-client-ts', 'x-client-version', 'x-client-sig', 'x-session-id', 'x-client-nonce', 'x-app-id', 'x-client-pow']
  if (!signed.every((h) => h in modelHeaders)) console.log('  调试日志:', debugLogs.filter((l) => l.includes('签名')).join(' | ') || '(无签名相关日志)')
  check('签名路径:签名头齐全', signed.every((h) => h in modelHeaders), signed.filter((h) => !(h in modelHeaders)).join(','))
  if (captureHeaders) {
    const officialNames = Object.keys(captureHeaders).map((h) => h.toLowerCase()).sort()
    const pluginNames = Object.keys(modelHeaders).sort()
    check('签名路径:头名集合与官方抓包逐名一致', JSON.stringify(officialNames) === JSON.stringify(pluginNames),
      `only-plugin=${pluginNames.filter((h) => !officialNames.includes(h))} only-official=${officialNames.filter((h) => !pluginNames.includes(h))}`)
    const fixed = ['user-agent', 'anthropic-version', 'anthropic-beta', 'http-referer', 'x-release-channel',
      'x-zcode-agent', 'x-zcode-app-version', 'x-os-category', 'x-platform', 'x-client-language', 'x-client-timezone',
      'x-app-id', 'x-client-version']
    // 版本类头**不**与旧抓包逐字段比对:抓包来自早先安装的 3.14.1,而本机现在的
    // 桌面版 asar 里版本常量是 3.14.3(`var qc="3.14.3"`),插件跟随后者才是忠实的。
    // 这里改为断言「版本取自 ZCODE_CLIENT_VERSION 这一个真源,且三处一致」。
    const VERSION_HEADERS = ['user-agent', 'x-zcode-app-version', 'x-client-version']
    const versionFree = fixed.filter((h) => !VERSION_HEADERS.includes(h))
    const diff = versionFree.filter((h) => modelHeaders[h] !== captureHeaders[h])
    check('签名路径:固定头值(除版本类)与官方抓包逐字段一致',
      diff.length === 0,
      diff.map((h) => `${h}: plugin=${modelHeaders[h]} official=${captureHeaders[h]}`).join(' | '))
    check('签名路径:版本头三处一致且取自 ZCODE_CLIENT_VERSION',
      modelHeaders['x-client-version'] === wire.ZCODE_CLIENT_VERSION
      && modelHeaders['x-zcode-app-version'] === wire.ZCODE_CLIENT_VERSION
      && modelHeaders['user-agent'].startsWith(`ZCode/${wire.ZCODE_CLIENT_VERSION} `),
      `${modelHeaders['x-client-version']} / ${modelHeaders['x-zcode-app-version']} / ${modelHeaders['user-agent']}`)
    check('签名路径:UA 后缀与官方抓包同构(仅版本号按当前客户端)',
      modelHeaders['user-agent'].endsWith('ai-sdk/provider-utils/4.0.27 runtime/node.js/24')
      && captureHeaders['user-agent'].endsWith('ai-sdk/provider-utils/4.0.27 runtime/node.js/24'),
      modelHeaders['user-agent'])
    // 会话与来源标识按配置/会话取值,不逐字段比对内容
    check('签名路径:X-Title 与抓包同构(仅来源标识按配置变化)',
      modelHeaders['x-title'] === 'Z Code@electron' && captureHeaders['x-title'] === 'Z Code@cli')
    check('签名路径:X-Session-Id 取本次会话 id', modelHeaders['x-session-id'] === 'aabc17af-af64-48c6-92d9-9613c54d3390')
  }
  const message = `${apiKeyId}\n${modelHeaders['x-client-ts']}\n${modelHeaders['x-client-version']}\n${modelHeaders['x-session-id']}\n${modelHeaders['x-client-nonce']}`
  const sigOk = ed25519Verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(modelHeaders['x-client-sig'], 'base64'))
  check('签名路径:Ed25519 签名在服务端公钥下可验证(换行分隔消息)', sigOk)
  const pow = modelHeaders['x-client-pow']
  const seed = createHash('sha256').update(`${apiKeyId}\nzcode\n${modelHeaders['x-session-id']}\n${modelHeaders['x-client-ts']}`).digest('hex').slice(0, 32)
  const digest = createHash('sha256').update(`${seed}\n${pow}`).digest()
  check('签名路径:PoW 满足 8 比特前导零', /^[0-9a-f]{32}$/.test(pow) && digest[0] === 0, `${pow} first=${digest[0]}`)
  // 用官方抓到的握手样本交叉校验派生实现(消息换行分隔 + HKDF salt/info);
  // 仅当抓包用的是同一把凭证时才可比(测试用合成凭证,真机核验见 .zcode-analysis/verify-handshake-crypto.mjs)
  if (captureHandshake && String(captureHandshake.apiKey ?? '').split('.')[0] === apiKeyId) {
    const expect = createHmac('sha256', derive(apiKeySecret, 'getSignKey_hmac'))
      .update(`get_sign_key\n${apiKeyId}\n${captureHandshake.ts}\n${captureHandshake.nonce}`).digest('base64')
    check('签名路径:派生实现与官方握手样本逐字节一致', expect === captureHandshake.sig, `got=${expect.slice(0, 16)} official=${String(captureHandshake.sig).slice(0, 16)}`)
  } else {
    check('签名路径:抓包凭证与测试凭证不同,跳过样本比对(真机核验脚本独立)', true)
  }
  check('签名路径:x-app-id = zcode', modelHeaders['x-app-id'] === 'zcode')
  check('签名路径:x-client-version 与 UA/版本头同源', modelHeaders['x-client-version'] === wire.ZCODE_CLIENT_VERSION,
    `${modelHeaders['x-client-version']} vs ${wire.ZCODE_CLIENT_VERSION}`)

  // 门闩与私钥按官方语义缓存:第二次调用不再查门闩/握手
  await drive(adapter)
  check('签名路径:门闩与私钥按官方语义缓存', seen.gate === 1 && seen.handshake === 1, `gate=${seen.gate} handshake=${seen.handshake}`)
}

// ---- 3. 签名不可用时 fail-open(官方语义) ----
{
  let modelHeaders
  let gateCalls = 0
  stubFetch(async (href, init) => {
    if (href.includes('/api/v1/agent/configs')) {
      gateCalls += 1
      return new Response(JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: false } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/v1/messages')) {
      modelHeaders = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]))
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`unexpected fetch ${href}`)
  })
  await drive(await buildAdapter())
  check('fail-open:门闩关闭时按未签名发送且请求成功', modelHeaders !== undefined && !('x-client-sig' in modelHeaders))
  check('fail-open:门闩仍被查询', gateCalls === 1, String(gateCalls))
}

// ---- 4. 签名被网关拒绝:重握手重试一次,再失败即旁路发未签名(官方语义) ----
{
  const { privateKey } = generateKeyPairSync('ed25519')
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
  const [apiKeyId, apiKeySecret] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)]
  const derive = (secret, info) => Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('WD_CLIENT_SIGN_KDF_SALT', 'utf8'), Buffer.from(info, 'utf8'), 32))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derive(apiKeySecret, 'ed25519_priv'), iv)
  cipher.setAAD(Buffer.from(apiKeyId, 'utf8'))
  const wrapped = Buffer.concat([iv, cipher.update(Buffer.from(pkcs8.toString('base64'), 'utf8')), cipher.final(), cipher.getAuthTag()]).toString('base64')

  const posts = []
  let handshakes = 0
  stubFetch(async (href, init) => {
    if (href.includes('/api/v1/agent/configs')) {
      return new Response(JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: true } } }), { status: 200 })
    }
    if (href.includes('/api/paas/c1f3a7e2/v2/client')) {
      handshakes += 1
      return new Response(JSON.stringify({ code: 200, data: { privateCipher: wrapped } }), { status: 200 })
    }
    if (href.includes('/v1/messages')) {
      const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]))
      posts.push(headers)
      if (posts.length <= 2) return new Response(JSON.stringify({ reason: 'VERIFY_SIGNATURE_INVALID' }), { status: 401 })
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`unexpected fetch ${href}`)
  })

  const adapter = await buildAdapter()
  await drive(adapter)
  check('拒绝重试阶梯:共发 3 次模型请求(签名→重签→未签名)', posts.length === 3, String(posts.length))
  check('拒绝重试阶梯:重试前重新握手一次(共 2 次)', handshakes === 2, String(handshakes))
  check('拒绝重试阶梯:第 1、2 次带签名,第 3 次不带',
    'x-client-sig' in posts[0] && 'x-client-sig' in posts[1] && !('x-client-sig' in posts[2]))
}

// ---- 6. 会话 id 归一化(官方 Hit 语义) ----
{
  const calls = []
  let lastBody
  stubFetch(async (href, init) => {
    if (href.includes('/v1/messages')) {
      calls.push(Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])))
      lastBody = JSON.parse(init.body)
      return new Response(SSE, { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: false } } }), { status: 200 })
  })
  const adapter = await buildAdapter({ access: { type: 'api-key', mode: '' } }, { signingEnabled: false })
  const driveWith = async (sessionId) => {
    calls.length = 0
    for await (const _c of adapter.stream({ ...streamOptions, sessionId })) { /* drain */ }
    return calls.at(-1)
  }
  check('会话 id:sess_ 前缀被剥掉', (await driveWith('sess_abc-123'))['x-session-id'] === 'abc-123')
  check('会话 id:subagent_agent_ 前缀被剥掉', (await driveWith('subagent_agent_abc-123'))['x-session-id'] === 'abc-123')
  check('会话 id:sess_ + subagent_agent_ 顺序剥掉', (await driveWith('sess_subagent_agent_xy'))['x-session-id'] === 'xy')
  check('会话 id:裸 id 原样保留', (await driveWith('plain-id'))['x-session-id'] === 'plain-id')
  check('会话 id:只有前缀时按官方语义原样返回', (await driveWith('sess_'))['x-session-id'] === 'sess_')
  // metadata.user_id 与官方 JOs 一致:无会话 id 时 session_id 为 ""
  await driveWith(undefined)
  const uid = JSON.parse(lastBody.metadata.user_id)
  check('会话 id:缺失时 metadata.session_id 为 ""(与官方 JOs 一致)', uid.session_id === '', JSON.stringify(uid))
  await driveWith('sess_zz-9')
  check('会话 id:归一化同时作用于 metadata.session_id',
    JSON.parse(lastBody.metadata.user_id).session_id === 'zz-9', lastBody.metadata.user_id)
}

console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} 项通过`)
if (failures.length) {
  console.error(`\n失败项:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
