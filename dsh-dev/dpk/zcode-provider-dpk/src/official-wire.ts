/**
 * ZCode 3.14.3-compatible 出站线格式:归因头、请求级身份头与客户端签名。
 *
 * 本文件是协议本身的完整可审计实现，不加载外部运行时或预编译业务模块。
 *
 * @module zcode-provider/official-wire
 */

import { createDecipheriv, createHash, createHmac, createPrivateKey, hkdfSync, randomBytes, sign as ed25519Sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * 官方客户端版本;`X-ZCode-App-Version` 与 `User-Agent` 都用它。
 *
 * 取 **3.14.3** 而不是早先抓包时的 3.14.1:本机安装的桌面版 asar 里版本常量就是
 * `var qc="3.14.3"`(构建 `ab4d5e6b`,构建时间 `2026-09-22T03:05:10.708Z`),
 * 而 `~/.zcode/v2/config.json` 也是这个版本生成的。归因头自报的版本与设备上
 * 真实客户端一致才不会自相矛盾。
 */
export const ZCODE_CLIENT_VERSION = '3.14.3'
/** 官方默认 zcode 端点(HTTP-Referer / 签名门闩 origin 的来源)。 */
export const ZCODE_ENDPOINT_ORIGIN = 'https://zcode.z.ai'
/** 签名门闩:GET 该路径,读 `data.codingPlanSignature.enable`。 */
export const SIGNATURE_GATE_PATH = '/api/v1/agent/configs'
/** 签名握手:POST `<provider origin>` + 该路径。 */
export const SIGN_HANDSHAKE_PATH = '/api/paas/c1f3a7e2/v2/client'
/** 握手签名消息前缀。 */
export const SIGN_MESSAGE_PREFIX = 'get_sign_key'
/** 客户端签名主体:appId。 */
export const SIGN_APP_ID = 'zcode'
/** HKDF salt / info(私钥与握手密钥都从这里派生)。 */
export const SIGN_KDF_SALT = 'WD_CLIENT_SIGN_KDF_SALT'
export const SIGN_KEY_INFO = 'getSignKey_hmac'
export const SIGN_PRIVATE_KEY_INFO = 'ed25519_priv'
/** PoW 前导零比特数。 */
export const SIGN_POW_BITS = 8
/** 签名 nonce 字节数(hex 后 32 字符);PoW nonce 为 12 字节。 */
export const SIGN_NONCE_BYTES = 16
export const SIGN_POW_NONCE_BYTES = 12
/** 门闩缓存 TTL 与超时(官方 1h / 15s)。 */
export const SIGNATURE_GATE_TTL_MS = 3600_000
export const SIGNATURE_GATE_TIMEOUT_MS = 15_000
/** 握手超时(官方 10s)。 */
export const SIGN_HANDSHAKE_TIMEOUT_MS = 10_000
/** anthropic 系请求带的 beta 头(官方抓包实测值)。 */
export const ANTHROPIC_BETA_MID_CONVERSATION_SYSTEM = 'mid-conversation-system-2026-04-07'
/** 官方引擎在 UA 尾部追加的 ai-sdk 标识(抓包实测值)。 */
export const AI_SDK_USER_AGENT_SUFFIX = 'ai-sdk/provider-utils/4.0.27 runtime/node.js/24'

/** 需要客户端签名的主机根域(官方 `QYe`/`_Es` 表)。 */
const SIGNING_ROOT_DOMAINS = ['z.ai', 'bigmodel.cn', 'chatglm.site']
const SIGNING_HOSTS = new Set(['api.chatglm.site', 'zcode.chatglm.site'])

/** 每个请求都要带的官方源码头所需的输入。 */
export interface WireProfile {
  /** `X-ZCode-App-Version` / `User-Agent` 里的版本。 */
  appVersion: string
  /** `X-Title` 的 `@` 后半段:桌面为 `electron`,独立 CLI 为 `cli`。 */
  sourceTitle: string
  /** `X-Release-Channel`;官方生产构建为 `production`。 */
  releaseChannel: string
  /** `HTTP-Referer` 与签名门闩的 origin。 */
  endpointOrigin: string
  /** `X-Platform`,形如 `win32-x64`(node 的 platform-arch,不是 `windows-x64`)。 */
  platform: string
  /** `X-Os-Version`,node 的 `os.release()`。 */
  osVersion: string
  clientLanguage: string
  clientTimezone: string
  /** 设备标识;只进 `metadata.user_id`,不作为请求头(与官方抓包一致)。 */
  deviceMid?: string
}

/** 只保留可打印 ASCII,与官方 `WL` 同语义。 */
function printable(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) return undefined
  return trimmed
}

