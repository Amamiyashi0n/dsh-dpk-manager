/**
 * 真实组合(real-composition)测试:用**真的 Cordis Loader** 从一份 test-only 的
 * `cordis.yml` 装载插件,断言真实注册表(llm / tools)与 fiber 生命周期。
 *
 * 与 `tests/official-wire.mjs` 等的区别:那些用手搓的假 `ctx` 直接调用 `apply`;
 * 本测试让 Loader 自己 import 插件模块、自己建立 fiber、自己按 `inject` 排依赖,
 * 并在释放 fiber 后断言贡献被摘除(HMR 安全性)。
 *
 * 依据 DSH 的 testing 政策:对外可见的插件必须有真实组合测试
 * (`docs/testing.md`「Product-visible plugins require a non-unit REAL-composition test」),
 * 且函数式插件要额外断言"没有 default 导出被 Loader 当成插件主体"。
 *
 * 用法:npm run test:integration(需要仓库 devDependencies 里的 Cordis 家族包,
 * 不随归档解包环境运行——包内默认 `npm test` 不含本文件)
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const fixtures = join(here, 'fixtures')
const pluginEntry = pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href

const failures = []
let passed = 0
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${label}  ${detail}`) }
}

/** 收集一次 boot 的全部可释放资源。 */
const live = []
async function teardown() {
  for (const ctx of live.splice(0)) {
    try { await ctx.fiber.dispose() } catch (_alreadyDisposed) { /* 释放失败不影响后续断言 */ }
  }
}
let root

/**
 * 用真实 Loader 从一份 test-only yml 组合插件。
 *
 * yml 写在系统临时目录(不在仓库内,因此不参与仓库的 cordis 配置门禁),插件本体按
 * **file URL** 指定 —— 与 `packages/bundle/headless/tests/startup.spec.ts` 同一手法。
 * `ctx.baseUrl` 指向插件根,使插件行里的裸包名(`@deepseek-ai/dsh-llm` 等)
 * 能沿插件自身的 node_modules 解析。
 *
 * 单条 entry 的 `fiber.await()` 会因该条失败而 reject(cordis 语义),这里逐条吞掉
 * 并记录,便于断言"哪条失败了、状态是什么",而不是让整个 boot 抛出去。
 *
 * @param rows - yml 行(每行一个条目)。
 * @returns `{ ctx, entryFailures }`。
 */
async function boot(rows) {
  root = await mkdtemp(join(tmpdir(), 'zcode-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...rows, ''].join('\n'))

  const ctx = new Context()
  live.push(ctx)
  ctx.baseUrl = pathToFileURL(pkgRoot).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entryFailures = new Map()
  for (const entry of ctx.loader.entries()) {
    try {
      await entry.fiber?.await()
    } catch (error) {
      entryFailures.set(entry.options.id, error)
    }
  }
  return { ctx, entryFailures }
}

/** 组合出可观测的最小环境:llm(插件 inject)+ tools 与 system-prompt(tools 依赖)。 */
function pluginRows(extraConfigLines = [], deviceConfig = 'device-config-plans.json') {
  return [
    "- id: llm",
    "  name: '@deepseek-ai/dsh-llm'",
    "- id: system-prompt",
    "  name: '@deepseek-ai/dsh-system-prompt'",
    "- id: tools",
    "  name: '@deepseek-ai/dsh-tools'",
    '  inject:',
    '    - systemPrompt',
    "- id: '@local/zcode-provider'",
    `  name: ${pluginEntry}`,
    '  config:',
    `    providerConfigPath: ${join(fixtures, deviceConfig).replaceAll('\\', '/')}`,
    `    credentialsPath: ${join(fixtures, 'credentials.json').replaceAll('\\', '/')}`,
    `    telemetryStatePath: ${join(fixtures, 'telemetry-state.json').replaceAll('\\', '/')}`,
    '    signingEnabled: false',
    ...extraConfigLines,
  ]
}

/**
 * 权益/用量取数在激活时会真的发一次 fetch。夹具凭证是合成的,打真实端点只会 401;
 * 为了让测试脱离网络,这里把用量端点拦掉,其余请求透传。
 */
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.includes('/api/biz/subscription/list')) {
    return Response.json({ code: 200, data: [{ productId: 'coding', productName: 'Coding', status: 'VALID', inCurrentPeriod: true }] })
  }
  if (href.includes('/api/v1/zcode-plan/billing/balance')) {
    return Response.json({
      code: 0,
      data: {
        server_time: 100,
        plans: [{ user_plan_id: 'up', plan_id: 'zcode-v3-start-plan', name: 'Start Plan', status: 'active', entitlements: [{ entitlement_id: 'e', effective_at: 90 }] }],
        balances: [{ user_plan_id: 'up', plan_id: 'zcode-v3-start-plan', entitlement_id: 'e', capabilities: ['model:glm-5.3-flash'], total_units: 10, used_units: 1, remaining_units: 9 }],
      },
    })
  }
  if (href.includes('/api/monitor/usage/quota/limit')) {
    return Response.json({ code: 200, data: { limits: [] } })
  }
  if (href.includes('/api/monitor/usage/model-usage')) {
    return Response.json({ code: 200, data: {} })
  }
  if (href.includes('/api/v1/mcp/usage')) {
    return Response.json({ code: 0, data: {} })
  }
  return await realFetch(url, init)
}

