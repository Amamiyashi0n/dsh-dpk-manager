/**
 * Host-side bridge for rendering Aliyun Captcha inside an already connected
 * DSH Web UI.  The browser polls for a challenge, receives only its public
 * SDK configuration, and returns one verification param to the request that
 * created it.  Credentials and model request data never cross this boundary.
 */

import { randomUUID } from 'node:crypto'

import type { CaptchaConfig, CaptchaSolveResult } from './captcha.js'

/** The Remote namespace mounted by the Web UI client. */
export const CAPTCHA_REMOTE_NAMESPACE = 'zcodeCaptcha'
/** Explicit alias for call sites that use the provider prefix. */
export const ZCODE_CAPTCHA_REMOTE_NAMESPACE = CAPTCHA_REMOTE_NAMESPACE

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_AVAILABILITY_WAIT_MS = 5_000
const MAX_TIMEOUT_MS = 10 * 60_000
// Idle browsers must not keep an HTTP request open. DSH pages already own a
// live event transport, and a unary long-poll can head-of-line block ordinary
// Remote calls in Chromium. The Web client uses this bounded retry cadence.
const CLAIM_RETRY_AFTER_MS = 2_000

export interface CaptchaChallengeConfig {
  region: string
  prefix: string
  sceneId: string
}

export interface WebCaptchaBrokerOptions {
  /** End-to-end lifetime of an issued challenge. */
  timeoutMs?: number
  /** How long a model request waits for a Web UI to claim its challenge. */
  availabilityWaitMs?: number
  /** Injectable clock for deterministic expiration checks. */
  now?: () => number
}

export interface CaptchaClaimRequest {
  /** Per-tab, runtime-only Web UI identifier. */
  clientId: string
  /** Optional bounded compatibility wait; the Web UI passes zero and polls. */
  waitMs?: number
}

export interface CaptchaChallenge {
  id: string
  config: CaptchaChallengeConfig
  expiresAt: number
}

export type CaptchaClaimResponse =
  | { state: 'challenge'; challenge: CaptchaChallenge }
  | { state: 'empty'; retryAfterMs?: number }

/** States accepted from the browser's Aliyun SDK callbacks. */
export type CaptchaCompletionState = 'success' | 'fail' | 'error' | 'timeout'

export interface CaptchaCompletionResult {
  state: CaptchaCompletionState
  param?: string
  verifyCode?: string
  reason?: string
}

export interface CaptchaCompleteRequest {
  id: string
  clientId: string
  result: CaptchaCompletionResult
}

export interface CaptchaCompleteResponse {
  accepted: boolean
  /** Present only when the Host has conclusively rejected a completion. */
  status?: 'expired' | 'rejected' | 'unavailable'
}

/** Release challenge ownership for a departing Web UI. */
export interface CaptchaReleaseRequest {
  /** Per-tab, runtime-only Web UI identifier. */
  clientId: string
  /** Restrict release to this owned challenge; omitted releases all work for the client. */
  id?: string
}

export interface CaptchaReleaseResponse {
  released: boolean
}

interface RemoteContext {
  provide(name: string, value: unknown): unknown
}

interface PendingChallenge {
  id: string
  config: CaptchaChallengeConfig
  createdAt: number
  expiresAt: number
  ownerClientId?: string
  settled: boolean
  resolve: (result: CaptchaSolveResult) => void
  timeoutTimer?: ReturnType<typeof setTimeout>
  availabilityTimer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abortListener?: () => void
}

function boundedDuration(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(0, Math.floor(value)))
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized === '' ? undefined : normalized
}

function normalizeConfig(config: CaptchaConfig | CaptchaChallengeConfig | undefined): CaptchaChallengeConfig | undefined {
  const region = asNonEmptyString(config?.region)
  const prefix = asNonEmptyString(config?.prefix)
  const sceneId = asNonEmptyString(config?.sceneId)
  if (region === undefined || prefix === undefined || sceneId === undefined) return undefined
  return { region, prefix, sceneId }
}

