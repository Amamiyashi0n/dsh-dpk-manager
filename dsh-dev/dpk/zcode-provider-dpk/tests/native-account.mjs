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
  discoveredBuiltinCatalogPath,
  modelConfigFromCatalog,
  nativeAccountProviders,
  nativeCredentialPath,
  nativeTelemetryStatePath,
  nativeStorageDir,
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
  config: {
    providerConfigRules: { providerRules: [
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
    ] },
    // 与官方 zcode-builtin.json 同形的模型规则片段(真实值取自 3.14.1 目录的
    // modelConfigRules.modelRules):glm-5.3* → 1M 上下文 / 128K 输出 / 支持图片;
    // 首条 `.*` 兜底 200K/64K;后条覆盖前条。
    modelConfigRules: {
      modelRules: [
        {
          modelMatch: '.*',
          config: { properties: { contextWindow: 200000, inputFormat: { supportsImage: false } }, optionSpecs: { maxOutputTokens: { max: 64000 } } },
        },
        {
          modelMatch: '.*GLM-5-Turbo(?:[.\\-:/\\[].*)?',
          config: { properties: { contextWindow: 200000, inputFormat: { supportsImage: false } }, optionSpecs: { maxOutputTokens: { max: 64000 } } },
        },
        {
          modelMatch: '.*glm-5\\.3(?:-flash)?(?:[.\\-:/\\[].*)?',
          config: { properties: { contextWindow: 1000000, inputFormat: { supportsImage: true, supportsPdf: true } }, optionSpecs: { maxOutputTokens: { max: 128000 } } },
        },
      ],
      // 其余子键(modelApiRules/providerSiteRules/…)与上下文无关,解析器不读。
      providerSiteRules: [
        { modelMatch: 'glm-5\\.3-flash', apiTypeMatch: 'openai-chat-completions', config: { properties: { contextWindow: 512000 } } },
      ],
    },
  },
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

