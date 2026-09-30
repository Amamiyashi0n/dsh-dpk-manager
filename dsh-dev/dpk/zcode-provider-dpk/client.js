/**
 * Browser half of zcode-provider: the entitlement panel plus the Web UI
 * surface for an on-demand Aliyun captcha challenge. Credentials stay on the
 * Host; the browser receives normalized snapshots and one-time challenge
 * configuration only.
 */

window.__ModuleLoader__.load({
  id: 'zcode-provider',
  factory(require) {
    const React = require('react')
    const {
      IconCheckCircleOutlineRegular,
      IconGaugeOutlineRegular,
      IconRefreshOutlineRegular,
      IconWarningOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'zcode-entitlements'
    const CAPTCHA_REMOTE_NAMESPACE = 'zcodeCaptcha'
    const PROMPT_REMOTE_NAMESPACE = 'zcodePrompts'
    const AUTH_BACKEND_REMOTE_NAMESPACE = 'zcodeAuthBackend'
    const PROMPT_LAYERS = /* DSH_PROMPT_LAYERS */ [
  {
    "id": "identity",
    "title": "身份提示词"
  },
  {
    "id": "agent",
    "title": "Agent 主提示词"
  },
  {
    "id": "runtime",
    "title": "运行时提示词模板"
  }
]
    const PROMPT_PLACEMENTS = [
      { id: 'before', title: '前置' },
      { id: 'after', title: '后置' },
    ]

    const zh = {
      panel: 'ZCode 权益',
      pageTitle: 'ZCode 权益与用量',
      refresh: '刷新',
      loading: '正在读取权益…',
      loadTimeout: '权益读取超时，请检查网络后重试',
      failed: '读取失败',
      lastUpdated: '更新时间',
      range7: '7 天',
      range30: '30 天',
      codingPlan: 'Coding Plan',
      noSubscription: '未查到生效中的订阅',
      billingCycle: '计费周期',
      renewal: '续费时间',
      expiry: '到期时间',
      quotas: '额度窗口',
      noQuotas: '当前没有额度窗口',
      used: '已用',
      remaining: '剩余',
      reset: '重置',
      usage: '模型用量',
      usageLoading: '正在读取模型用量…',
      usageFailed: '模型用量读取失败',
      usageTimeout: '模型用量读取超时，请检查网络后重试',
      tokens: 'Token',
      calls: '调用次数',
      activeDays: '活跃天数',
      noUsage: '暂未取得模型用量',
      model: '模型',
      share: '占比',
      startPlan: 'Start Plan',
      noStartPlan: '无生效中的套餐',
      active: '生效中',
      validPeriod: '有效期',
      entitlements: '套餐权益',
      admission: '准入状态',
      admissionPassed: '已通过',
      admissionFailed: '未通过',
      plans: '套餐数',
      diagnostics: '部分数据未取得',
      available: '已开通',
      pending: '待生效',
      unavailable: '不可用',
      unknown: '状态未知',
      notAuthenticated: '需要登录',
      notConnected: '未连接当前账号',
      credentialFailed: '凭据校验失败',
      notEntitled: '未开通套餐',
      fiveHour: '5 小时额度',
      weekly: '每周额度',
      monthlyTool: '每月工具调用',
      serverMcp: 'ZCode Server MCP',
      openEntitlements: '查看 ZCode 权益',
      quotaUnknown: '额度未知',
      captchaTitle: '需要完成安全验证',
      captchaPreparing: '正在准备安全验证…',
      captchaReady: '请在下方完成安全验证',
      captchaVerifying: '正在验证…',
      captchaSubmitting: '正在提交验证结果…',
      captchaFailed: '验证结果尚未确认，请重试提交或重新完成安全验证',
      captchaExpired: '本次安全验证已过期',
      captchaRetry: '重试提交验证结果',
    }
    const en = {
      panel: 'ZCode Entitlements',
      pageTitle: 'ZCode Entitlements & Usage',
      refresh: 'Refresh',
      loading: 'Loading entitlements…',
      loadTimeout: 'Entitlement loading timed out. Check the network and retry.',
      failed: 'Failed to load',
      lastUpdated: 'Updated',
      range7: '7 days',
      range30: '30 days',
      codingPlan: 'Coding Plan',
      noSubscription: 'No active subscription found',
      billingCycle: 'Billing cycle',
      renewal: 'Renews',
      expiry: 'Expires',
      quotas: 'Quota windows',
      noQuotas: 'No quota windows available',
      used: 'Used',
      remaining: 'Remaining',
      reset: 'Resets',
      usage: 'Model usage',
      usageLoading: 'Loading model usage…',
      usageFailed: 'Model usage could not be loaded',
      usageTimeout: 'Model usage loading timed out. Check the network and retry.',
      tokens: 'Tokens',
      calls: 'Calls',
      activeDays: 'Active days',
      noUsage: 'Model usage is unavailable',
      model: 'Model',
      share: 'Share',
      startPlan: 'Start Plan',
      noStartPlan: 'No active plan',
      active: 'Active',
      validPeriod: 'Valid period',
      entitlements: 'Entitlements',
      admission: 'Admission',
      admissionPassed: 'Passed',
      admissionFailed: 'Failed',
      plans: 'Plans',
      diagnostics: 'Some data could not be loaded',
      available: 'Entitled',
      pending: 'Pending',
      unavailable: 'Unavailable',
      unknown: 'Unknown',
      notAuthenticated: 'Sign in required',
      notConnected: 'Account not connected',
      credentialFailed: 'Credential validation failed',
      notEntitled: 'Plan not entitled',
      fiveHour: '5-hour quota',
      weekly: 'Weekly quota',
      monthlyTool: 'Monthly tool calls',
      serverMcp: 'ZCode Server MCP',
      openEntitlements: 'View ZCode entitlements',
      quotaUnknown: 'Quota unavailable',
      captchaTitle: 'Security verification required',
      captchaPreparing: 'Preparing security verification…',
      captchaReady: 'Complete the security verification below',
      captchaVerifying: 'Verifying…',
      captchaSubmitting: 'Submitting verification result…',
      captchaFailed: 'Verification was not acknowledged. Retry submission or complete the verification again.',
      captchaExpired: 'This security verification has expired',
      captchaRetry: 'Retry verification submission',
    }

    const directDescriptor = (namespace, method, typeSymbol, cancellation = false) => ({
      id: `zcode-provider#${namespace}/${method}`,
      service: namespace,
      namespace,
      method,
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol,
          create: () => ({ parse: value => value }),
        },
      }],
      ...(cancellation ? { cancellation: { parameter: 'signal' } } : {}),
      result: { mode: 'src-json' },
    })
    const ENTITLEMENTS_REMOTE = {
      package: 'zcode-provider',
      descriptors: [
        directDescriptor('zcodeEntitlements', 'snapshot', 'zcode-provider#UsageSnapshotRequest', true),
        directDescriptor('zcodeEntitlements', 'usage', 'zcode-provider#UsageSnapshotRequest', true),
      ],
    }
    // These are ordinary request/response RPC calls. `claim` long-polls in
    // the Host, `complete` returns the browser result for one challenge, and
    // `release` returns a claim when this overlay disappears. Neither wire
    // carries any account credential.
    const CAPTCHA_REMOTE = {
      package: 'zcode-provider',
      descriptors: [
        {
          ...directDescriptor(CAPTCHA_REMOTE_NAMESPACE, 'claim', 'zcode-provider#CaptchaClaimRequest'),
          // DSH propagates this signal to the Host when this Web UI connection
          // or component lifecycle ends, so an old long-poll cannot claim a
          // later challenge after a refresh.
          cancellation: { parameter: 'signal' },
        },
        directDescriptor(CAPTCHA_REMOTE_NAMESPACE, 'complete', 'zcode-provider#CaptchaCompleteRequest'),
        directDescriptor(CAPTCHA_REMOTE_NAMESPACE, 'release', 'zcode-provider#CaptchaReleaseRequest'),
      ],
    }
    const PROMPT_REMOTE = {
      package: 'zcode-provider',
      descriptors: [
        {
          ...directDescriptor(PROMPT_REMOTE_NAMESPACE, 'snapshot', 'zcode-provider#PromptOverridesSnapshotRequest', true),
          parameters: [],
        },
        directDescriptor(PROMPT_REMOTE_NAMESPACE, 'mutate', 'zcode-provider#PromptOverridesMutationRequest', true),
      ],
    }
    const AUTH_BACKEND_REMOTE = {
      package: 'zcode-provider',
      descriptors: [
        {
          ...directDescriptor(AUTH_BACKEND_REMOTE_NAMESPACE, 'snapshot', 'zcode-provider#AuthBackendSnapshotRequest', true),
          parameters: [],
        },
        directDescriptor(AUTH_BACKEND_REMOTE_NAMESPACE, 'mutate', 'zcode-provider#AuthBackendMutationRequest', true),
      ],
    }
    const REMOTES = {
      package: 'zcode-provider',
      descriptors: [
        ...ENTITLEMENTS_REMOTE.descriptors,
        ...CAPTCHA_REMOTE.descriptors,
        ...PROMPT_REMOTE.descriptors,
        ...AUTH_BACKEND_REMOTE.descriptors,
      ],
    }

    const state = {
      range: '30d',
      snapshot: undefined,
      snapshotLoading: false,
      snapshotError: undefined,
      snapshotRequest: 0,
      usage: undefined,
      usageLoading: false,
      usageError: undefined,
      usageRequest: 0,
      listeners: new Set(),
    }
    const REMOTE_TIMEOUT_MS = 10_000
    const CAPTCHA_CLAIM_WAIT_MS = 0
    const CAPTCHA_CLAIM_TIMEOUT_MS = 5_000
    const CAPTCHA_COMPLETE_TIMEOUT_MS = 10_000
    const CAPTCHA_RELEASE_TIMEOUT_MS = 5_000
    const CAPTCHA_EMPTY_RETRY_MS = 750
    const CAPTCHA_MAX_RETRY_AFTER_MS = 30_000
    const ALIYUN_CAPTCHA_SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'

    // This is intentionally per loaded Web UI runtime. It identifies a caller
    // while the tab is alive, but is never written to browser persistence.
    const CAPTCHA_CLIENT_ID = (() => {
      const crypto = window.crypto
      const random = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      return `zcode-web-${random}`
    })()
    let captchaSdkPromise
    const captchaState = {
      active: undefined,
      listeners: new Set(),
    }
    const notify = () => { for (const listener of state.listeners) listener() }
    const notifyCaptcha = () => { for (const listener of captchaState.listeners) listener() }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const safeError = error => String(error?.message ?? error ?? 'unknown error')
    const captchaDomId = (kind, id) => `${kind}-${String(id).replace(/[^a-zA-Z0-9_-]/g, '-')}`
    const captchaConfig = challenge => {
      const config = challenge?.config
      const region = typeof config?.region === 'string' ? config.region.trim() : ''
      const prefix = typeof config?.prefix === 'string' ? config.prefix.trim() : ''
      const sceneId = typeof config?.sceneId === 'string' ? config.sceneId.trim() : ''
      if (region === '' || prefix === '' || sceneId === '') throw new Error('invalid captcha challenge configuration')
      return { region, prefix, sceneId }
    }
    const remoteValue = outcome => {
      if (outcome?.ok === false) throw outcome.error ?? new Error('Remote request failed')
      if (outcome?.ok !== true) throw new Error('invalid Remote result')
      return outcome.value
    }

    function loadAliyunCaptchaSdk() {
      if (typeof window.initAliyunCaptcha === 'function') return Promise.resolve()
      if (captchaSdkPromise !== undefined) return captchaSdkPromise
      captchaSdkPromise = new Promise((resolve, reject) => {
        if (typeof document === 'undefined') {
          reject(new Error('captcha requires a browser document'))
          return
        }
        const selector = 'script[data-zcode-aliyun-captcha-sdk="true"]'
        const existing = document.querySelector(selector)
        const reusable = existing?.dataset.zcodeAliyunCaptchaLoaded === 'true'
        // A separate Web UI runtime can encounter the script while it is still
        // loading. Keep that one, but replace an old unmarked node: it may be
        // the failed script from a prior attempt and will never emit again.
        const loading = existing?.dataset.zcodeAliyunCaptchaLoading === 'true'
        const script = reusable || loading ? existing : document.createElement('script')
        if (existing !== null && script !== existing) existing.remove()
        const failed = message => {
          script.remove()
          reject(new Error(message))
        }
        const loaded = () => {
          if (typeof window.initAliyunCaptcha === 'function') {
            script.dataset.zcodeAliyunCaptchaLoaded = 'true'
            delete script.dataset.zcodeAliyunCaptchaLoading
            resolve()
          }
          else failed('captcha SDK loaded without initAliyunCaptcha')
        }
        script.addEventListener('load', loaded, { once: true })
        script.addEventListener('error', () => failed('captcha SDK failed to load'), { once: true })
        if (script !== existing) {
          script.src = ALIYUN_CAPTCHA_SDK_URL
          script.async = true
          script.dataset.zcodeAliyunCaptchaSdk = 'true'
          script.dataset.zcodeAliyunCaptchaLoading = 'true'
          document.head.appendChild(script)
        } else if (reusable) {
          loaded()
        }
      }).catch((error) => {
        captchaSdkPromise = undefined
        throw error
      })
      return captchaSdkPromise
    }

    const buttonStyle = {
      width: 32,
      height: 32,
      display: 'inline-grid',
      placeItems: 'center',
      padding: 0,
      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    }
    const sectionStyle = {
      padding: '22px 0',
      borderTop: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
    }
    const sectionTitleStyle = { margin: '0 0 14px', fontSize: 16, fontWeight: 600 }
    const mutedStyle = { opacity: 0.68 }
    const valueStyle = { fontSize: 18, fontWeight: 600, overflowWrap: 'anywhere' }
    const metricLabelStyle = { fontSize: 12, opacity: 0.66, marginBottom: 4 }
    const promptEditorStyle = {
      width: '100%',
      minHeight: 180,
      boxSizing: 'border-box',
      padding: 10,
      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace',
      resize: 'vertical',
    }
    const panelCardStyle = {
      padding: 20,
      border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
      borderRadius: 12,
      background: 'color-mix(in srgb, currentColor 4%, transparent)',
      boxShadow: '0 10px 28px rgb(0 0 0 / 10%)',
    }
    const fieldCardStyle = {
      display: 'grid',
      gap: 9,
      padding: 14,
      border: '1px solid color-mix(in srgb, currentColor 13%, transparent)',
      borderRadius: 9,
      background: 'color-mix(in srgb, currentColor 3%, transparent)',
    }
    const selectStyle = {
      minHeight: 38,
      width: '100%',
      padding: '0 11px',
      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      borderRadius: 7,
      background: 'var(--dsh-color-bg, Canvas)',
      color: 'inherit',
      font: 'inherit',
    }

    const number = value => new Intl.NumberFormat().format(Number(value) || 0)
    const tokens = value => {
      const n = Number(value) || 0
      if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
      if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万`
      return number(n)
    }
    const date = value => {
      if (!value) return '—'
      const parsed = new Date(value)
      return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    }
    const epoch = value => value === undefined ? '—' : date(Number(value) * 1000)
    const percent = value => Math.min(100, Math.max(0, Number(value) || 0))
    // Coding Plan uses `usage` as the total quota, while Start Plan and MCP
    // expose the total in `number`. Prefer the field whose total matches used
    // plus remaining so the window length (5 hours / 1 week) is never used as
    // a token quota.
    const quotaTotal = limit => {
      const current = Number(limit?.currentValue)
      const remaining = Number(limit?.remaining)
      const numberTotal = Number(limit?.number)
      const usageTotal = Number(limit?.usage)
      if (numberTotal > 0 && Number.isFinite(current) && Number.isFinite(remaining)
        && Math.abs(current + remaining - numberTotal) <= Math.max(1, numberTotal * 0.01)) return numberTotal
      if (usageTotal > 0) return usageTotal
      if (numberTotal > 0) return numberTotal
      return Number.isFinite(current) && Number.isFinite(remaining) && current + remaining > 0
        ? current + remaining
        : 0
    }
    const remainingPercent = limit => {
      const cap = quotaTotal(limit)
      const remaining = Number(limit?.remaining)
      if (cap > 0 && Number.isFinite(remaining)) return percent(remaining / cap * 100)
      const raw = Number(limit?.percentage)
      if (!Number.isFinite(raw)) return 0
      return percent(limit?.unitType && raw >= 0 && raw <= 1 ? raw * 100 : 100 - raw)
    }

    return {
      inject: ['slots', 'locale', 'remote', 'layout'],
      async apply(ctx) {
        await ctx.remote.$mount(REMOTES)
        const entitlementsRemote = ctx.get('remote.zcodeEntitlements')
        if (entitlementsRemote === undefined) throw new Error('zcode-provider: remote.zcodeEntitlements did not mount')
        const captchaRemote = ctx.get(`remote.${CAPTCHA_REMOTE_NAMESPACE}`)
        if (captchaRemote === undefined) throw new Error('zcode-provider: remote.zcodeCaptcha did not mount')
        const promptRemote = ctx.get(`remote.${PROMPT_REMOTE_NAMESPACE}`)
        if (promptRemote === undefined) throw new Error('zcode-provider: remote.zcodePrompts did not mount')
        const authBackendRemote = ctx.get(`remote.${AUTH_BACKEND_REMOTE_NAMESPACE}`)
        if (authBackendRemote === undefined) throw new Error('zcode-provider: remote.zcodeAuthBackend did not mount')
        const tr = ctx.locale ? ctx.locale.bind(NS) : key => (zh[key] ?? en[key] ?? key)
        if (ctx.locale) ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'zcode-provider: entitlement dictionaries')

        async function callRemote(call, timeoutMessage, timeoutMs = REMOTE_TIMEOUT_MS) {
          const controller = new AbortController()
          let timer
          try {
            return await Promise.race([
              Promise.resolve().then(() => call(controller.signal)),
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort()
                  reject(new Error(timeoutMessage))
                }, timeoutMs)
              }),
            ])
          } finally {
            if (timer !== undefined) clearTimeout(timer)
            controller.abort()
          }
        }

        async function callCaptchaRemote(call, timeoutMessage, timeoutMs) {
          return remoteValue(await callRemote(call, timeoutMessage, timeoutMs))
        }

        function useCaptchaState() {
          const [, setRevision] = React.useState(0)
          React.useEffect(() => {
            const listener = () => setRevision(value => value + 1)
            captchaState.listeners.add(listener)
            return () => { captchaState.listeners.delete(listener) }
          }, [])
          return captchaState
        }

        function awaitCaptchaCompletion(challenge) {
          return new Promise((resolve) => {
            captchaState.active = {
              challenge,
              phase: 'preparing',
              detail: undefined,
              completing: false,
              completed: false,
              pendingResult: undefined,
              resolve,
            }
            notifyCaptcha()
          })
        }

        function clearCaptcha(active) {
          if (active.completed) return
          active.completed = true
          active.completing = false
          if (captchaState.active === active) {
            captchaState.active = undefined
            notifyCaptcha()
          }
          active.resolve()
        }

        async function releaseCaptcha(active) {
          // Keeping `release` optional lets a newly loaded Web client still
          // coexist briefly with an older Host during a rolling DPK update.
          if (typeof captchaRemote.release !== 'function') return { released: false }
          const id = typeof active?.challenge?.id === 'string' && active.challenge.id !== ''
            ? active.challenge.id
            : undefined
          try {
            return await callCaptchaRemote(
              () => captchaRemote.release({
                clientId: CAPTCHA_CLIENT_ID,
                ...(id === undefined ? {} : { id }),
              }),
              'captcha release timed out',
              CAPTCHA_RELEASE_TIMEOUT_MS,
            )
          } catch (_error) {
            // Cleanup is best effort. The broker's normal timeout remains the
            // owner of the final lifecycle decision when the Remote is down.
            return { released: false }
          }
        }

        function captchaHasExpired(challenge) {
          const delay = captchaExpiryDelay(challenge)
          return delay !== undefined && delay <= 0
        }

        function expireCaptcha(active) {
          if (active.completed || captchaState.active !== active) return
          active.phase = 'failed'
          active.detail = tr('captchaExpired')
          active.completing = false
          notifyCaptcha()
          // Expiry is an explicit terminal state, so it is the one failure
          // path that clears locally. `release` is still useful for a Host
          // whose timeout callback has not run yet.
          void releaseCaptcha(active)
          clearCaptcha(active)
        }

        function rejectCaptcha(active) {
          if (active.completed || captchaState.active !== active) return
          active.phase = 'failed'
          active.detail = tr('captchaFailed')
          active.completing = false
          notifyCaptcha()
          // The Host explicitly rejected this owner/challenge pair, so this
          // is terminal just like expiry. Release stays best effort because a
          // concurrent Host cleanup may already have removed it.
          void releaseCaptcha(active)
          clearCaptcha(active)
        }

        function terminalCaptchaStatus(response) {
          return response?.status === 'expired' || response?.status === 'rejected'
            ? response.status
            : undefined
        }

        async function completeCaptcha(active, result) {
          if (active.completing || active.completed || captchaState.active !== active) return 'inactive'
          if (captchaHasExpired(active.challenge)) {
            expireCaptcha(active)
            return 'expired'
          }
          active.pendingResult = result
          active.completing = true
          active.phase = 'submitting'
          active.detail = undefined
          notifyCaptcha()
          try {
            const response = await callCaptchaRemote(
              () => captchaRemote.complete({
                id: active.challenge.id,
                clientId: CAPTCHA_CLIENT_ID,
                result,
              }),
              'captcha completion timed out',
              CAPTCHA_COMPLETE_TIMEOUT_MS,
            )
            if (response?.accepted === true) {
              clearCaptcha(active)
              return 'accepted'
            }
            const terminalStatus = terminalCaptchaStatus(response)
            if (terminalStatus === 'expired') {
              expireCaptcha(active)
              return 'expired'
            }
            if (terminalStatus === 'rejected') {
              rejectCaptcha(active)
              return 'rejected'
            }
            if (captchaHasExpired(active.challenge)) {
              expireCaptcha(active)
              return 'expired'
            }
            // A false acknowledgement can mean the Remote reply raced a
            // successful completion or temporarily failed. Do not discard a
            // still-valid challenge: the SDK may emit another callback.
            active.completing = false
            active.phase = 'failed'
            active.detail = tr('captchaFailed')
            notifyCaptcha()
            return 'retryable'
          } catch (error) {
            if (captchaHasExpired(active.challenge)) {
              expireCaptcha(active)
              return 'expired'
            }
            if (active.completed || captchaState.active !== active) return 'inactive'
            // Keep the ownership until an explicit accepted result, expiry,
            // or overlay release. A transport error is retryable, not a
            // reason to lose the visible verification challenge.
            active.completing = false
            active.phase = 'failed'
            active.detail = safeError(error)
            notifyCaptcha()
            return 'retryable'
          }
        }

        function retryCaptcha(active) {
          if (active.pendingResult === undefined || active.completing || active.completed || captchaState.active !== active) return
          if (captchaHasExpired(active.challenge)) {
            expireCaptcha(active)
            return
          }
          void completeCaptcha(active, active.pendingResult)
        }

        function captchaClaimRetryDelay(response) {
          const retryAfterMs = Number(response?.retryAfterMs)
          if (!Number.isFinite(retryAfterMs)) return CAPTCHA_EMPTY_RETRY_MS
          return Math.min(CAPTCHA_MAX_RETRY_AFTER_MS, Math.max(0, Math.floor(retryAfterMs)))
        }

        async function claimCaptchaLoop(signal) {
          while (!signal.aborted) {
            let retryDelay = CAPTCHA_EMPTY_RETRY_MS
            try {
              const response = await callCaptchaRemote(
                () => captchaRemote.claim({ clientId: CAPTCHA_CLIENT_ID, waitMs: CAPTCHA_CLAIM_WAIT_MS }, signal),
                'captcha claim timed out',
                CAPTCHA_CLAIM_TIMEOUT_MS,
              )
              const challenge = response?.state === 'challenge' ? response.challenge : undefined
              if (signal.aborted) {
                // A claim can resolve after React has unmounted this overlay.
                // Return it so the next mounted overlay can claim it safely.
                if (challenge !== undefined) void releaseCaptcha({ challenge })
                return
              }
              if (challenge !== undefined && typeof challenge?.id === 'string' && challenge.id !== '') {
                await awaitCaptchaCompletion(challenge)
                continue
              }
              if (response?.state !== 'empty') throw new Error('invalid captcha claim result')
              retryDelay = captchaClaimRetryDelay(response)
            } catch (_error) {
              // The next long-poll is the online heartbeat; transient Remote
              // transport failures should not take the Web UI offline.
            }
            if (!signal.aborted) await sleep(retryDelay)
          }
        }

        async function loadSnapshot(force = false) {
          const request = ++state.snapshotRequest
          state.snapshotLoading = true
          state.snapshotError = undefined
          notify()
          try {
            const outcome = await callRemote(
              signal => entitlementsRemote.snapshot(force ? { force: true } : {}, signal),
              tr('loadTimeout'),
            )
            if (request !== state.snapshotRequest) return false
            if (outcome?.ok === false) throw outcome.error
            if (outcome?.ok !== true) throw new Error('invalid Remote result')
            state.snapshot = outcome.value
            return true
          } catch (error) {
            if (request === state.snapshotRequest) state.snapshotError = String(error?.message ?? error)
            return false
          } finally {
            if (request === state.snapshotRequest) {
              state.snapshotLoading = false
              notify()
            }
          }
        }

        async function loadUsage(range = state.range, force = false) {
          const request = ++state.usageRequest
          state.usageLoading = true
          state.usageError = undefined
          notify()
          try {
            const outcome = await callRemote(
              signal => entitlementsRemote.usage({ range, ...(force ? { force: true } : {}) }, signal),
              tr('usageTimeout'),
            )
            if (request !== state.usageRequest) return
            if (outcome?.ok === false) throw outcome.error
            if (outcome?.ok !== true) throw new Error('invalid Remote result')
            state.usage = outcome.value
          } catch (error) {
            if (request === state.usageRequest) state.usageError = String(error?.message ?? error)
          } finally {
            if (request === state.usageRequest) {
              state.usageLoading = false
              notify()
            }
          }
        }

        async function loadInitialSnapshot() {
          const usageRequest = state.usageRequest
          if (await loadSnapshot()) {
            // The core panel remains usable while the heavier model-usage call runs.
            if (usageRequest === state.usageRequest) void loadUsage(state.range)
          }
        }

        function selectRange(range) {
          if (state.range === range) return
          state.range = range
          state.usage = undefined
          notify()
          void loadUsage(range)
        }

        function refresh() {
          const range = state.range
          void loadSnapshot(true)
          void loadUsage(range, true)
        }

        function useSnapshot() {
          const [, setRevision] = React.useState(0)
          React.useEffect(() => {
            const listener = () => setRevision(value => value + 1)
            state.listeners.add(listener)
            if (state.snapshot === undefined && !state.snapshotLoading) void loadInitialSnapshot()
            return () => { state.listeners.delete(listener) }
          }, [])
          return state.snapshot
        }

        function Metric({ label, value, detail }) {
          return h('div', { style: { minWidth: 0, padding: '2px 18px 2px 0' } }, [
            h('div', { key: 'label', style: metricLabelStyle }, label),
            h('div', { key: 'value', style: valueStyle }, value),
            detail ? h('div', { key: 'detail', style: { ...mutedStyle, marginTop: 3, fontSize: 12 } }, detail) : null,
          ])
        }

        function Header() {
          return h('header', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', paddingBottom: 20 },
          }, [
            h('div', { key: 'title' }, [
              h('h2', { key: 'heading', style: { margin: 0, fontSize: 22 } }, tr('pageTitle')),
              state.snapshot?.fetchedAt
                ? h('div', { key: 'time', style: { ...mutedStyle, marginTop: 4, fontSize: 12 } }, `${tr('lastUpdated')}: ${date(state.snapshot.fetchedAt)}`)
                : null,
            ]),
            h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
              h('div', {
                key: 'range',
                role: 'group',
                'aria-label': tr('usage'),
                style: { display: 'flex', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', borderRadius: 6, overflow: 'hidden' },
              }, ['7d', '30d'].map((range) => h('button', {
                key: range,
                type: 'button',
                onClick: () => { selectRange(range) },
                style: {
                  minHeight: 30,
                  padding: '4px 10px',
                  border: 0,
                  borderRight: range === '7d' ? '1px solid color-mix(in srgb, currentColor 22%, transparent)' : 0,
                  background: state.range === range ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  cursor: 'pointer',
                },
              }, range === '7d' ? tr('range7') : tr('range30')))),
              h('button', {
                key: 'refresh',
                type: 'button',
                title: tr('refresh'),
                'aria-label': tr('refresh'),
                disabled: state.snapshotLoading || state.usageLoading,
                onClick: refresh,
                style: { ...buttonStyle, opacity: state.snapshotLoading || state.usageLoading ? 0.45 : 1 },
              }, h(IconRefreshOutlineRegular, { size: 16 })),
            ]),
          ])
        }

        function quotaLabel(limit) {
          if (limit.type === 'MCP_USAGE_LIMIT') return tr('serverMcp')
          if ((limit.type === 'TOKENS_LIMIT' || limit.type === 'CREDIT_LIMIT') && limit.unit === 3 && limit.number === 5) return tr('fiveHour')
          if ((limit.type === 'TOKENS_LIMIT' || limit.type === 'CREDIT_LIMIT') && limit.unit === 6) return tr('weekly')
          if (limit.type === 'TIME_LIMIT' && limit.unit === 5 && limit.number === 1) return tr('monthlyTool')
          return limit.type
        }

        function QuotaSection({ limits }) {
          return h('section', { style: sectionStyle }, [
            h('h3', { key: 'title', style: sectionTitleStyle }, tr('quotas')),
            limits.length === 0
              ? h('div', { key: 'empty', style: mutedStyle }, tr('noQuotas'))
              : h('div', { key: 'rows', style: { display: 'grid', gap: 18 } }, limits.map((limit, index) => {
                const pct = remainingPercent(limit)
                const total = quotaTotal(limit)
                const title = quotaLabel(limit)
                const modelNames = (limit.usageDetails ?? []).map(detail => detail.displayName || detail.modelCode).filter(Boolean).join(', ')
                return h('div', { key: `${limit.type}-${index}`, style: { display: 'grid', gap: 7 } }, [
                  h('div', { key: 'line', style: { display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } }, [
                    h('strong', { key: 'name' }, title),
                    h('span', { key: 'numbers', style: mutedStyle }, `${tr('used')} ${number(limit.currentValue)} / ${number(total)} · ${tr('remaining')} ${number(limit.remaining)}`),
                  ]),
                  h('div', {
                    key: 'track',
                    role: 'progressbar',
                    'aria-valuemin': 0,
                    'aria-valuemax': 100,
                    'aria-valuenow': pct,
                    style: { height: 6, overflow: 'hidden', background: 'color-mix(in srgb, currentColor 12%, transparent)' },
                  }, h('div', { style: { width: `${pct}%`, height: '100%', background: pct <= 10 ? '#c23b3b' : '#2f7d63' } })),
                  h('div', { key: 'meta', style: { ...mutedStyle, display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 } }, [
                    h('span', { key: 'pct' }, `${tr('remaining')} ${pct.toFixed(0)}%${modelNames ? ` · ${modelNames}` : ''}`),
                    limit.nextResetTime ? h('span', { key: 'reset' }, `${tr('reset')}: ${date(limit.nextResetTime)}`) : null,
                  ]),
                ])
              })),
          ])
        }

        function UsageSection({ usage, loading, error, range }) {
          const title = `${tr('usage')} · ${range}`
          if (!usage) return h('section', { style: sectionStyle }, [
            h('h3', { key: 'title', style: sectionTitleStyle }, title),
            loading
              ? h('div', { key: 'loading', role: 'status', style: mutedStyle }, tr('usageLoading'))
              : error
                ? h('div', { key: 'error', role: 'alert', style: { color: '#b42318' } }, `${tr('usageFailed')}: ${error}`)
                : h('div', { key: 'empty', style: mutedStyle }, tr('noUsage')),
          ])
          return h('section', { style: sectionStyle }, [
            h('h3', { key: 'title', style: sectionTitleStyle }, title),
            loading ? h('div', { key: 'loading', role: 'status', style: { ...mutedStyle, marginBottom: 12 } }, tr('usageLoading')) : null,
            error ? h('div', { key: 'error', role: 'alert', style: { color: '#b42318', marginBottom: 12 } }, `${tr('usageFailed')}: ${error}`) : null,
            h('div', {
              key: 'summary',
              style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, paddingBottom: 18 },
            }, [
              h(Metric, { key: 'tokens', label: tr('tokens'), value: tokens(usage.totalTokens) }),
              h(Metric, { key: 'calls', label: tr('calls'), value: number(usage.totalCalls) }),
              h(Metric, { key: 'days', label: tr('activeDays'), value: `${number(usage.activeDays)} / ${number(usage.days?.length)}` }),
            ]),
            h('div', { key: 'models', style: { display: 'grid' } }, (usage.models ?? []).map((model, index) => h('div', {
              key: model.modelId,
              style: {
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) max-content max-content',
                gap: 16,
                alignItems: 'center',
                padding: '9px 0',
                borderTop: index === 0 ? '1px solid color-mix(in srgb, currentColor 10%, transparent)' : 0,
                borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
              },
            }, [
              h('span', { key: 'model', style: { overflowWrap: 'anywhere' } }, model.modelId),
              h('span', { key: 'tokens', style: mutedStyle }, tokens(model.totalTokens)),
              h('span', { key: 'share', style: { minWidth: 52, textAlign: 'right' } }, `${(Number(model.share ?? 0) * 100).toFixed(1)}%`),
            ]))),
          ])
        }

        function promptDraftFromState(state, placement) {
          const value = state?.value?.[placement] ?? {}
          const defaults = state?.defaults ?? {}
          return Object.fromEntries(PROMPT_LAYERS.map(layer => [
            layer.id,
            typeof value[layer.id] === 'string' ? value[layer.id] : (defaults[layer.id] ?? ''),
          ]))
        }

        function usePromptState() {
          const [state, setState] = React.useState({ status: 'loading', revision: 0, value: {}, defaults: {} })
          React.useEffect(() => {
            let active = true
            void callRemote(
              signal => promptRemote.snapshot(signal),
              '提示词读取超时',
            ).then(outcome => {
              if (!active) return
              const snapshot = remoteValue(outcome)
              setState({
                status: 'ready',
                revision: Number(snapshot?.revision ?? 0),
                value: snapshot?.value ?? {},
                defaults: snapshot?.defaults ?? {},
              })
            }).catch(error => {
              if (active) setState({ status: 'error', revision: 0, value: {}, defaults: {}, error: safeError(error) })
            })
            return () => { active = false }
          }, [])
          return [state, setState]
        }

        function useAuthBackendState() {
          const [state, setState] = React.useState({ status: 'loading', revision: 0, backend: 'openzcode-app-server' })
          React.useEffect(() => {
            let active = true
            void callRemote(
              signal => authBackendRemote.snapshot(signal),
              '鉴权链路读取超时',
            ).then(outcome => {
              if (!active) return
              const snapshot = remoteValue(outcome)
              setState({
                status: 'ready',
                revision: Number(snapshot?.revision ?? 0),
                backend: snapshot?.backend === 'closezcode-app-server' ? 'closezcode-app-server' : 'openzcode-app-server',
              })
            }).catch(error => {
              if (active) setState({ status: 'error', revision: 0, backend: 'openzcode-app-server', error: safeError(error) })
            })
            return () => { active = false }
          }, [])
          return [state, setState]
        }

        function SystemPromptEditor({ view }) {
          if (view === 'summary') return '三段提示词：前置附加注入 / 后置逐块覆写'
          const [state, setState] = usePromptState()
          const [backendState, setBackendState] = useAuthBackendState()
          const [placement, setPlacement] = React.useState(() => state.value?.placement === 'after' ? 'after' : 'before')
          const [drafts, setDrafts] = React.useState(() => ({
            before: promptDraftFromState(state, 'before'),
            after: promptDraftFromState(state, 'after'),
          }))
          const [backend, setBackend] = React.useState('openzcode-app-server')
          const [saving, setSaving] = React.useState(false)
          const [backendSaving, setBackendSaving] = React.useState(false)
          const [notice, setNotice] = React.useState(null)
          const [backendNotice, setBackendNotice] = React.useState(null)
          const revision = state.revision
          React.useEffect(() => {
            if (!saving) {
              setPlacement(state.value?.placement === 'after' ? 'after' : 'before')
              setDrafts({
                before: promptDraftFromState(state, 'before'),
                after: promptDraftFromState(state, 'after'),
              })
            }
          }, [revision, state.status, saving])
          React.useEffect(() => {
            if (!backendSaving && backendState.status === 'ready') setBackend(backendState.backend)
          }, [backendState.revision, backendState.status, backendSaving])

          const setPrompt = (id, text) => {
            setDrafts(current => ({ ...current, [placement]: { ...current[placement], [id]: text } }))
            setNotice('')
          }
          const switchPlacement = () => {
            setPlacement(current => current === 'after' ? 'before' : 'after')
            setNotice('')
          }
          const restoreDefaults = () => {
            setDrafts(current => ({
              ...current,
              [placement]: promptDraftFromState({ defaults: state.defaults, value: {} }, placement),
            }))
            setNotice('')
          }
          const save = async () => {
            if (saving || state.status !== 'ready') return
            setSaving(true)
            setNotice('')
            try {
              const value = {
                placement,
                before: Object.fromEntries(PROMPT_LAYERS.flatMap(layer => {
                  const value = String(drafts.before[layer.id] ?? '')
                  return value.trim() === '' ? [] : [[layer.id, value]]
                })),
                after: Object.fromEntries(PROMPT_LAYERS.flatMap(layer => {
                  const value = String(drafts.after[layer.id] ?? '')
                  // 后置覆写:空串是「清空该官方块」的显式标记,必须随保存下发
                  return [[layer.id, value.trim() === '' ? '' : value]]
                })),
              }
              const snapshot = remoteValue(await callRemote(
                signal => promptRemote.mutate({ value }, signal),
                '提示词保存超时',
              ))
              setState({
                status: 'ready',
                revision: Number(snapshot?.revision ?? revision + 1),
                value: snapshot?.value ?? value,
                defaults: snapshot?.defaults ?? state.defaults,
              })
              setNotice({ kind: 'success', text: '提示词保存成功' })
            } catch (error) {
              setNotice({ kind: 'error', text: `保存失败: ${String(error)}` })
            } finally {
              setSaving(false)
            }
          }

          const saveBackend = async event => {
            const next = event.target.value === 'closezcode-app-server'
              ? 'closezcode-app-server'
              : 'openzcode-app-server'
            if (backendSaving || backendState.status !== 'ready' || next === backend) return
            setBackend(next)
            setBackendSaving(true)
            setBackendNotice(null)
            try {
              const snapshot = remoteValue(await callRemote(
                signal => authBackendRemote.mutate({ backend: next }, signal),
                '鉴权链路保存超时',
              ))
              setBackendState({
                status: 'ready',
                revision: Number(snapshot?.revision ?? backendState.revision + 1),
                backend: snapshot?.backend === 'closezcode-app-server' ? 'closezcode-app-server' : 'openzcode-app-server',
              })
              setBackendNotice({ kind: 'success', text: '鉴权链路已保存，后续请求立即生效' })
            } catch (error) {
              setBackend(backendState.backend)
              setBackendNotice({ kind: 'error', text: `保存失败: ${String(error)}` })
            } finally {
              setBackendSaving(false)
            }
          }

          const backendDescription = backend === 'openzcode-app-server'
            ? '白盒 app-server：复用 ZCode app-server 的账号权益与运行时链路。'
            : '原版直连：使用插件内的 Anthropic 请求与鉴权实现。'

          return h('section', { style: { ...sectionStyle, paddingTop: 18 }, 'data-zcode-system-prompt-editor': true }, [
            h('div', { key: 'card', style: panelCardStyle }, [
              h('div', { key: 'heading', style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' } }, [
                h('div', { key: 'heading-copy' }, [
                  h('div', { key: 'eyebrow', style: { fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.56, marginBottom: 6 } }, 'ZCODE PROVIDER'),
                  h('h3', { key: 'title', style: { margin: 0, fontSize: 20, fontWeight: 700 } }, '系统提示词与鉴权链路'),
                  h('p', { key: 'description', style: { ...mutedStyle, margin: '8px 0 0', maxWidth: 680, lineHeight: 1.55 } }, '前置＝附加自定义块（官方三块完整保留）；后置＝覆写对应的官方块：未改动的层保持官方原文，清空即把该块从请求中移除（0 字节注入）。'),
                ]),
                h('span', { key: 'badge', style: { padding: '5px 9px', borderRadius: 999, fontSize: 12, background: 'color-mix(in srgb, #4f9d79 18%, transparent)', color: '#79c39d', whiteSpace: 'nowrap' } }, '本地持久化'),
              ]),
              h('div', { key: 'backend', style: { ...fieldCardStyle, marginTop: 20 } }, [
                h('div', { key: 'backend-head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } }, [
                  h('div', { key: 'backend-title' }, [
                    h('strong', { key: 'label', style: { fontSize: 14 } }, '鉴权后端'),
                    h('div', { key: 'hint', style: { ...mutedStyle, fontSize: 12, marginTop: 3 } }, '选择后对后续模型请求生效'),
                  ]),
                  backendState.status === 'ready'
                    ? h('span', { key: 'ready', style: { fontSize: 12, color: '#79c39d' } }, backendSaving ? '保存中…' : '已连接')
                    : h('span', { key: 'loading', style: { ...mutedStyle, fontSize: 12 } }, backendState.error ?? '读取中…'),
                ]),
                h('select', {
                  key: 'select',
                  value: backend,
                  disabled: backendState.status !== 'ready' || backendSaving,
                  onChange: saveBackend,
                  'aria-label': '鉴权后端',
                  style: selectStyle,
                }, [
                  h('option', { key: 'open', value: 'openzcode-app-server' }, 'openzcode-app-server · 白盒 app-server'),
                  h('option', { key: 'close', value: 'closezcode-app-server' }, 'closezcode-app-server · 原版直连'),
                ]),
                h('div', { key: 'backend-description', style: { ...mutedStyle, fontSize: 12, lineHeight: 1.45 } }, backendDescription),
                backendNotice !== null
                  ? h('div', { key: 'backend-notice', role: backendNotice.kind === 'error' ? 'alert' : 'status', style: { fontSize: 12, color: backendNotice.kind === 'error' ? '#e38484' : '#79c39d' } }, backendNotice.text)
                  : null,
              ]),
              h('div', { key: 'placement', style: { ...fieldCardStyle, marginTop: 14 } }, [
                h('div', { key: 'placement-top', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } }, [
                  h('strong', { key: 'label', style: { fontSize: 14 } }, '附加提示词位置'),
                  h('button', {
                  key: 'slider',
                  type: 'button',
                  role: 'switch',
                  'aria-checked': placement === 'after',
                  'aria-label': '附加提示词位置',
                  'aria-valuetext': placement === 'after' ? '后置' : '前置',
                  disabled: state.status !== 'ready' || saving,
                  onClick: switchPlacement,
                  style: {
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    width: 128,
                    height: 36,
                    padding: 3,
                    boxSizing: 'border-box',
                    border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
                    borderRadius: 18,
                    background: 'color-mix(in srgb, currentColor 7%, transparent)',
                    cursor: state.status !== 'ready' || saving ? 'not-allowed' : 'pointer',
                    opacity: state.status !== 'ready' || saving ? 0.55 : 1,
                  },
                  }, [
                    h('span', {
                      key: 'thumb',
                      'aria-hidden': true,
                      style: {
                        position: 'absolute',
                        top: 3,
                        bottom: 3,
                        left: 3,
                        width: 'calc(50% - 3px)',
                        borderRadius: 14,
                        background: '#769cf4',
                        boxShadow: '0 1px 3px color-mix(in srgb, #000 28%, transparent)',
                        transform: placement === 'after' ? 'translateX(100%)' : 'translateX(0)',
                        transition: 'transform 160ms ease',
                      },
                    }),
                    ...PROMPT_PLACEMENTS.map(option => h('span', {
                      key: option.id,
                      style: {
                        position: 'relative',
                        zIndex: 1,
                        display: 'grid',
                        placeItems: 'center',
                        width: '50%',
                        fontSize: 12,
                        fontWeight: placement === option.id ? 650 : 500,
                        color: placement === option.id ? '#17233b' : 'inherit',
                        opacity: placement === option.id ? 1 : 0.7,
                      },
                    }, option.title)),
                  ]),
                ]),
              ]),
              state.status !== 'ready'
                ? h('p', { key: 'status', role: 'status', style: { ...mutedStyle, margin: '16px 0 0' } }, state.error ?? '提示词配置正在加载')
                : null,
              h('div', { key: 'layers', style: { display: 'grid', gap: 12, marginTop: 14 } }, PROMPT_LAYERS.map((layer, index) => h('label', {
                key: layer.id,
                style: fieldCardStyle,
              }, [
                h('div', { key: 'label-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } }, [
                  h('span', { key: 'label', style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 650 } }, [
                    h('span', { key: 'number', style: { display: 'inline-grid', placeItems: 'center', width: 23, height: 23, borderRadius: 7, background: 'color-mix(in srgb, #769cf4 22%, transparent)', color: '#a9c0ff', fontSize: 12 } }, String(index + 1)),
                    layer.title,
                  ]),
                  h('span', { key: 'count', style: { ...mutedStyle, fontSize: 11 } }, `${String(drafts[placement][layer.id] ?? '').length} 字符`),
                ]),
                h('textarea', {
                  key: 'input',
                  value: drafts[placement][layer.id] ?? '',
                  rows: layer.id === 'identity' ? 3 : 10,
                  disabled: state.status !== 'ready' || saving,
                  spellCheck: false,
                  onChange: event => setPrompt(layer.id, event.target.value),
                  style: { ...promptEditorStyle, minHeight: layer.id === 'identity' ? 92 : 188, borderRadius: 8, background: 'color-mix(in srgb, currentColor 5%, transparent)', outline: 'none' },
                }),
              ]))),
              notice !== null
                ? h('div', { key: 'notice', role: notice.kind === 'error' ? 'alert' : 'status', style: { marginTop: 14, padding: '9px 11px', borderRadius: 7, fontSize: 12, color: notice.kind === 'error' ? '#e38484' : '#79c39d', background: notice.kind === 'error' ? 'color-mix(in srgb, #b42318 12%, transparent)' : 'color-mix(in srgb, #2f7d63 12%, transparent)' } }, notice.text)
                : null,
              h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 9, marginTop: 16, flexWrap: 'wrap' } }, [
                h('button', {
                  key: 'save',
                  type: 'button',
                  disabled: state.status !== 'ready' || saving,
                  onClick: save,
                  style: { ...buttonStyle, width: 'auto', minWidth: 112, minHeight: 38, padding: '0 15px', border: '1px solid #6e91ea', background: 'color-mix(in srgb, #557fe8 24%, transparent)', fontWeight: 650 },
                }, saving ? '保存中…' : '保存提示词'),
                h('button', {
                  key: 'restore',
                  type: 'button',
                  disabled: saving,
                  onClick: restoreDefaults,
                  style: { ...buttonStyle, width: 'auto', minWidth: 112, minHeight: 38, padding: '0 14px', background: 'color-mix(in srgb, currentColor 7%, transparent)' },
                }, '恢复官方默认'),
              ]),
            ]),
          ])
        }

        function PlanSection({ snapshot }) {
          const details = snapshot?.subscription?.details ?? []
          return h('section', { style: sectionStyle }, [
            h('h3', { key: 'title', style: sectionTitleStyle }, tr('startPlan')),
            details.length
              ? h('div', { key: 'plans', style: { display: 'grid', gap: 16 } }, details.map((plan, planIndex) => h('div', { key: `${plan.productId}-${planIndex}`, style: { display: 'grid', gap: 8 } }, [
                  h('div', { key: 'name', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                    h('strong', { key: 'value', style: { fontSize: 17 } }, plan.productName),
                    h('span', { key: 'status', style: { color: '#2f7d63' } }, tr('active')),
                  ]),
                  h('div', { key: 'period', style: mutedStyle }, `${tr('validPeriod')}: ${date(plan.beginTime)} – ${date(plan.expireTime)}`),
                  (plan.entitlements ?? []).map((entry, index) => h('div', { key: `${entry.entitlementId}-${index}`, style: { padding: '8px 0', borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)' } }, [
                    h('div', { key: 'name' }, entry.showName || entry.entitlementId),
                    entry.effectiveTime ? h('div', { key: 'effective', style: { ...mutedStyle, marginTop: 3, fontSize: 12 } }, date(entry.effectiveTime)) : null,
                  ])),
                ])))
              : h('div', { key: 'empty', style: mutedStyle }, tr('noStartPlan')),
            h(QuotaSection, { key: 'quota', limits: snapshot?.quota?.limits ?? [] }),
          ])
        }

        function providerStatus(provider) {
          const state = provider?.state
          if (!state) return tr('unknown')
          if (state.availability === 'pending') return tr('pending')
          if (state.availability === 'available' && state.entitled) return tr('available')
          const reasons = {
            'not-authenticated': 'notAuthenticated',
            'not-connected': 'notConnected',
            'credential-failed': 'credentialFailed',
            'not-entitled': 'notEntitled',
          }
          return state.availability === 'unknown' ? tr('unknown') : tr(reasons[state.unavailableReason] ?? 'unavailable')
        }

        function accountModeForProvider(provider) {
          const normalized = String(provider ?? '').trim().toLowerCase()
          if (!/^(?:builtin|account):(?:zai|bigmodel)-/.test(normalized)) return undefined
          if (normalized.endsWith('-start-plan')) return 'start-plan'
          if (normalized.endsWith('-coding-plan')
            || normalized.endsWith('-individual-coding-plan')
            || normalized.endsWith('-team-coding-plan')) return 'coding-plan'
          return undefined
        }

        function EntitlementsPage() {
          const snapshot = useSnapshot()
          const report = snapshot?.core
          const supplement = state.usage?.supplement
          const coding = report?.entitlements?.codingPlan
          const start = report?.entitlements?.startPlan
          const providers = Object.values(report?.accountProviders ?? {})
          const codingProvider = providers.find(provider => provider.access?.mode === 'individual-coding-plan' || provider.access?.mode === 'team-coding-plan')
          const startProvider = providers.find(provider => provider.access?.mode === 'start-plan')
          const codingDetail = coding?.subscription?.details?.[0]
          const codingMcpQuota = coding?.subscription ? supplement?.mcpQuota : undefined
          const codingLimits = [
            ...(coding?.quota?.limits ?? []),
            ...(codingMcpQuota?.aggregate ? [codingMcpQuota.aggregate] : []),
          ]
          const failures = [
            ...(report?.failures ?? []),
            ...(supplement?.failures ?? []),
          ]
          return h('main', { style: { height: '100%', overflow: 'auto' } },
            h('div', { style: { width: 'min(980px, 100%)', margin: '0 auto', padding: '24px', boxSizing: 'border-box' } }, [
              h(Header, { key: 'header' }),
              state.snapshotLoading && !report
                ? h('div', { key: 'loading', role: 'status', style: { padding: '28px 0', ...mutedStyle } }, tr('loading'))
                : null,
              state.snapshotError
                ? h('div', { key: 'error', role: 'alert', style: { padding: '12px 0', color: '#b42318' } }, `${tr('failed')}: ${state.snapshotError}`)
                : null,
              report
                ? h(React.Fragment, { key: 'content' }, [
                    h('section', { key: 'overview', style: { ...sectionStyle, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 } }, [
                      h(Metric, { key: 'plan', label: tr('codingPlan'), value: providerStatus(codingProvider), detail: codingDetail?.productName }),
                      h(Metric, { key: 'quota', label: tr('remaining'), value: coding?.remaining ? tokens(coding.remaining.count) : '—', detail: coding?.quota?.level }),
                      h(Metric, { key: 'usage', label: tr('tokens'), value: supplement?.modelUsage ? tokens(supplement.modelUsage.totalTokens) : '—', detail: supplement?.modelUsage?.range }),
                      h(Metric, { key: 'start', label: tr('startPlan'), value: providerStatus(startProvider), detail: start?.subscription?.details?.[0]?.productName }),
                    ]),
                    codingDetail
                      ? h('section', { key: 'subscription', style: sectionStyle }, [
                          h('h3', { key: 'title', style: sectionTitleStyle }, tr('codingPlan')),
                          h('div', { key: 'name', style: valueStyle }, codingDetail.productName),
                          h('div', { key: 'meta', style: { ...mutedStyle, display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 8 } }, [
                            codingDetail.billingCycle ? h('span', { key: 'cycle' }, `${tr('billingCycle')}: ${codingDetail.billingCycle}`) : null,
                            codingDetail.renewTime ? h('span', { key: 'renew' }, `${tr('renewal')}: ${date(codingDetail.renewTime)}`) : null,
                            codingDetail.expireTime ? h('span', { key: 'expire' }, `${tr('expiry')}: ${date(codingDetail.expireTime)}`) : null,
                          ]),
                        ])
                      : null,
                    h(QuotaSection, { key: 'quotas', limits: codingLimits }),
                    h(UsageSection, {
                      key: 'usage',
                      usage: supplement?.modelUsage,
                      loading: state.usageLoading,
                      error: state.usageError,
                      range: state.range,
                    }),
                    h(PlanSection, { key: 'start-plan', snapshot: start }),
                    failures.length
                      ? h('section', { key: 'failures', style: sectionStyle }, [
                          h('h3', { key: 'title', style: sectionTitleStyle }, tr('diagnostics')),
                          h('div', { key: 'items', style: { display: 'grid', gap: 6 } }, failures.map((failure, index) => h('div', { key: `${failure.source}-${index}`, style: { color: '#b42318', overflowWrap: 'anywhere' } }, `${failure.source}: ${failure.reason}`))),
                        ])
                      : null,
                  ])
                : null,
            ]))
        }

        function EntitlementsIcon({ size }) {
          return h(IconGaugeOutlineRegular, { size })
        }

        function captchaExpiryDelay(challenge) {
          const value = challenge?.expiresAt
          const expiresAt = typeof value === 'number'
            ? value
            : typeof value === 'string'
              ? Date.parse(value)
              : Number.NaN
          return Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : undefined
        }

        function CaptchaOverlay() {
          const captcha = useCaptchaState()
          React.useEffect(() => {
            const controller = new AbortController()
            void claimCaptchaLoop(controller.signal)
            return () => {
              controller.abort()
              // `release` without an id also resolves a pending long-poll;
              // with an id it returns the currently owned challenge. Clear
              // only because this is an explicit overlay release lifecycle.
              const active = captchaState.active
              void releaseCaptcha(active)
              if (active !== undefined) clearCaptcha(active)
            }
          }, [])

          const active = captcha.active
          const challengeId = active?.challenge?.id
          React.useEffect(() => {
            if (active === undefined) return undefined
            let cancelled = false
            let settled = false
            let expiryTimer
            const settle = (result) => {
              if (cancelled || settled || active.completing || active.completed || captchaState.active !== active) return
              settled = true
              void completeCaptcha(active, result).then((outcome) => {
                // An unacknowledged result remains retryable while the
                // challenge is valid. Do not automatically resubmit it;
                // reopening/retrying in the SDK supplies a fresh callback.
                if (outcome === 'retryable' && !cancelled && captchaState.active === active) {
                  settled = false
                }
              })
            }
            const expiryDelay = captchaExpiryDelay(active.challenge)
            if (expiryDelay !== undefined) {
              expiryTimer = setTimeout(() => {
                if (!cancelled) expireCaptcha(active)
              }, expiryDelay)
            }
            void (async () => {
              try {
                const config = captchaConfig(active.challenge)
                const elementId = captchaDomId('zcode-aliyun-captcha-element', active.challenge.id)
                const buttonId = captchaDomId('zcode-aliyun-captcha-button', active.challenge.id)
                await loadAliyunCaptchaSdk()
                if (cancelled || captchaState.active !== active) return
                if (typeof window.initAliyunCaptcha !== 'function') throw new Error('captcha SDK is unavailable')
                window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix }
                active.phase = 'ready'
                notifyCaptcha()
                window.initAliyunCaptcha({
                  SceneId: config.sceneId,
                  mode: 'popup',
                  language: 'cn',
                  showErrorTip: false,
                  element: `#${elementId}`,
                  button: `#${buttonId}`,
                  getInstance: (instance) => {
                    if (cancelled || settled) return
                    try {
                      if (typeof instance?.startTracelessVerification !== 'function') {
                        throw new Error('captcha SDK instance does not support traceless verification')
                      }
                      active.phase = 'verifying'
                      notifyCaptcha()
                      instance.startTracelessVerification()
                    } catch (error) {
                      settle({ state: 'error', reason: safeError(error) })
                    }
                  },
                  success: (param) => {
                    const value = typeof param === 'string' ? param.trim() : ''
                    settle(value === ''
                      ? { state: 'error', reason: 'captcha returned an empty verification parameter' }
                      : { state: 'success', param: value })
                  },
                  fail: (error) => {
                    const verifyCode = error?.verifyCode ?? error?.data?.verifyCode
                    settle({
                      state: 'fail',
                      ...(typeof verifyCode === 'string' && verifyCode !== '' ? { verifyCode } : {}),
                      reason: 'captcha verification failed',
                    })
                  },
                  onError: (error) => { settle({ state: 'error', reason: safeError(error) }) },
                })
              } catch (error) {
                settle({ state: 'error', reason: safeError(error) })
              }
            })()
            return () => {
              cancelled = true
              if (expiryTimer !== undefined) clearTimeout(expiryTimer)
            }
          }, [challengeId])

          if (active === undefined) return null
          const elementId = captchaDomId('zcode-aliyun-captcha-element', active.challenge.id)
          const buttonId = captchaDomId('zcode-aliyun-captcha-button', active.challenge.id)
          const status = active.phase === 'preparing'
            ? tr('captchaPreparing')
            : active.phase === 'ready'
              ? tr('captchaReady')
              : active.phase === 'verifying'
                ? tr('captchaVerifying')
                : active.phase === 'submitting'
                  ? tr('captchaSubmitting')
                  : active.detail ?? tr('captchaFailed')
          const retryable = active.phase === 'failed'
            && active.pendingResult !== undefined
            && !active.completing
            && !captchaHasExpired(active.challenge)
          return h('div', {
            role: 'dialog',
            'aria-modal': true,
            'aria-label': tr('captchaTitle'),
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 1000,
              display: 'grid',
              placeItems: 'center',
              padding: 20,
              boxSizing: 'border-box',
              pointerEvents: 'auto',
              background: 'rgb(15 23 42 / 42%)',
            },
          }, h('section', {
            style: {
              width: 'min(440px, 100%)',
              maxHeight: 'min(620px, 100%)',
              overflow: 'auto',
              padding: 20,
              border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
              borderRadius: 8,
              background: 'var(--dsh-color-bg, Canvas)',
              color: 'var(--dsh-color-fg, CanvasText)',
              boxShadow: '0 18px 52px rgb(0 0 0 / 28%)',
            },
          }, [
            h('h2', { key: 'title', style: { margin: '0 0 8px', fontSize: 18, fontWeight: 600 } }, tr('captchaTitle')),
            h('div', { key: 'status-row', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 } }, [
              h('div', { key: 'status', role: 'status', 'aria-live': 'polite', style: mutedStyle }, status),
              retryable
                ? h('button', {
                    key: 'retry',
                    type: 'button',
                    title: tr('captchaRetry'),
                    'aria-label': tr('captchaRetry'),
                    onClick: () => retryCaptcha(active),
                    style: { ...buttonStyle, flex: '0 0 auto' },
                  }, h(IconRefreshOutlineRegular, { size: 16 }))
                : null,
            ]),
            h('div', {
              key: 'element',
              id: elementId,
              style: { minHeight: 44, display: 'grid', placeItems: 'center' },
            }),
            h('button', {
              key: 'button',
              id: buttonId,
              type: 'button',
              style: {
                width: '100%',
                minHeight: 38,
                border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
                borderRadius: 6,
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
              },
            }, status),
            active.detail
              ? h('div', { key: 'detail', role: 'alert', style: { marginTop: 12, color: '#b42318', overflowWrap: 'anywhere' } }, active.detail)
              : null,
          ]))
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'zcode-entitlements', locale: NS,
        }, EntitlementsPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'zcode-entitlements', order: 9, label: () => tr('panel'), locale: NS,
        }, EntitlementsIcon))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'zcode-captcha', order: 1000, locale: NS,
        }, CaptchaOverlay))
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: 'zcode-provider', locale: NS,
        }, SystemPromptEditor))
      },
    }
  },
})