function normalizeCompletion(result: CaptchaCompletionResult | undefined): CaptchaCompletionResult | undefined {
  if (result === undefined || result === null || typeof result !== 'object') return undefined
  if (result.state !== 'success' && result.state !== 'fail' && result.state !== 'error' && result.state !== 'timeout') {
    return undefined
  }
  const param = result.state === 'success' ? asNonEmptyString(result.param) : undefined
  if (result.state === 'success' && param === undefined) return undefined
  const verifyCode = asNonEmptyString(result.verifyCode)
  const reason = asNonEmptyString(result.reason)
  return {
    state: result.state,
    ...(param === undefined ? {} : { param }),
    ...(verifyCode === undefined ? {} : { verifyCode }),
    ...(reason === undefined ? {} : { reason }),
  }
}

function markRemote(prototype: object, methodName: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value as
    | { methods?: readonly unknown[] }
    | undefined
  const marker = Object.freeze({ method: methodName, invocation: Object.freeze({ kind: 'direct' }) })
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([...(descriptor?.methods ?? []), marker]),
    }),
  })
}

/**
 * In-memory, one-time captcha challenge broker.
 *
 * A challenge belongs to the first Web UI client that claims it.  The broker
 * never reveals a challenge to a second client and accepts exactly one valid
 * completion from its owner.
 */
export class WebCaptchaBroker {
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly availabilityWaitMs: number
  private readonly challenges = new Map<string, PendingChallenge>()
  private disposed = false

  constructor(options: WebCaptchaBrokerOptions = {}) {
    this.now = options.now ?? Date.now
    this.timeoutMs = boundedDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    this.availabilityWaitMs = boundedDuration(
      options.availabilityWaitMs,
      DEFAULT_AVAILABILITY_WAIT_MS,
      this.timeoutMs,
    )
  }

  /**
   * Wait for an existing DSH Web UI to claim and solve one captcha challenge.
   * This result is structurally compatible with captcha.ts's solver port.
   */
  async request(config: CaptchaConfig | CaptchaChallengeConfig, signal?: AbortSignal): Promise<CaptchaSolveResult> {
    const createdAt = this.now()
    const normalizedConfig = normalizeConfig(config)
    if (this.disposed) return this.result(createdAt, 'unavailable', '', '验证码 Web UI 服务已关闭')
    if (normalizedConfig === undefined) return this.result(createdAt, 'error', '', '验证码配置不完整')
    if (signal?.aborted === true) return this.result(createdAt, 'unavailable', '', '验证码请求已取消')

    const expiresAt = createdAt + this.timeoutMs
    return await new Promise<CaptchaSolveResult>((resolve) => {
      const challenge: PendingChallenge = {
        id: randomUUID(),
        config: normalizedConfig,
        createdAt,
        expiresAt,
        settled: false,
        resolve,
      }
      this.challenges.set(challenge.id, challenge)

      challenge.timeoutTimer = setTimeout(() => {
        this.finish(challenge, this.result(challenge.createdAt, 'timeout', '', '验证码求解超时'))
      }, this.timeoutMs)
      if (!this.hasActiveClient()) this.armAvailabilityTimer(challenge)

      if (signal !== undefined) {
        challenge.signal = signal
        challenge.abortListener = () => {
          this.finish(challenge, this.result(challenge.createdAt, 'unavailable', '', '验证码请求已取消'))
        }
        signal.addEventListener('abort', challenge.abortListener, { once: true })
        if (signal.aborted) challenge.abortListener()
      }

    })
  }