// ---- 1b. 内置目录 → 模型上下文(纯函数,目录正则链) ----
{
  const glm53 = modelConfigFromCatalog(catalog, 'GLM-5.3')
  check('目录上下文:glm-5.3 → 1M 窗口 / 128K 输出(后条覆盖前条)',
    glm53.contextWindow === 1000000 && glm53.maxOutputTokens === 128000, JSON.stringify(glm53))
  const flash = modelConfigFromCatalog(catalog, 'glm-5.3-flash')
  check('目录上下文:glm-5.3-flash 大小写不敏感且支持图片',
    flash.contextWindow === 1000000 && flash.supportsImage === true && flash.supportsPdf === true, JSON.stringify(flash))
  const turbo = modelConfigFromCatalog(catalog, 'GLM-5-Turbo')
  check('目录上下文:GLM-5-Turbo → 200K / 64K', turbo.contextWindow === 200000 && turbo.maxOutputTokens === 64000, JSON.stringify(turbo))
  const openai = modelConfigFromCatalog(catalog, 'glm-5.3', 'openai-chat-completions')
  check('目录上下文:apiTypeMatch 过滤出 openai 专属值', openai.contextWindow === 512000, JSON.stringify(openai))
  const unknown = modelConfigFromCatalog(catalog, 'totally-unknown-model')
  check('目录上下文:未匹配模型仍吃到 `.*` 兜底 200K', unknown.contextWindow === 200000, JSON.stringify(unknown))
  check('目录上下文:畸形目录不抛出', Object.keys(modelConfigFromCatalog(null, 'glm-5.3')).length === 0)
  check('目录上下文:providerSiteRules 等其余子键不参与(openai 特例不覆盖)',
    modelConfigFromCatalog(catalog, 'glm-5.3-flash').contextWindow === 1000000)
}

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
  check('推导:目录缺失时使用官方端点候选并产出已登录路由',
    nativeAccountProviders({ builtinPath: join(dir, 'nope.json'), credentialsPath: nativeCredPath })['builtin:bigmodel-coding-plan'] !== undefined)
  check('路径:官方凭证库位于 `~/.zcode/v2` 下',
    nativeCredentialPath().toLowerCase().replaceAll('/', '\\').endsWith(join('.zcode', 'v2', 'credentials.json')),
    nativeCredentialPath())
  check('路径:官方设备状态位于 `~/.zcode/v2` 下',
    nativeTelemetryStatePath().toLowerCase().replaceAll('/', '\\').endsWith(join('.zcode', 'v2', 'telemetry-state.json')),
    nativeTelemetryStatePath())
  const previousDataBaseDir = process.env.ZCODE_DATA_BASE_DIR
  const previousStorageDir = process.env.ZCODE_STORAGE_DIR
  const previousBuiltinPath = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  const previousCliPath = process.env.DSH_ZCODE_CLI_PATH
  try {
    delete process.env.ZCODE_STORAGE_DIR
    process.env.ZCODE_DATA_BASE_DIR = join(dir, 'official-data')
    check('路径:ZCODE_DATA_BASE_DIR 下使用 `.zcode/v2`', nativeStorageDir() === join(dir, 'official-data', '.zcode', 'v2'))
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = join(dir, 'explicit-built-in.json')
    check('路径:显式内置目录路径优先', discoveredBuiltinCatalogPath() === join(dir, 'explicit-built-in.json'))
    delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
    process.env.DSH_ZCODE_CLI_PATH = join(dir, 'resources', 'glm', 'zcode.cjs')
    check('路径:从 DSH_ZCODE_CLI_PATH 推导内置目录',
      discoveredBuiltinCatalogPath() === join(dir, 'resources', 'config', 'provider', 'zcode-builtin.json'))
  } finally {
    if (previousDataBaseDir === undefined) delete process.env.ZCODE_DATA_BASE_DIR
    else process.env.ZCODE_DATA_BASE_DIR = previousDataBaseDir
    if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR
    else process.env.ZCODE_STORAGE_DIR = previousStorageDir
    if (previousBuiltinPath === undefined) delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
    else process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = previousBuiltinPath
    if (previousCliPath === undefined) delete process.env.DSH_ZCODE_CLI_PATH
    else process.env.DSH_ZCODE_CLI_PATH = previousCliPath
  }

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
  // 上下文同步:模型上下文来自内置目录的正则链(目录里 glm-5.3* = 1M),
  // 不再是硬编码 200000;DSH 侧 resolvedInfo 从同一份 ZcodeModel 读值。
  const glm53Model = codingRoute?.models.find((m) => m.id === 'GLM-5.3')
  check('回退:模型上下文同步自内置目录(glm-5.3 → 1M)',
    glm53Model?.contextWindow === 1000000 && glm53Model?.maxTokens === 128000,
    JSON.stringify(glm53Model))
  const flashModel = codingRoute?.models.find((m) => m.id === 'GLM-5.3-Flash')
  check('回退:glm-5.3-flash 模态同步自目录(text+image)',
    flashModel?.contextWindow === 1000000
    && Array.isArray(flashModel?.inputModalities) && flashModel.inputModalities.includes('image'),
    JSON.stringify(flashModel))
  const startRoute = routesFromNative.find((r) => r.route === 'builtin:bigmodel-start-plan')
  check('回退:start plan 路由同时推导', startRoute?.access?.mode === 'start-plan' && startRoute?.apiKey === 'jwt-from-native-store')

  const emptyRoutes = extractRoutes(join(dir, 'missing-providers.json'), true, pluginCredPath,
    { builtinPath, credentialsPath: join(dir, 'nope.json') })
  check('回退:本机无登录态时无路由(不注册死路由)', emptyRoutes.length === 0)

  // dpk 首装把 providers.json 种成 `{}`:空配置必须同样触发本机回退,
  // 否则全新机器(zcode 已登录、未预置运维配置)永远没有账号路由。
  const seededEmptyPath = join(dir, 'seeded-empty-providers.json')
  writeFileSync(seededEmptyPath, '{}', 'utf8')
  const routesFromEmpty = extractRoutes(seededEmptyPath, true, pluginCredPath, native)
  const emptyCoding = routesFromEmpty.find((r) => r.route === 'builtin:bigmodel-coding-plan')
  check('回退:dpk 种出的空 providers.json 同样推导账号路由', emptyCoding !== undefined
    && emptyCoding?.apiKey === PLAN_KEY,
    routesFromEmpty.map((r) => r.route).join(','))
  const emptyNoLogin = extractRoutes(seededEmptyPath, true, pluginCredPath,
    { builtinPath, credentialsPath: join(dir, 'nope.json') })
  check('回退:空配置且本机未登录时保持无路由', emptyNoLogin.length === 0)

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
