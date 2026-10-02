/**
 * 官方 zcode 的凭证解析(与 `credentials.json` 同源、同规则)。
 *
 * 官方桌面/引擎取模型凭证的顺序(见 `ZCode-open/packages/services/src/model-provider/`):
 * - `account:<family>-individual-coding-plan` / `-team-coding-plan`:
 *   先读 `account-provider:<providerId>:identity` 拿到账号身份,再读
 *   `account-provider:coding-plan:<providerId>:account:<identity>:api-key`;
 * - `account:<family>-start-plan`:账号 active provider 命中该 family 时,用 `zcodejwttoken`;
 * - 都取不到时才回落到 provider 配置里的 `apiKey`。
 *
 * 存储值可能是密文(`enc:v1:<iv>.<tag>.<ct>`,AES-256-GCM),
 * 密钥 = SHA-256(`ZCODE_CREDENTIAL_SECRET` 或
 * `zcode-credential-fallback:<platform>:<homedir>:<username>`)。
 *
 * @module zcode-provider/credentials
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
export { defaultCredentialsPath } from './storage.js'

/** 密文前缀。 */
const ENCRYPTED_PREFIX = 'enc:v1:'
/** 派生密钥的回退种子模板(与官方 `resolveCredentialSecret` 一致)。 */
const FALLBACK_SEED = (home: string, user: string): string => `zcode-credential-fallback:${platform()}:${home}:${user}`
/** 凭证键:`account-provider:<providerId>:identity`。 */
export const identityKey = (providerId: string): string => `account-provider:${providerId}:identity`
/** 凭证键:套餐 api-key(individual/team coding plan)。 */
export const codingPlanApiKeyKey = (providerId: string, identity: string): string =>
  `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`
/** 账号级注入的 start-plan JWT 键。 */
export const ZCODE_JWT_KEY = 'zcodejwttoken'
/** 账号当前选中的 OAuth provider 键。 */
export const ACTIVE_PROVIDER_KEY = 'oauth:active_provider'

/** 凭证来源(用于日志与诊断)。 */
export type CredentialSource = 'credential-store' | 'zcode-jwt' | 'config' | 'none'

/** 解析结果。 */
export interface ResolvedCredential {
  /** 实际使用的凭证;`source` 为 `none` 时为空串。 */
  apiKey: string
  /** 凭证来自哪一层。 */
  source: CredentialSource
}

/** 解析所需输入。 */
export interface ResolvePlanCredentialInput {
  /** `credentials.json` 路径。 */
  credentialsPath: string
  /** 官方运行期 provider id(如 `account:bigmodel-individual-coding-plan`)。 */
  providerId: string
  /** 账号族:`bigmodel` / `zai`。 */
  family?: string
  /** 套餐种类。 */
  planKind?: 'individual-coding-plan' | 'team-coding-plan' | 'start-plan' | 'off-peak'
  /** 配置层 `options.apiKey`,作为最后回落。 */
  fallbackApiKey?: string
  /** 官方本机凭证库(如 `~/.zcode/v2/credentials.json`):插件凭证库缺键时从这里补。 */
  fallbackCredentialsPath?: string
  /** 派生密钥用的主目录(默认当前用户主目录;凭证换机后拷来才会不同)。 */
  home?: string
  /** 派生密钥用的用户名。 */
  user?: string
  /** 日志出口。 */
  log?: (message: string) => void
}

function uniqueProvisionedCredential(
  store: Record<string, string>,
  providerId: string,
  read: (name: string) => string,
  log?: (message: string) => void,
): string | undefined {
  const prefix = `account-provider:coding-plan:${providerId}:account:`
  const suffix = ':api-key'
  const candidates = new Map<string, string>()
  for (const name of Object.keys(store)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
    const encodedIdentity = name.slice(prefix.length, -suffix.length)
    if (encodedIdentity === '') continue
    try {
      decodeURIComponent(encodedIdentity)
      // Reading the value also validates its encryption and gives us a usable
      // credential rather than merely trusting a stale key name.
      const apiKey = read(name)
      if (apiKey !== '') candidates.set(encodedIdentity, apiKey)
    } catch {
      // `read` normalizes decryption failures to an empty value; keep this
      // guard for alternate readers used by embedders and tests.
    }
  }
  if (candidates.size === 1) return candidates.values().next().value
  if (candidates.size > 1) {
    log?.(`zcode-provider: 凭证解析 ${providerId} identity=缺失,provisioned-key 候选不唯一`)
  }
  return undefined
}

/** 读凭证库;文件缺失或损坏时返回空表(官方同样按"未登录"处理)。 */
export function readCredentialStore(credentialsPath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch (_missingOrInvalid) {
    return {}
  }
}

/**
 * 解出存储值:明文原样返回,密文按官方算法解密。
 * @param value - 存储里的原始值。
 * @param key - 32 字节派生密钥。
 * @returns 明文;解密失败抛错(调用方决定回落)。
 */
export function decryptStoreValue(value: string, key: Buffer): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value
  const parts = value.slice(ENCRYPTED_PREFIX.length).split('.')
  if (parts.length !== 3) throw new Error('凭据密文格式非法')
  const iv = Buffer.from(parts[0], 'base64url')
  const tag = Buffer.from(parts[1], 'base64url')
  const ciphertext = Buffer.from(parts[2], 'base64url')
  if (iv.byteLength !== 12) throw new Error('凭据密文 IV 长度非法')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** 派生凭证库密钥(官方环境 secret 优先,否则使用机器/用户绑定的 fallback 种子)。 */