  /**
   * Return one unclaimed challenge immediately. Idle callers get a bounded
   * retry hint rather than holding an HTTP connection open. A client can own
   * at most one challenge at a time, matching the single visible SDK overlay.
   */
  async claim(request: CaptchaClaimRequest, signal?: AbortSignal): Promise<CaptchaClaimResponse> {
    this.expireChallenges()
    if (this.disposed) return { state: 'empty' }
    if (signal?.aborted === true) return { state: 'empty', retryAfterMs: CLAIM_RETRY_AFTER_MS }

    const clientId = asNonEmptyString(request?.clientId)
    if (clientId === undefined || this.clientOwnsChallenge(clientId)) return { state: 'empty' }

    const immediate = this.claimNext(clientId)
    if (immediate !== undefined) return immediate
    const waitMs = boundedDuration(request?.waitMs, 0, DEFAULT_AVAILABILITY_WAIT_MS)
    const deadline = this.now() + waitMs
    while (waitMs > 0 && this.now() < deadline) {
      const delay = Math.min(50, Math.max(0, deadline - this.now()))
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>
        const cleanup = (): void => { signal?.removeEventListener('abort', abort) }
        timer = setTimeout(() => { cleanup(); resolve() }, delay)
        const abort = (): void => {
          clearTimeout(timer)
          cleanup()
          resolve()
        }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted === true) abort()
      })
      if (this.disposed) return { state: 'empty' }
      if (signal?.aborted) return { state: 'empty', retryAfterMs: CLAIM_RETRY_AFTER_MS }
      this.expireChallenges()
      const claimed = this.claimNext(clientId)
      if (claimed !== undefined) return claimed
    }
    return { state: 'empty', retryAfterMs: CLAIM_RETRY_AFTER_MS }
  }

  /** Accept a single completion from the Web UI client that claimed it. */
  complete(request: CaptchaCompleteRequest): CaptchaCompleteResponse {
    this.expireChallenges()
    if (this.disposed) return { accepted: false, status: 'unavailable' }

    const id = asNonEmptyString(request?.id)
    const clientId = asNonEmptyString(request?.clientId)
    if (id === undefined || clientId === undefined) return { accepted: false, status: 'rejected' }

    const challenge = this.challenges.get(id)
    if (challenge === undefined || challenge.settled) return { accepted: false, status: 'expired' }
    if (challenge.ownerClientId !== clientId) return { accepted: false, status: 'rejected' }

    const completion = normalizeCompletion(request?.result)
    if (completion === undefined) return { accepted: false, status: 'rejected' }

    const result = this.result(
      challenge.createdAt,
      completion.state,
      completion.param ?? '',
      completion.reason,
      completion.verifyCode,
    )
    return { accepted: this.finish(challenge, result) }
  }

  /**
   * Release browser-owned work when a Web UI overlay unmounts. Released
   * challenges remain valid and can be claimed by a
   * replacement Web UI; they are not exposed to another client until this
   * owner explicitly leaves.
   */
  release(request: CaptchaReleaseRequest): CaptchaReleaseResponse {
    this.expireChallenges()
    if (this.disposed) return { released: false }

    const clientId = asNonEmptyString(request?.clientId)
    if (clientId === undefined) return { released: false }
    const id = request?.id === undefined ? undefined : asNonEmptyString(request.id)
    if (request?.id !== undefined && id === undefined) return { released: false }

    let released = false
    for (const challenge of this.challenges.values()) {
      if (challenge.settled || challenge.ownerClientId !== clientId) continue
      if (id !== undefined && challenge.id !== id) continue
      challenge.ownerClientId = undefined
      released = true
    }
    if (!released) return { released: false }

    this.resumeAvailabilityTimers()
    return { released: true }
  }

  /** Resolve outstanding model and browser calls when the plugin unloads. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const challenge of [...this.challenges.values()]) {
      this.finish(challenge, this.result(challenge.createdAt, 'unavailable', '', '验证码 Web UI 服务已关闭'))
    }
  }

  private result(
    createdAt: number,
    state: CaptchaSolveResult['state'],
    param: string,
    reason?: string,
    verifyCode?: string,
  ): CaptchaSolveResult {
    return {
      param,
      state,
      ...(verifyCode === undefined ? {} : { verifyCode }),
      ...(reason === undefined ? {} : { reason }),
      ms: Math.max(0, this.now() - createdAt),
    }
  }

  private expireChallenges(): void {
    const now = this.now()
    for (const challenge of [...this.challenges.values()]) {
      if (challenge.expiresAt <= now) {
        this.finish(challenge, this.result(challenge.createdAt, 'timeout', '', '验证码求解超时'))
      }
    }
  }

  private clientOwnsChallenge(clientId: string): boolean {
    for (const challenge of this.challenges.values()) {
      if (!challenge.settled && challenge.ownerClientId === clientId) return true
    }
    return false
  }

  /** A claimed challenge proves that one Web UI is present and may drain the queue serially. */
  private hasActiveClient(): boolean {
    for (const challenge of this.challenges.values()) {
      if (!challenge.settled && challenge.ownerClientId !== undefined) return true
    }
    return false
  }

  /** Start the short no-Web-UI deadline only while no client is already busy. */
  private armAvailabilityTimer(challenge: PendingChallenge): void {
    if (challenge.settled || challenge.ownerClientId !== undefined || this.disposed) return
    if (challenge.availabilityTimer !== undefined) clearTimeout(challenge.availabilityTimer)
    const remaining = Math.max(0, challenge.expiresAt - this.now())
    const delay = Math.min(this.availabilityWaitMs, remaining)
    challenge.availabilityTimer = setTimeout(() => {
      challenge.availabilityTimer = undefined
      if (challenge.ownerClientId === undefined) {
        this.finish(challenge, this.result(challenge.createdAt, 'unavailable', '', '没有已连接的 DSH Web UI 可承载验证码'))
      }
    }, delay)
  }

  /** A connected client processes one visible SDK overlay at a time, so pause queued deadlines. */
  private pauseAvailabilityTimers(): void {
    for (const challenge of this.challenges.values()) {
      if (challenge.settled || challenge.ownerClientId !== undefined || challenge.availabilityTimer === undefined) continue
      clearTimeout(challenge.availabilityTimer)
      challenge.availabilityTimer = undefined
    }
  }

  /** Once every client has released/completed, pending work again gets the short availability bound. */
  private resumeAvailabilityTimers(): void {
    if (this.disposed || this.hasActiveClient()) return
    for (const challenge of this.challenges.values()) this.armAvailabilityTimer(challenge)
  }

  private claimNext(clientId: string): CaptchaClaimResponse | undefined {
    for (const challenge of this.challenges.values()) {
      if (challenge.settled || challenge.ownerClientId !== undefined) continue
      challenge.ownerClientId = clientId
      if (challenge.availabilityTimer !== undefined) clearTimeout(challenge.availabilityTimer)
      challenge.availabilityTimer = undefined
      this.pauseAvailabilityTimers()
      return {
        state: 'challenge',
        challenge: {
          id: challenge.id,
          config: { ...challenge.config },
          expiresAt: challenge.expiresAt,
        },
      }
    }
    return undefined
  }

  private finish(challenge: PendingChallenge, result: CaptchaSolveResult): boolean {
    if (challenge.settled || this.challenges.get(challenge.id) !== challenge) return false
    challenge.settled = true
    this.challenges.delete(challenge.id)
    if (challenge.timeoutTimer !== undefined) clearTimeout(challenge.timeoutTimer)
    if (challenge.availabilityTimer !== undefined) clearTimeout(challenge.availabilityTimer)
    if (challenge.signal !== undefined && challenge.abortListener !== undefined) {
      challenge.signal.removeEventListener('abort', challenge.abortListener)
    }
    challenge.resolve(result)
    this.resumeAvailabilityTimers()
    return true
  }
}

