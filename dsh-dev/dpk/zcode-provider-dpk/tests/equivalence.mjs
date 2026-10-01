/**
 * 等价性自检:同一份 zcode 设备配置下,比较「旧的自包含打包产物」与
 * 「tsc 构建的标准输出」注册出的路由、提供商与模型目录是否逐项一致。
 *
 * 用法:node tests/equivalence.mjs <旧 lib/index.js 的绝对路径>
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const previousPath = process.argv[2]

/** 用桩上下文执行一次 apply,记录注册结果。 */
async function registrations(entry) {
  const { apply } = await import(pathToFileURL(entry).href)
  const adapters = new Map()
  const providers = []
  const warnings = []
  const ctx = {
    fiber: { entry: { options: { id: '@local/zcode-provider' } } },
    llm: {
      registerAdapter(routes, adapter) { for (const route of routes) adapters.set(route, adapter) },
      registerConfigurableProviders(regs) { providers.push(...regs) },
    },
    get() { return undefined },
    // 本文件只比对路由/模型目录:tools 未就绪,插件跳过 zcode_usage 工具
    inject() { return { dispose() {} } },
    logger: {
      info() {},
      warn(message) { warnings.push(String(message)) },
      debug() {},
    },
  }
  await apply(ctx, {})
  const models = {}
  for (const [route, adapter] of adapters) {
    models[route] = (await adapter.listModels(route)).map((m) => m.id)
  }
  return { providers, models, warnings }
}

const next = await registrations(new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

if (previousPath === undefined) {
  console.log(`新增构建:${next.providers.length} 条路由`)
  for (const { provider, displayName } of next.providers) console.log(`  ${provider}  ${displayName}`)
  process.exit(0)
}

const previous = await registrations(previousPath)

assert.deepEqual(next.providers, previous.providers, '注册的可配置提供商必须一致')
assert.deepEqual(next.models, previous.models, '每条路由的模型目录必须一致')
console.log(`OK  路由 ${next.providers.length} 条,模型目录与旧构建逐项一致`)
for (const { provider, displayName } of next.providers) {
  console.log(`  ${provider}  ${displayName}  [${next.models[provider].join('/')}]`)
}