/** 官方 `nzi`:node platform → 归因用的 OS 类别;入参是 `X-Platform`(platform-arch)。 */
function osCategory(platform: string): string {
  switch (platform.split('-')[0]) {
    case 'darwin': return 'macos'
    case 'win32': return 'windows'
    default: return 'linux'
  }
}

/**
 * 构造官方源码头集合(逐字段对齐官方 `buildZCodeSourceHeadersFromContext`)。
 * @param profile - 版本、平台、时区等运行时事实。
 * @returns 直接合并进请求的头集合。
 */
export function buildSourceHeaders(profile: WireProfile): Record<string, string> {
  const version = printable(profile.appVersion) ?? 'unknown'
  const title = printable(profile.sourceTitle) ?? 'electron'
  const origin = printable(profile.endpointOrigin) ?? ZCODE_ENDPOINT_ORIGIN
  const platform = printable(profile.platform)
  const release = printable(profile.releaseChannel)
  const osVersion = printable(profile.osVersion)
  const headers: Record<string, string> = {
    'HTTP-Referer': origin,
    'User-Agent': `ZCode/${version}`,
    ...(printable(profile.appVersion) ? { 'X-ZCode-App-Version': version } : {}),
    'X-Title': `Z Code@${title}`,
    'X-Client-Language': printable(profile.clientLanguage) ?? 'unknown',
    'X-Client-Timezone': printable(profile.clientTimezone) ?? 'unknown',
    'X-ZCode-Agent': 'glm',
  }
  if (platform) headers['X-Platform'] = platform
  if (release) headers['X-Release-Channel'] = release
  if (platform) headers['X-Os-Category'] = osCategory(platform)
  if (osVersion) headers['X-Os-Version'] = osVersion
  return headers
}

/** 从可选的设备状态文件读取 `deviceMid`。 */
export function readDeviceMid(telemetryStatePath: string): string | undefined {
  try {
    const doc = JSON.parse(readFileSync(telemetryStatePath, 'utf8')) as { deviceMid?: unknown }
    const value = typeof doc.deviceMid === 'string' ? doc.deviceMid.trim() : ''
    return value && /^[\x20-\x7e]+$/.test(value) ? value : undefined
  } catch (_missingOrInvalid) {
    return undefined
  }
}

/**
 * 该 provider 的模型请求是否需要客户端签名(官方 `requiresClientRequestSigning`)。
 * 规则:start-plan / off-peak 不需要;individual/team coding plan 与官方 zcode 主机需要。
 * @param baseURL - provider 的 API 根地址。
 * @param access - provider 的 access 声明(可缺省)。
 * @returns 需要签名时为 true。
 */
export function requiresClientSigning(baseURL: string, access?: { type?: string; mode?: string }): boolean {
  const mode = access?.mode
  if (access?.type === 'zhipu-account' && (mode === 'start-plan' || mode === 'off-peak')) return false
  if (access?.type === 'zhipu-coding-plan-api-key') return true
  if (access?.type === 'zhipu-account' && (mode === 'individual-coding-plan' || mode === 'team-coding-plan')) return true
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    if (SIGNING_HOSTS.has(host)) return true
    return SIGNING_ROOT_DOMAINS.some((root) => host === root || host.endsWith(`.${root}`))
  } catch (_invalidUrl) {
    return false
  }
}

/** 官方 `parseClientSigningCredential`:凭证必须是 `<apiKeyId>.<apiKeySecret>`,只允许一个分隔点。 */
export function parseSigningCredential(apiKey: string): { apiKeyId: string; apiKeySecret: string } | undefined {
  const dot = apiKey.indexOf('.')
  if (dot <= 0 || dot !== apiKey.lastIndexOf('.') || !apiKey.slice(0, dot).trim() || !apiKey.slice(dot + 1).trim()) return undefined
  return { apiKeyId: apiKey.slice(0, dot), apiKeySecret: apiKey.slice(dot + 1) }
}