export interface CaptchaRemoteService {
  claim(request: CaptchaClaimRequest, signal?: AbortSignal): Promise<CaptchaClaimResponse>
  complete(request: CaptchaCompleteRequest): CaptchaCompleteResponse
  release(request: CaptchaReleaseRequest): CaptchaReleaseResponse
  typertRemote: unknown
}

/** Register the browser-facing Typert service around an existing broker. */
export function createCaptchaRemoteService(
  ctx: RemoteContext,
  broker: WebCaptchaBroker,
): CaptchaRemoteService {
  class ZcodeCaptchaRemoteService implements CaptchaRemoteService {
    typertRemote: unknown

    constructor() {
      this.typertRemote = undefined
    }

    async claim(request: CaptchaClaimRequest, signal?: AbortSignal): Promise<CaptchaClaimResponse> {
      return await broker.claim(request, signal)
    }

    complete(request: CaptchaCompleteRequest): CaptchaCompleteResponse {
      return broker.complete(request)
    }

    release(request: CaptchaReleaseRequest): CaptchaReleaseResponse {
      return broker.release(request)
    }
  }

  markRemote(ZcodeCaptchaRemoteService.prototype, 'claim')
  markRemote(ZcodeCaptchaRemoteService.prototype, 'complete')
  markRemote(ZcodeCaptchaRemoteService.prototype, 'release')
  const service = new ZcodeCaptchaRemoteService()
  service.typertRemote = Object.freeze({
    service,
    serviceKey: CAPTCHA_REMOTE_NAMESPACE,
    namespace: CAPTCHA_REMOTE_NAMESPACE,
  })
  ctx.provide(CAPTCHA_REMOTE_NAMESPACE, service)
  return service
}