export function deriveCredentialKey(home: string, user: string): Buffer {
  const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim() || FALLBACK_SEED(home, user)
  return createHash('sha256').update(secret).digest()
}

/** 默认主目录/用户名(与官方同源:进程所在用户)。 */
function defaultHome(): string {
  return process.env.USERPROFILE?.trim() || homedir()
}
function defaultUser(): string {
  return process.env.USERNAME?.trim() || process.env.USER?.trim() || (() => {
    try { return userInfo().username } catch (_noUserInfo) { return 'unknown' }
  })()
}

/**
 * 读单个凭证键并解密(官方 `credentialService.load(name)`)。
 *
 * 与 `resolvePlanCredential` 的区别:这里不做任何套餐规则推断,只按名字取值,
 * 供「读 `oauth:active_provider` 做本地资格判定」这类场景使用。
 * @param credentialsPath - `credentials.json` 路径。
 * @param name - 凭证键名。
 * @param options - 可选的 home/user 与日志出口。
 * @returns 明文值;缺失或解密失败返回空串。
 */
export function readCredentialValue(
  credentialsPath: string,
  name: string,
  options: { home?: string; user?: string; log?: (message: string) => void; fallbackPath?: string } = {},
): string {
  const key = deriveCredentialKey(options.home ?? defaultHome(), options.user ?? defaultUser())
  const readOne = (path: string): string => {
    const raw = readCredentialStore(path)[name]
    if (raw === undefined) return ''
    try {
      return decryptStoreValue(raw, key).trim()
    } catch (error) {
      options.log?.(`zcode-provider: 凭据 ${name} 解密失败(${String(error)}),按缺失处理`)
      return ''
    }
  }
  const primary = readOne(credentialsPath)
  if (primary !== '') return primary
  const fallback = options.fallbackPath?.trim() ?? ''
  if (fallback === '' || fallback === credentialsPath) return ''
  return readOne(fallback)
}

/**
 * 按官方规则解析某个套餐 provider 的模型凭证。
 * @param input - 凭证库路径、provider id、套餐种类与回落值。
 * @returns 凭证与来源;`config` 表示回落到了配置层,`none` 表示都拿不到。
 */
export function resolvePlanCredential(input: ResolvePlanCredentialInput): ResolvedCredential {
  const fallback = (input.fallbackApiKey ?? '').trim()
  const store = readCredentialStore(input.credentialsPath)
  const fallbackStorePath = input.fallbackCredentialsPath?.trim() ?? ''
  if (fallbackStorePath !== '' && fallbackStorePath !== input.credentialsPath) {
    // 插件凭证库缺键时用官方本机库补齐(键名空间与解密规则同源);主库已有的键优先
    for (const [name, value] of Object.entries(readCredentialStore(fallbackStorePath))) {
      if (store[name] === undefined) store[name] = value
    }
  }
  const key = deriveCredentialKey(input.home ?? defaultHome(), input.user ?? defaultUser())
  const read = (name: string): string => {
    const raw = store[name]
    if (raw === undefined) return ''
    try {
      return decryptStoreValue(raw, key).trim()
    } catch (error) {
      input.log?.(`zcode-provider: 凭据 ${name} 解密失败(${String(error)}),按缺失处理`)
      return ''
    }
  }

  if (input.planKind === 'individual-coding-plan' || input.planKind === 'team-coding-plan') {
    const identity = read(identityKey(input.providerId))
    if (identity) {
      const provisioned = read(codingPlanApiKeyKey(input.providerId, identity))
      if (provisioned) return { apiKey: provisioned, source: 'credential-store' }
      input.log?.(`zcode-provider: 凭证解析 ${input.providerId} identity=命中,provisioned-key=缺失或解密失败`)
    } else {
      const recovered = uniqueProvisionedCredential(store, input.providerId, read, input.log)
      if (recovered !== undefined) {
        input.log?.(`zcode-provider: 凭证解析 ${input.providerId} identity=缺失,按唯一 provisioned-key 恢复`)
        return { apiKey: recovered, source: 'credential-store' }
      }
      input.log?.(`zcode-provider: 凭证解析 ${input.providerId} identity=缺失或解密失败`)
    }
  }

  if (input.planKind === 'start-plan' || input.planKind === 'off-peak') {
    const active = read(ACTIVE_PROVIDER_KEY)
    if (input.family !== undefined && active === input.family) {
      const jwt = read(ZCODE_JWT_KEY) || read('zcodeJwtToken')
      if (jwt) return { apiKey: jwt, source: 'zcode-jwt' }
      input.log?.(`zcode-provider: 凭证解析 ${input.providerId} active_provider=匹配(${input.family}),jwt=缺失或解密失败`)
    } else {
      input.log?.(`zcode-provider: 凭证解析 ${input.providerId} active_provider=不匹配或缺失(期望 ${input.family ?? 'unknown'})`)
    }
  }

  if (fallback) return { apiKey: fallback, source: 'config' }
  return { apiKey: '', source: 'none' }
}
