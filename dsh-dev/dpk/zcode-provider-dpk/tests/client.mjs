import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

test('quota bars use remaining capacity and the real quota total', () => {
  assert.match(source, /const quotaTotal = limit =>/)
  assert.match(source, /const cap = quotaTotal\(limit\)/)
  assert.match(source, /background: pct <= 10 \? '#c23b3b' : '#2f7d63'/)
  assert.doesNotMatch(source, /background: pct >= 90 \? '#c23b3b'/)
  assert.match(source, /const REMOTE_TIMEOUT_MS = 10_000/)
  assert.match(source, /Promise\.race\(\[/)
  assert.match(source, /const directDescriptor = \(namespace, method, typeSymbol, cancellation = false\)/)
  assert.match(source, /directDescriptor\('zcodeEntitlements', 'snapshot', '@local\/zcode-provider#UsageSnapshotRequest', true\)/)
  assert.match(source, /directDescriptor\('zcodeEntitlements', 'usage', '@local\/zcode-provider#UsageSnapshotRequest', true\)/)
  assert.match(source, /controller\.abort\(\)/)
  assert.match(source, /const CAPTCHA_REMOTE_NAMESPACE = 'zcodeCaptcha'/)
  assert.match(source, /directDescriptor\(CAPTCHA_REMOTE_NAMESPACE, 'claim', '@local\/zcode-provider#CaptchaClaimRequest'\)/)
  assert.match(source, /cancellation: \{ parameter: 'signal' \}/)
  assert.match(source, /directDescriptor\(CAPTCHA_REMOTE_NAMESPACE, 'complete', '@local\/zcode-provider#CaptchaCompleteRequest'\)/)
  assert.match(source, /directDescriptor\(CAPTCHA_REMOTE_NAMESPACE, 'release', '@local\/zcode-provider#CaptchaReleaseRequest'\)/)
  assert.match(source, /const CAPTCHA_RELEASE_TIMEOUT_MS = 5_000/)
  assert.match(source, /const CAPTCHA_MAX_RETRY_AFTER_MS = 30_000/)
  assert.match(source, /function captchaClaimRetryDelay\(response\)/)
  assert.match(source, /retryDelay = captchaClaimRetryDelay\(response\)/)
  assert.match(source, /await sleep\(retryDelay\)/)
  assert.match(source, /async function releaseCaptcha\(active\)/)
  assert.match(source, /captchaRemote\.release\(\{/)
  assert.match(source, /const active = captchaState\.active\s+void releaseCaptcha\(active\)\s+if \(active !== undefined\) clearCaptcha\(active\)/)
  assert.match(source, /active\.pendingResult = result/)
  assert.match(source, /function retryCaptcha\(active\)/)
  assert.match(source, /onClick: \(\) => retryCaptcha\(active\)/)
  assert.match(source, /response\?\.status === 'expired' \|\| response\?\.status === 'rejected'/)
  assert.match(source, /if \(response\?\.accepted === true\) \{\s+clearCaptcha\(active\)/)
  assert.doesNotMatch(source, /finally \{\s+active\.completed = true/)
  assert.match(source, /const CAPTCHA_CLIENT_ID = \(\(\) =>/)
  assert.match(source, /const CAPTCHA_CLAIM_WAIT_MS = 0/)
  assert.doesNotMatch(source, /const CAPTCHA_CLAIM_WAIT_MS = 25_000/)
  assert.match(source, /captchaRemote\.claim\(\{ clientId: CAPTCHA_CLIENT_ID, waitMs: CAPTCHA_CLAIM_WAIT_MS \}, signal\)/)
  assert.match(source, /const controller = new AbortController\(\)\s+void claimCaptchaLoop\(controller\.signal\)/)
  assert.match(source, /controller\.abort\(\)/)
  assert.match(source, /ALIYUN_CAPTCHA_SDK_URL = 'https:\/\/o\.alicdn\.com\/captcha-frontend\/aliyunCaptcha\/AliyunCaptcha\.js'/)
  assert.match(source, /window\.AliyunCaptchaConfig = \{ region: config\.region, prefix: config\.prefix \}/)
  assert.match(source, /window\.initAliyunCaptcha\(\{/)
  assert.match(source, /startTracelessVerification\(\)/)
  assert.match(source, /name: 'shell\.overlay', id: 'zcode-captcha'/)
  assert.doesNotMatch(source, /localStorage/)
  assert.doesNotMatch(source, /node:child_process/)
  assert.doesNotMatch(source, /\bspawn\s*\(/)
  assert.doesNotMatch(source, /remote-debugging-port/)
  assert.match(source, /const supplement = state\.usage\?\.supplement/)
  assert.match(source, /const codingMcpQuota = coding\?\.subscription \? supplement\?\.mcpQuota : undefined/)
  assert.match(source, /state\.snapshotLoading && !report/)
  assert.doesNotMatch(source, /state\.loading/)
  assert.match(source, /function selectRange\(range\) \{[^}]*void loadUsage\(range\)/)
  assert.doesNotMatch(source, /function selectRange\(range\) \{[^}]*void loadUsage\(range, true\)/)
  assert.match(source, /function refresh\(\) \{[\s\S]*?void loadSnapshot\(true\)[\s\S]*?void loadUsage\(range, true\)/)
})

test('captcha SDK failures remove the script and replace stale unmarked nodes', async () => {
  let registration
  const scripts = []
  const created = []
  const makeScript = () => {
    const listeners = new Map()
    return {
      async: false,
      dataset: Object.create(null),
      parentNode: undefined,
      removed: false,
      src: '',
      addEventListener(type, listener) {
        const current = listeners.get(type) ?? []
        current.push(listener)
        listeners.set(type, current)
      },
      dispatch(type) {
        for (const listener of listeners.get(type) ?? []) listener()
      },
      remove() {
        this.removed = true
        const index = scripts.indexOf(this)
        if (index >= 0) scripts.splice(index, 1)
        this.parentNode = undefined
      },
    }
  }
  const stale = makeScript()
  stale.dataset.zcodeAliyunCaptchaSdk = 'true'
  scripts.push(stale)
  const document = {
    querySelector(selector) {
      assert.equal(selector, 'script[data-zcode-aliyun-captcha-sdk="true"]')
      return scripts.find(script => script.dataset.zcodeAliyunCaptchaSdk === 'true') ?? null
    },
    createElement(tag) {
      assert.equal(tag, 'script')
      const script = makeScript()
      created.push(script)
      return script
    },
    head: {
      appendChild(script) {
        scripts.push(script)
        script.parentNode = this
        return script
      },
    },
  }
  const window = {
    crypto: { randomUUID: () => 'captcha-sdk-test' },
    __ModuleLoader__: { load(value) { registration = value } },
  }
  vm.runInNewContext(source, {
    AbortController,
    Date,
    Intl,
    clearTimeout,
    document,
    setTimeout,
    window,
  })

  const effectSlots = []
  const pendingEffects = []
  let hookIndex = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useEffect(callback, deps) {
      const index = hookIndex++
      const previous = effectSlots[index]
      const changed = previous === undefined
        || previous.deps.length !== deps.length
        || previous.deps.some((value, valueIndex) => value !== deps[valueIndex])
      if (!changed) return
      pendingEffects.push(() => {
        previous?.cleanup?.()
        effectSlots[index] = { deps, cleanup: callback() }
      })
    },
    useState(initial) {
      hookIndex += 1
      return [initial, () => {}]
    },
  }
  const plugin = registration.factory((name) => {
    if (name === 'react') return React
    return {
      IconCheckCircleOutlineRegular() {},
      IconGaugeOutlineRegular() {},
      IconRefreshOutlineRegular() {},
      IconWarningOutlineRegular() {},
    }
  })
  const registrations = []
  let claims = 0
  const captchaRemote = {
    async claim(_request, signal) {
      if (claims++ === 0) {
        return {
          ok: true,
          value: {
            state: 'challenge',
            challenge: {
              id: 'sdk-retry-challenge',
              config: { region: 'cn', prefix: 'fixture', sceneId: 'scene' },
              expiresAt: Date.now() + 60_000,
            },
          },
        }
      }
      return await new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({ ok: true, value: { state: 'empty' } }), { once: true })
      })
    },
    async complete() { return { ok: true, value: { accepted: true } } },
    async release() { return { ok: true, value: { released: true } } },
  }
  const usageRemote = {
    async snapshot() { return { ok: true, value: { core: { accountProviders: {}, entitlements: {}, failures: [] } } } },
    async usage() { return { ok: true, value: { supplement: { failures: [] } } } },
  }
  const promptRemote = {
    async snapshot() { return { ok: true, value: { revision: 0, value: {} } } },
    async mutate() { return { ok: true, value: { revision: 1, value: {} } } },
  }
  const authBackendRemote = {
    async snapshot() { return { ok: true, value: { revision: 0, backend: 'openzcode-app-server' } } },
    async mutate() { return { ok: true, value: { revision: 1, backend: 'openzcode-app-server' } } },
  }
  const services = {
    remote: {
      async $mount() {
        this.zcodeCaptcha = captchaRemote
        this.zcodeEntitlements = usageRemote
        this.zcodePrompts = promptRemote
        this.zcodeAuthBackend = authBackendRemote
      },
    },
    slots: {
      inject(_name, factory) { factory() },
      register(spec, component) {
        registrations.push({ spec, component })
        return { spec, component }
      },
    },
  }
  await plugin.apply({
    ...services,
    layout: { selectPanel() {} },
    get(name) {
      if (name === 'remote.zcodeCaptcha') return services.remote.zcodeCaptcha
      if (name === 'remote.zcodeEntitlements') return services.remote.zcodeEntitlements
      if (name === 'remote.zcodePrompts') return services.remote.zcodePrompts
      if (name === 'remote.zcodeAuthBackend') return services.remote.zcodeAuthBackend
      throw new Error(`unexpected service ${name}`)
    },
  })
  const overlay = registrations.find(value => value.spec.id === 'zcode-captcha').component
  const render = () => {
    hookIndex = 0
    overlay()
    while (pendingEffects.length > 0) pendingEffects.shift()()
  }

  render()
  await new Promise(resolve => setTimeout(resolve, 0))
  render()
  assert.equal(stale.removed, true, 'unmarked stale SDK node is replaced')
  assert.equal(created.length, 1)
  const fresh = created[0]
  assert.equal(fresh.src, 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js')
  assert.equal(fresh.dataset.zcodeAliyunCaptchaLoading, 'true')

  fresh.dispatch('error')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(fresh.removed, true, 'failed SDK node is removed so a later challenge can retry')
  for (const slot of effectSlots.slice().reverse()) slot?.cleanup?.()
})

test('client owns the entitlement panel and an additive Web UI captcha overlay', async () => {
  let registration
  const window = {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  }
  vm.runInNewContext(source, { window, Intl, Date, AbortController, setTimeout, clearTimeout })

  assert.equal(registration.id, '@local/zcode-provider')
  const plugin = registration.factory((name) => {
    if (name === 'react') return {
      createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
      Fragment: Symbol('Fragment'),
      useEffect(callback) { callback() },
      useState(initial) { return [initial, () => {}] },
    }
    assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives')
    return {
      IconCheckCircleOutlineRegular() {},
      IconGaugeOutlineRegular() {},
      IconRefreshOutlineRegular() {},
      IconWarningOutlineRegular() {},
    }
  })
  assert.deepEqual([...plugin.inject].sort(), ['layout', 'locale', 'remote', 'slots'])

  let contribution
  const registrations = []
  const requests = []
  const usageRemote = {
    snapshot: async request => ({
      ok: true,
      value: {
        fetchedAt: '',
        defaultProvider: 'builtin:bigmodel-start-plan',
        core: {
          accountProviders: {
            coding: {
              access: { mode: 'individual-coding-plan' },
              state: { availability: 'available', entitled: true },
            },
            start: {
              access: { mode: 'start-plan' },
              state: { availability: 'available', entitled: true },
            },
          },
          entitlements: {
            codingPlan: {
              remaining: { count: 27_983 },
              subscription: { details: [{ productName: 'GLM Coding Max' }] },
            },
            startPlan: {
              remaining: { count: 202_476_254 },
              subscription: { details: [{ productName: 'ZCode Weekend Build' }] },
            },
          },
          failures: [],
        },
      },
    }),
    usage: async request => {
      requests.push({ method: 'usage', request })
      return {
        ok: true,
        value: {
          fetchedAt: '',
          supplement: {
            modelUsage: {
              range: request.range,
              totalTokens: 27_983,
              totalCalls: 3,
              activeDays: 1,
              days: [],
              models: [],
            },
            mcpQuota: null,
            failures: [],
          },
        },
      }
    },
  }
  const snapshot = usageRemote.snapshot
  usageRemote.snapshot = async request => {
    requests.push({ method: 'snapshot', request })
    return snapshot(request)
  }
  const selectedPanels = []
  const captchaRemote = {
    claim: async () => ({ ok: true, value: { state: 'empty' } }),
    complete: async () => ({ ok: true, value: { accepted: true } }),
    release: async () => ({ ok: true, value: { released: true } }),
  }
  const promptRemote = {
    snapshot: async () => ({ ok: true, value: { revision: 0, value: {} } }),
    mutate: async request => ({ ok: true, value: { revision: 1, value: request.value } }),
  }
  const authBackendRemote = {
    snapshot: async () => ({ ok: true, value: { revision: 0, backend: 'openzcode-app-server' } }),
    mutate: async request => ({ ok: true, value: { revision: 1, backend: request.backend } }),
  }
  const messages = {
    available: 'Entitled',
    codingPlan: 'Coding Plan',
    openEntitlements: 'View ZCode entitlements',
    quotaUnknown: 'Quota unavailable',
    startPlan: 'Start Plan',
    unknown: 'Unknown',
  }
  const services = {
    locale: { bind: () => key => messages[key] ?? key, register: () => () => {} },
    remote: {
      async $mount(value) {
        contribution = value
        this.zcodeEntitlements = usageRemote
        this.zcodeCaptcha = captchaRemote
        this.zcodePrompts = promptRemote
        this.zcodeAuthBackend = authBackendRemote
      },
    },
    slots: {
      inject(_name, factory) { factory() },
      register(spec, component) {
        registrations.push({ spec, component })
        return { spec, component }
      },
    },
  }
  const ctx = {
    ...services,
    layout: { selectPanel(id) { selectedPanels.push(id) } },
    effect(callback) { callback() },
    get(name) {
      if (name === 'remote.zcodeEntitlements') return services.remote.zcodeEntitlements
      if (name === 'remote.zcodeCaptcha') return services.remote.zcodeCaptcha
      if (name === 'remote.zcodePrompts') return services.remote.zcodePrompts
      if (name === 'remote.zcodeAuthBackend') return services.remote.zcodeAuthBackend
      throw new Error(`unexpected service ${name}`)
    },
  }

  await plugin.apply(ctx)
  assert.equal(contribution.package, '@local/zcode-provider')
  assert.equal(
    JSON.stringify(contribution.descriptors.map(value => [value.namespace, value.method, value.parameters.length])),
    JSON.stringify([
      ['zcodeEntitlements', 'snapshot', 1],
      ['zcodeEntitlements', 'usage', 1],
      ['zcodeCaptcha', 'claim', 1],
      ['zcodeCaptcha', 'complete', 1],
      ['zcodeCaptcha', 'release', 1],
      ['zcodePrompts', 'snapshot', 0],
      ['zcodePrompts', 'mutate', 1],
      ['zcodeAuthBackend', 'snapshot', 0],
      ['zcodeAuthBackend', 'mutate', 1],
    ]),
  )
  assert.equal(
    JSON.stringify(contribution.descriptors.map(value => value.parameters[0]?.codec?.mode ?? null)),
    JSON.stringify(['strict', 'strict', 'strict', 'strict', 'strict', null, 'strict', null, 'strict']),
  )
  assert.equal(
    JSON.stringify(contribution.descriptors.map(value => value.cancellation ?? null)),
    JSON.stringify([{ parameter: 'signal' }, { parameter: 'signal' }, { parameter: 'signal' }, null, null, { parameter: 'signal' }, { parameter: 'signal' }, { parameter: 'signal' }, { parameter: 'signal' }]),
  )
  assert.deepEqual(
    registrations.map(value => `${value.spec.name}:${value.spec.id ?? value.spec.key}`).sort(),
    [
      'main:zcode-entitlements',
      'plugins\.bundle\.config:@local\/zcode-provider',
      'shell.overlay:zcode-captcha',
      'sidebar.panellist:zcode-entitlements',
    ],
  )
  assert.match(source, /const PROMPT_LAYERS = \/\* DSH_PROMPT_LAYERS \*\//)
  assert.match(source, /身份提示词/)
  assert.match(source, /Agent 主提示词/)
  assert.match(source, /运行时提示词模板/)
  assert.doesNotMatch(source, /type: 'range'/)
  assert.match(source, /role: 'switch'/)
  assert.match(source, /'aria-checked': placement === 'after'/)
  assert.match(source, /transform: placement === 'after' \? 'translateX\(100%\)' : 'translateX\(0\)'/)
  assert.doesNotMatch(source, /You are ZCode, an interactive coding agent/)
  assert.doesNotMatch(source, /data-zcode-system-prompts/)
  assert.doesNotMatch(source, /zcode-provider-prompts/)
  const promptEditor = registrations.find(value => value.spec.key === '@local/zcode-provider')
  assert.equal(typeof promptEditor.component, 'function')
  assert.match(source, /promptRemote\.mutate\(\{ value \}, signal\)/)
  assert.match(source, /提示词保存成功/)
  assert.match(source, /role: notice\.kind === 'error' \? 'alert' : 'status'/)
  assert.match(source, /notice\.kind === 'error' \? '#e38484' : '#79c39d'/)
  assert.match(source, /恢复官方默认/)
  assert.match(source, /后置＝覆写对应的官方块/)
  assert.match(source, /value\.trim\(\) === '' \? '' : value/)
  const captchaOverlay = registrations.find(value => value.spec.id === 'zcode-captcha')
  assert.equal(captchaOverlay.spec.name, 'shell.overlay')
  assert.equal(typeof captchaOverlay.component, 'function')
  assert.equal(registrations.find(value => value.spec.id === 'zcode-entitlement-status'), undefined)
})

test('package manifest declares the Web client and explicit peers', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(pkg.dsh.client, {
    platform: 'web',
    immediately: true,
  })
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.peerDependencies.react, '*')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-client-ui-primitives'], '*')
  assert.ok(pkg.files.includes('client.js'))
})
