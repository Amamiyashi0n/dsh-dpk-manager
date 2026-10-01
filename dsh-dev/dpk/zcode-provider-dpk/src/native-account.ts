/**
 * 官方 ZCode 本机登录态 → 插件账号路由(插件自身 provider 配置缺失时的回退源)。
 *
 * 以系统里的真实数据为基准,不要求运维预置 `providers.json`:
 * - 端点来自已发现安装自带的内置目录(`zcode-builtin.json`,与官方客户端同源);
 * - 套餐凭证来自官方凭证库(`~/.zcode/v2/credentials.json`,
 *   与插件凭证同键名空间、同 `enc:v1` 解密规则)。
 *
 * 只产出本机确实登录了的套餐(凭证解析不到即不注册),因此不会出现死路由。
 *
 * @module zcode-provider/native-account
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverZcodeInstall } from './app-server-discovery.js'
import { resolvePlanCredential } from './credentials.js'

/** 内置目录里会被采纳的账号规则:`account:<family>-<plan>`。 */
const ACCOUNT_RULE = /^account:(bigmodel|zai)-(individual-coding-plan|team-coding-plan|start-plan)$/

/** 官方存储目录(与 app-server 传输默认一致:环境覆写 > `~/.zcode/v2`)。 */
export function nativeStorageDir(): string {
  return process.env.ZCODE_STORAGE_DIR?.trim() || join(homedir(), '.zcode', 'v2')
}

/** 官方凭证库路径。 */
export function nativeCredentialPath(): string {
  return join(nativeStorageDir(), 'credentials.json')
}

/** 已发现安装自带的内置目录路径;本机无安装时为 undefined。 */
export function discoveredBuiltinCatalogPath(): string | undefined {
  return discoverZcodeInstall()?.builtinProviderConfigPath
}

/** 目录中一条账号端点:插件条目键 + 官方 provider 族 + 可解析的套餐模式。 */
export interface NativeAccountEndpoint {
  key: string
  family: string
  modes: Array<'individual-coding-plan' | 'team-coding-plan' | 'start-plan'>
  baseURL: string
}

/** 从内置目录 JSON 提取账号端点;individual/team 合并为同一条 coding-plan 路由。 */
export function accountEndpointsFromCatalog(catalog: unknown): NativeAccountEndpoint[] {
  const rules = (catalog as {
    config?: { providerConfigRules?: { providerRules?: unknown[] } }
  } | null)?.config?.providerConfigRules?.providerRules
  if (!Array.isArray(rules)) return []
  const endpoints = new Map<string, NativeAccountEndpoint>()
  for (const rule of rules) {
    const providerId = (rule as { providerId?: unknown } | null)?.providerId
    if (typeof providerId !== 'string') continue
    const matched = ACCOUNT_RULE.exec(providerId)
    if (matched === null) continue
    const config = (rule as {
      config?: { access?: { type?: unknown }; api?: { baseUrl?: unknown } }
    } | null)?.config
    if (config?.access?.type !== 'zhipu-account') continue
    const rawBase = config?.api?.baseUrl
    if (typeof rawBase !== 'string') continue
    const baseURL = rawBase.trim().replace(/\/+$/, '')
    if (baseURL === '') continue
    const family = matched[1]
    const mode = matched[2] as NativeAccountEndpoint['modes'][number]
    const key = mode === 'start-plan' ? `builtin:${family}-start-plan` : `builtin:${family}-coding-plan`
    const existing = endpoints.get(key)
    if (existing === undefined) {
      endpoints.set(key, { key, family, modes: [mode], baseURL })
    } else if (!existing.modes.includes(mode)) {
      existing.modes.push(mode)
    }
  }
  return [...endpoints.values()]
}

/** `providers.json` 形状的账号条目(供 extractRoutes 复用同一条处理循环)。 */
export interface NativeProviderEntry {
  kind: 'anthropic'
  options: { baseURL: string; apiKey: string }
}

/**
 * 从本机官方 ZCode 登录态推导账号条目;目录缺失/损坏或套餐未登录时不产出该条。
 * @param options - 路径注入(测试隔离用)与日志出口。
 */
export function nativeAccountProviders(options: {
  builtinPath?: string
  credentialsPath?: string
  log?: (message: string) => void
} = {}): Record<string, NativeProviderEntry> {
  const builtinPath = options.builtinPath?.trim() || discoveredBuiltinCatalogPath()
  if (builtinPath === undefined || builtinPath === '') return {}
  let catalog: unknown
  try {
    catalog = JSON.parse(readFileSync(builtinPath, 'utf8')) as unknown
  } catch (_missingOrInvalid) {
    // 增强输入静默降级:目录读不到等同"本机没有可推导的账号端点"
    options.log?.(`zcode-provider: 内置目录不可读(${builtinPath}),跳过本机账号路由推导`)
    return {}
  }
  const credentialsPath = options.credentialsPath?.trim() || nativeCredentialPath()
  const entries: Record<string, NativeProviderEntry> = {}
  for (const endpoint of accountEndpointsFromCatalog(catalog)) {
    const resolved = endpoint.modes
      .map((mode) => resolvePlanCredential({
        credentialsPath,
        providerId: `account:${endpoint.family}-${mode}`,
        family: endpoint.family,
        planKind: mode,
        log: (message) => { options.log?.(message) },
      }))
      .find((credential) => credential.apiKey !== '')
    if (resolved === undefined) continue
    entries[endpoint.key] = { kind: 'anthropic', options: { baseURL: endpoint.baseURL, apiKey: resolved.apiKey } }
  }
  return entries
}