/** 用 HKDF-SHA256 从 secret 派生 32 字节材料(官方 `Kcr`)。 */
function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(SIGN_KDF_SALT, 'utf8'), Buffer.from(info, 'utf8'), 32))
}

/** 握手签名:HMAC-SHA256(HKDF(secret, "getSignKey_hmac"), "get_sign_key\n<id>\n<ts>\n<nonce>") 的 base64(官方 `Vcr`,分隔符是换行)。 */
function handshakeSignature(apiKeyId: string, apiKeySecret: string, ts: string, nonce: string): string {
  return createHmac('sha256', deriveKey(apiKeySecret, SIGN_KEY_INFO))
    .update(`${SIGN_MESSAGE_PREFIX}\n${apiKeyId}\n${ts}\n${nonce}`)
    .digest('base64')
}

/**
 * 解出 Ed25519 私钥(官方 `Hcr`):
 * `privateCipher = iv(12) || AES-256-GCM(plaintext)`,AAD = apiKeyId;
 * 明文是一段 base64 文本,再解一次才是 PKCS8 DER。
 */
function decryptSigningPrivateKey(apiKeyId: string, apiKeySecret: string, privateCipher: string) {
  const buf = Buffer.from(privateCipher, 'base64')
  if (buf.byteLength <= 12 + 16) throw new Error('privateCipher is too short')
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(apiKeySecret, SIGN_PRIVATE_KEY_INFO), buf.subarray(0, 12))
  decipher.setAAD(Buffer.from(apiKeyId, 'utf8'))
  decipher.setAuthTag(buf.subarray(buf.byteLength - 16))
  const plaintext = Buffer.concat([decipher.update(buf.subarray(12, buf.byteLength - 16)), decipher.final()]).toString('utf8')
  const pkcs8 = Buffer.from(plaintext, 'base64')
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
}

/** 前导零比特判定(官方 `I5i`)。 */
function hasLeadingZeroBits(hash: Buffer, bits: number): boolean {
  const whole = Math.floor(bits / 8)
  for (let i = 0; i < whole; i += 1) if (hash[i] !== 0) return false
  const rest = bits % 8
  if (rest === 0) return true
  const mask = (255 << (8 - rest)) & 255
  return ((hash[whole] ?? 255) & mask) === 0
}

/** 客户端请求 PoW(官方 `Jcr`):nonce 12 字节 hex + 计数,sha256 前导零比特达标即返回;消息用换行分隔。 */
export function solveProofOfWork(apiKeyId: string, sessionId: string, ts: string, powBits = SIGN_POW_BITS): string {
  const seed = createHash('sha256')
    .update(`${apiKeyId}\n${SIGN_APP_ID}\n${sessionId}\n${ts}`)
    .digest('hex')
    .slice(0, 32)
  const nonce = randomBytes(SIGN_POW_NONCE_BYTES).toString('hex')
  for (let i = 0; i <= 0xffffffff; i += 1) {
    const candidate = `${nonce}${i.toString(16).padStart(8, '0')}`
    const digest = createHash('sha256').update(`${seed}\n${candidate}`).digest()
    if (hasLeadingZeroBits(digest, powBits)) return candidate
  }
  throw new Error('Unable to solve client request proof of work')
}

/** 签名门闩与握手的可注入依赖(测试用)。 */
export interface SignerDeps {
  /** 发送门闩/握手请求;默认用全局 fetch。 */
  fetch?: typeof fetch
  /** 现在(ms)。 */
  now?: () => number
  /** 日志出口。 */
  log?: (message: string) => void
}

/** 网关拒绝签名时的可刷新原因码(官方 `eJt`/`b5i`/`S5i`)。 */
export const SIGNATURE_REJECTION_REASONS = ['VERIFY_SIGNATURE_INVALID', 'VERIFY_APIKEY_EXPIRED'] as const

