/**
 * 本机账号路由推导测试:内置目录 → 账号端点映射、官方凭证库 → 条目产出、
 * 以及 extractRoutes 在插件 provider 配置缺失(ENOENT)时的整体回退。
 * 依据 `lib/`(构建产物)测试,与 credentials.mjs 同风格。
 *
 * 用法:node tests/native-account.mjs(需先 npm run build)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const {
  accountEndpointsFromCatalog,
  nativeAccountProviders,
  nativeCredentialPath,
} = await import(pathToFileURL(join(here, '..', 'lib', 'native-account.js')).href)
const { extractRoutes } = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const { resolvePlanCredential, readCredentialValue } =
  await import(pathToFileURL(join(here, '..', 'lib', 'credentials.js')).href)

const failures = []
let passed = 0
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${label}  ${detail}`) }
}

const catalog = {
  schemaVersion: 1,
  config: { providerConfigRules: { providerRules: [
    {
      providerId: 'account:bigmodel-individual-coding-plan',
      config: { access: { type: 'zhipu-account', mode: 'individual-coding-plan' }, api: { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic/' } },
    },
    {
      providerId: 'account:bigmodel-team-coding-plan',
      config: { access: { type: 'zhipu-account', mode: 'team-coding-plan' }, api: { baseUrl: 'https://open.bigmodel.cn/api/anthropic' } },
    },
    {
      providerId: 'account:bigmodel-start-plan',
      config: { access: { type: 'zhipu-account', mode: 'start-plan' }, api: { baseUrl: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' } },
    },
    {
      providerId: 'account:zai-individual-coding-plan',
      config: { access: { type: 'zhipu-account' }, api: { baseUrl: 'https://api.z.ai/api/anthropic' } },
    },
    {
      providerId: 'some-custom-provider',
      config: { access: { type: 'api-key' }, api: { baseUrl: 'https://custom.invalid/v1' } },
    },
    { providerId: 'account:bigmodel-offpeak-idle-plan', config: { access: { type: 'zhipu-account' }, api: {} } },
  ] } },
}

// ---- 1. 目录 → 账号端点映射(纯函数) ----
const endpoints = accountEndpointsFromCatalog(catalog)
const byKey = new Map(endpoints.map((e) => [e.key, e]))
const coding = byKey.get('builtin:bigmodel-coding-plan')
check('映射:individual+team 合并为一条 coding-plan 路由', coding !== undefined && coding.modes.length === 2
  && coding.modes.includes('individual-coding-plan') && coding.modes.includes('team-coding-plan'))
check('映射:baseURL 去尾部斜杠', coding?.baseURL === 'https://open.bigmodel.cn/api/anthropic', String(coding?.baseURL))
check('映射:start-plan 独立成键', byKey.get('builtin:bigmodel-start-plan')?.baseURL === 'https://zcode.z.ai/api/v1/zcode-plan/anthropic')
check('映射:zai 族生成独立键', byKey.get('builtin:zai-coding-plan')?.family === 'zai')
check('映射:非账号规则与缺 baseUrl 规则被忽略', ![...byKey.keys()].includes('builtin:bigmodel-offpeak-idle-plan')
  && ![...byKey.keys()].some((k) => k.includes('custom')))
check('映射:畸形目录返回空数组', accountEndpointsFromCatalog({ nope: 1 }).length === 0 && accountEndpointsFromCatalog(null).length === 0)
check('映射:off-peak 不在采纳范围', !endpoints.some((e) => e.key.includes('offpeak')))

// ---- 2. 本机登录态 → 账号条目 ----
const dir = mkdtempSync(join(tmpdir(), 'zcode-native-'))
const nativeCredPath = join(dir, 'native-credentials.json')
const builtinPath = join(dir, 'zcode-builtin.json')
const INDIVIDUAL = 'account:bigmodel-individual-coding-plan'
const IDENTITY = '44000000000000000'
const PLAN_KEY = 'provisioned-key.0123456789abcdef'
try {
  writeFileSync(builtinPath, JSON.stringify(catalog), 'utf8')
  writeFileSync(nativeCredPath, JSON.stringify({
    'oauth:active_provider': 'bigmodel',
    'zcodejwttoken': 'jwt-from-native-store',
    [`account-provider:${INDIVIDUAL}:identity`]: IDENTITY,
    [`account-provider:coding-plan:${INDIVIDUAL}:account:${IDENTITY}:api-key`]: PLAN_KEY,
  }), 'utf8')

  const derived = nativeAccountProviders({ builtinPath, credentialsPath: nativeCredPath })
  check('推导:已登录的 coding plan 产出条目', derived['builtin:bigmodel-coding-plan'] !== undefined)
  check('推导:条目携带 provisioned key 与目录端点',
    derived['builtin:bigmodel-coding-plan']?.options.apiKey === PLAN_KEY
    && derived['builtin:bigmodel-coding-plan']?.options.baseURL === 'https://open.bigmodel.cn/api/anthropic')
  check('推导:start-plan 用 zcodejwttoken', derived['builtin:bigmodel-start-plan']?.options.apiKey === 'jwt-from-native-store')
  check('推导:未登录的 zai 族不产出(无死路由)', derived['builtin:zai-coding-plan'] === undefined)

  const loggedOut = nativeAccountProviders({ builtinPath, credentialsPath: join(dir, 'nope.json') })
  check('推导:本机无登录态时产出为空', Object.keys(loggedOut).length === 0)
  check('推导:目录缺失时产出为空', Object.keys(nativeAccountProviders({ builtinPath: join(dir, 'nope.json'), credentialsPath: nativeCredPath })).length === 0)
  check('路径:官方凭证库位于 `~/.zcode/v2` 下',
    nativeCredentialPath().toLowerCase().replaceAll('/', '\\').endsWith(join('.zcode', 'v2', 'credentials.json')),
    nativeCredentialPath())

  // ---- 3. extractRoutes:providers.json 缺失时的整体回退 ----
  const native = { builtinPath, credentialsPath: nativeCredPath }
  const pluginCredPath = join(dir, 'plugin-credentials.json')
  writeFileSync(pluginCredPath, '{}', 'utf8')

  const routesFromNative = extractRoutes(join(dir, 'missing-providers.json'), true, pluginCredPath, native)
  const codingRoute = routesFromNative.find((r) => r.route === 'builtin:bigmodel-coding-plan')
  check('回退:路由从本机登录态推导', codingRoute !== undefined)
  check('回退:coding plan 带 individual 模式与 provisioned key',
    codingRoute?.access?.mode === 'individual-coding-plan' && codingRoute?.apiKey === PLAN_KEY,
    `${codingRoute?.access?.mode} / ${codingRoute?.apiKey}`)
  check('回退:凭证来源标记 credential-store', codingRoute?.credential === 'credential-store', String(codingRoute?.credential))
  check('回退:模型目录来自可审计回退表', (codingRoute?.models.length ?? 0) >= 1)
  const startRoute = routesFromNative.find((r) => r.route === 'builtin:bigmodel-start-plan')
  check('回退:start plan 路由同时推导', startRoute?.access?.mode === 'start-plan' && startRoute?.apiKey === 'jwt-from-native-store')

  const emptyRoutes = extractRoutes(join(dir, 'missing-providers.json'), true, pluginCredPath,
    { builtinPath, credentialsPath: join(dir, 'nope.json') })
  check('回退:本机无登录态时无路由(不注册死路由)', emptyRoutes.length === 0)

  const providersPath = join(dir, 'providers.json')
  writeFileSync(providersPath, JSON.stringify({ provider: {
    'custom-one': { kind: 'anthropic', options: { baseURL: 'https://example.invalid/v1', apiKey: 'k' }, models: { 'm1': {} } },
  } }), 'utf8')
  const routesFromFile = extractRoutes(providersPath, true, pluginCredPath, native)
  check('优先级:providers.json 存在时不走本机推导',
    routesFromFile.length === 1 && routesFromFile[0].route === 'custom-one',
    routesFromFile.map((r) => r.route).join(','))

  // ---- 4. 凭证层:官方本机库回退 ----
  const pluginOnly = join(dir, 'plugin-only.json')
  writeFileSync(pluginOnly, JSON.stringify({
    [`account-provider:${INDIVIDUAL}:identity`]: 'someone-else',
    [`account-provider:coding-plan:${INDIVIDUAL}:account:someone-else:api-key`]: 'plugin-key',
  }), 'utf8')
  const viaFallback = resolvePlanCredential({
    credentialsPath: join(dir, 'nope.json'), providerId: INDIVIDUAL, family: 'bigmodel',
    planKind: 'individual-coding-plan', fallbackCredentialsPath: nativeCredPath,
  })
  check('凭证回退:插件库缺失时从官方本机库取 provisioned key',
    viaFallback.apiKey === PLAN_KEY && viaFallback.source === 'credential-store', `${viaFallback.apiKey} / ${viaFallback.source}`)
  const primaryWins = resolvePlanCredential({
    credentialsPath: pluginOnly, providerId: INDIVIDUAL, family: 'bigmodel',
    planKind: 'individual-coding-plan', fallbackCredentialsPath: nativeCredPath,
  })
  check('凭证回退:插件库已有的键优先', primaryWins.apiKey === 'plugin-key', primaryWins.apiKey)
  check('readCredentialValue:本机库兜底补 oauth token',
    readCredentialValue(join(dir, 'nope.json'), 'oauth:bigmodel:access_token', { fallbackPath: nativeCredPath }) === ''
      && readCredentialValue(join(dir, 'nope.json'), 'zcodejwttoken', { fallbackPath: nativeCredPath }) === 'jwt-from-native-store')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed}/${passed + failures.length} 项通过`)
if (failures.length) {
  console.error(`\n失败项:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