try {
  // ---- 1. 函数式插件的导出契约(政策要求:防止 default 导出吞掉命名导出) ----
  const mod = await import(pluginEntry)
  check('导出:插件主体不提供 default 导出(否则 Loader 会丢弃命名导出)', !('default' in mod),
    Object.keys(mod).join(','))
  check('导出:提供 name / inject / apply / Config',
    mod.name === '@local/zcode-provider' && Array.isArray(mod.inject) && typeof mod.apply === 'function' && mod.Config !== undefined,
    JSON.stringify({ name: mod.name, inject: mod.inject, apply: typeof mod.apply, Config: mod.Config !== undefined }))
  check('导出:inject 声明为 [llm]', JSON.stringify(mod.inject) === JSON.stringify(['llm']), JSON.stringify(mod.inject))

  // Loader 的 unwrapExports 往返:命名导出插件必须原样返回
  const bare = new Context()
  await bare.plugin(Loader)
  check('导出:Loader.unwrapExports 对命名导出插件原样返回', bare.loader.unwrapExports(mod) === mod)
  await bare.fiber.dispose()

  // ---- 2. 真实组合:Loader 装载 + fiber 就绪 ----
  const { ctx, entryFailures } = await boot(pluginRows())
  check('组合:没有条目启动失败', entryFailures.size === 0,
    [...entryFailures].map(([id, e]) => `${id}: ${String(e).slice(0, 80)}`).join(' | '))

  const entries = [...ctx.loader.entries()]
  const flag = entries.find((e) => e.options.id === '@local/zcode-provider')
  check('组合:Loader 里有 zcode-provider 条目', flag !== undefined, entries.map((e) => e.options.id).join(','))
  check('组合:zcode-provider fiber 处于 ACTIVE', flag?.fiber?.state === 2, String(flag?.fiber?.state))
  check('组合:全部条目 fiber 均 ACTIVE', entries.every((e) => e.fiber?.state === 2),
    entries.map((e) => `${e.options.id}=${e.fiber?.state}`).join(' '))

  // ---- 3. 真实注册表:LLM 适配器 ----
  const providers = ctx.llm.listProviders().map((p) => p.id)
  check('注册表:llm 里出现内置套餐路由 builtin:bigmodel-coding-plan',
    providers.includes('builtin:bigmodel-coding-plan'), providers.join(','))
  check('注册表:llm 里出现 builtin:bigmodel-start-plan', providers.includes('builtin:bigmodel-start-plan'))
  const configurable = ctx.llm.listConfigurableProviders().map((p) => p.provider)
  check('注册表:可配置提供商目录已注册', configurable.length > 0, configurable.join(','))

  // ---- 4. 真实注册表:工具(证明 ctx.inject(['tools']) 真的触发了) ----
  const usageTool = ctx.tools.get('zcode_usage')
  check('注册表:zcode_usage 工具已注册(可选注入 tools 生效)', usageTool !== undefined)
  check('注册表:工具描述声明只读', /Read-only/.test(usageTool?.description ?? ''), usageTool?.description?.slice(0, 60))
  check('注册表:工具 schema 出现在 ctx.tools.schemas()',
    ctx.tools.schemas().some((s) => s.name === 'zcode_usage'))

  // ---- 5. HMR 安全性:释放 fiber 后贡献必须摘除 ----
  await flag.fiber.dispose()
  const afterProviders = ctx.llm.listProviders().map((p) => p.id)
  check('释放:适配器已摘除', !afterProviders.includes('builtin:bigmodel-coding-plan'), afterProviders.join(','))
  check('释放:zcode_usage 工具已摘除', ctx.tools.get('zcode_usage') === undefined)
  check('释放:其余条目仍在(只有 zcode-provider 被摘)', ctx.loader.entries().some((e) => e.options.id === 'llm'))

  // ---- 6. 独立插件路径:设备配置缺失时仍激活,仅不派生外部路由 ----
  // nativeBuiltinCatalogPath/nativeCredentialsPath 注入不存在的路径,把
  // "本机官方登录态回退推导"与真实机器隔离开:这段验证的是纯插件配置
  // 路径的行为,在任何机器上结果都必须一致。
  const { ctx: brokenCtx, entryFailures: brokenFailures } = await boot([
    "- id: llm",
    "  name: '@deepseek-ai/dsh-llm'",
    "- id: '@local/zcode-provider'",
    `  name: ${pluginEntry}`,
    '  config:',
    `    providerConfigPath: ${join(root, 'definitely-missing-config.json').replaceAll('\\', '/')}`,
    `    nativeBuiltinCatalogPath: ${join(root, 'definitely-missing-builtin.json').replaceAll('\\', '/')}`,
    `    nativeCredentialsPath: ${join(root, 'definitely-missing-native-credentials.json').replaceAll('\\', '/')}`,
  ])
  const broken = [...brokenCtx.loader.entries()].find((e) => e.options.id === '@local/zcode-provider')
  check('独立路径:设备配置缺失时 fiber 仍为 ACTIVE(2)', broken?.fiber?.state === 2, String(broken?.fiber?.state))
  check('独立路径:设备配置缺失不产生启动失败', !brokenFailures.has('@local/zcode-provider'),
    [...brokenFailures.keys()].join(','))
  check('独立路径:没有设备配置时不派生账号路由',
    !brokenCtx.llm.listProviders().map((p) => p.id).includes('builtin:bigmodel-coding-plan'))
  check('独立路径:llm 条目本身正常(llm 已就绪)',
    [...brokenCtx.loader.entries()].find((e) => e.options.id === 'llm')?.fiber?.state === 2)
} finally {
  globalThis.fetch = realFetch
  await teardown()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
}

console.log(`\n${passed}/${passed + failures.length} 项通过`)
if (failures.length) {
  console.error(`\n失败项:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