/**
 * 判定 401 响应体是否为可刷新的签名拒绝(官方只在 401 且 reason 命中时才重试/旁路)。
 * @param status - HTTP 状态码。
 * @param body - 已读出的响应文本。
 * @returns 命中时为对应原因码,否则 undefined。
 */
export function refreshableSignatureRejection(status: number, body: string): string | undefined {
  if (status !== 401) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch (_nonJson) { return undefined }
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const root = record(parsed)
  if (!root) return undefined
  const candidates = [
    root.msg, root.reason,
    record(root.data)?.reason,
    record(root.error)?.reason,
    record(root.error)?.message,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && (SIGNATURE_REJECTION_REASONS as readonly string[]).includes(candidate)) return candidate
  }
  return undefined
}

/** 构造一个签名的请求头集合所需的输入。 */
export interface SignRequestInput {
  /** provider 凭证(`<id>.<secret>` 形态)。 */
  apiKey: string
  /** provider 的 API 根地址;握手 origin 取它的 origin。 */
  baseURL: string
  /** `X-Client-Version`。 */
  clientVersion: string
  /** `X-Session-Id`;官方用会话 id,去掉 `sess_`/`subagent_agent_` 前缀。 */
  sessionId: string
  /** 门闩与源码头用的 profile。 */
  profile: WireProfile
  /** 中止信号。 */
  signal?: AbortSignal
}

/** 官方式客户端签名:门闩 → 握手 → Ed25519(官方 `ClientRequestSigningV4Signer`)。 */
export class ClientRequestSigner {
  readonly #deps: SignerDeps
  #gateSnapshot?: { enabled: boolean; expiresAt: number }
  #gateRequest?: Promise<boolean>
  #privateKey?: ReturnType<typeof createPrivateKey>
  #bypass = false

  /**
   * @param deps - 可注入的 fetch/时钟/日志。
   */
  constructor(deps: SignerDeps = {}) {
    this.#deps = deps
  }

  /** 门闩查询结果(供诊断)。 */
  get bypassing(): boolean { return this.#bypass }

  /** 丢弃已缓存的私钥,强制下次签名重新握手(官方 `invalidatePrivateKey`)。 */
  invalidatePrivateKey(): void { this.#privateKey = undefined }

  /** 连续两次被拒绝后进入旁路:本签名器实例后续一律发未签名请求(官方 `bypass_entering`)。 */
  enterBypass(): void { this.#bypass = true }

  /**
   * 服务端是否开启了客户端签名(官方 `CodingPlanSignatureFeatureGate`)。
   * @param apiKey - provider 凭证;作为门闩请求的 `x-api-key`。
   * @param profile - 用于构造源码头。
   * @param signal - 中止信号。
   * @returns 门闩为 `data.codingPlanSignature.enable === true` 时返回 true。
   */
  async isEnabled(apiKey: string, profile: WireProfile, signal?: AbortSignal): Promise<boolean> {
    const now = this.#deps.now?.() ?? Date.now()
    if (this.#gateSnapshot && this.#gateSnapshot.expiresAt > now) return this.#gateSnapshot.enabled
    if (!this.#gateRequest) {
      const pending = this.#fetchGate(apiKey, profile, signal).then((result) => {
        if (result.cacheable) this.#gateSnapshot = { enabled: result.enabled, expiresAt: (this.#deps.now?.() ?? Date.now()) + SIGNATURE_GATE_TTL_MS }
        return result.enabled
      })
      this.#gateRequest = pending
      void pending.catch(() => undefined).finally(() => { if (this.#gateRequest === pending) this.#gateRequest = undefined })
    }
    return await this.#gateRequest
  }

  async #fetchGate(apiKey: string, profile: WireProfile, signal?: AbortSignal): Promise<{ cacheable: boolean; enabled: boolean }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SIGNATURE_GATE_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const doFetch = this.#deps.fetch ?? fetch
      const url = new URL(SIGNATURE_GATE_PATH, printable(profile.endpointOrigin) ?? ZCODE_ENDPOINT_ORIGIN).toString()
      const response = await doFetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { ...buildSourceHeaders(profile), 'x-api-key': apiKey },
      })
      if (!response.ok) return { cacheable: false, enabled: false }
      const body = (await response.json().catch(() => undefined)) as { code?: number; data?: { codingPlanSignature?: { enable?: boolean } } } | undefined
      if (!body || body.code !== 0) return { cacheable: false, enabled: false }
      return { cacheable: true, enabled: body.data?.codingPlanSignature?.enable === true }
    } catch (error) {
      this.#deps.log?.(`zcode-provider: 签名门闩查询失败(${String(error)}),本次按未签名发送`)
      return { cacheable: false, enabled: false }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async #ensurePrivateKey(input: SignRequestInput): Promise<ReturnType<typeof createPrivateKey>> {
    if (this.#privateKey) return this.#privateKey
    const credential = parseSigningCredential(input.apiKey)
    if (!credential) throw new Error('凭证不是 <apiKeyId>.<secret> 形态,无法签名')
    const handshakeUrl = new URL(SIGN_HANDSHAKE_PATH, new URL(input.baseURL).origin).toString()
    const ts = String(this.#deps.now?.() ?? Date.now())
    const nonce = randomBytes(SIGN_NONCE_BYTES).toString('hex')
    const sig = handshakeSignature(credential.apiKeyId, credential.apiKeySecret, ts, nonce)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SIGN_HANDSHAKE_TIMEOUT_MS)
    try {
      const doFetch = this.#deps.fetch ?? fetch
      const response = await doFetch(handshakeUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { Authorization: input.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: input.apiKey, nonce, sig, ts }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`握手 HTTP ${response.status}`)
      const envelope = (await response.json()) as { code?: number; msg?: string; data?: { privateCipher?: string } }
      if (envelope.code !== 200) throw new Error(`握手被拒绝 code=${String(envelope.code)} msg=${String(envelope.msg)}`)
      const cipher = envelope.data?.privateCipher
      if (typeof cipher !== 'string' || !cipher) throw new Error('握手响应缺少 privateCipher')
      const key = decryptSigningPrivateKey(credential.apiKeyId, credential.apiKeySecret, cipher)
      this.#privateKey = key
      return key
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 按官方语义给请求补充签名头;签名不可用时返回未修改的头(官方 fail-open)。
   * @param headers - 已构造好的请求头(会被复制)。
   * @param input - 凭证、地址、会话与 profile。
   * @returns 追加签名头后的新头集合。
   */
  async signHeaders(headers: Record<string, string>, input: SignRequestInput): Promise<Record<string, string>> {
    const out: Record<string, string> = { ...headers }
    if (this.#bypass) return out
    let enabled: boolean
    try {
      enabled = await this.isEnabled(input.apiKey, input.profile, input.signal)
    } catch (_gateFailure) {
      return out
    }
    if (!enabled) return out
    const credential = parseSigningCredential(input.apiKey)
    if (!credential) return out
    let privateKey: ReturnType<typeof createPrivateKey>
    try {
      privateKey = await this.#ensurePrivateKey(input)
    } catch (error) {
      this.#deps.log?.(`zcode-provider: 客户端签名握手失败(${String(error)}),本次按未签名发送`)
      return out
    }
    const ts = String(this.#deps.now?.() ?? Date.now())
    const nonce = randomBytes(SIGN_NONCE_BYTES).toString('hex')
    // 业务签名消息同样用换行分隔(官方 `Gcr` 模板 `${apiKeyId}\n${ts}\n${version}\n${sessionId}\n${nonce}`)
    const signature = ed25519Sign(null, Buffer.from(`${credential.apiKeyId}\n${ts}\n${input.clientVersion}\n${input.sessionId}\n${nonce}`, 'utf8'), privateKey).toString('base64')
    const pow = solveProofOfWork(credential.apiKeyId, input.sessionId, ts)
    out['X-Client-Ts'] = ts
    out['X-Client-Version'] = input.clientVersion
    out['X-Client-Sig'] = signature
    out['X-Session-Id'] = input.sessionId
    out['X-Client-Nonce'] = nonce
    out['X-App-Id'] = SIGN_APP_ID
    out['X-Client-Pow'] = pow
    return out
  }
}
