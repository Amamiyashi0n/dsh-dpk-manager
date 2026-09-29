/**
 * Captcha protocol and DSH Web UI bridge tests.
 *
 * The suite is fully offline. It covers the ZCode request contract plus the
 * 3007 -> Web UI challenge -> one retry flow with an in-process Remote mock.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pkgRoot = join(import.meta.dirname, '..')
const captcha = await import(pathToFileURL(join(pkgRoot, 'lib', 'captcha.js')).href)

let passed = 0
const failures = []
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` - ${detail}`}`)
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` - ${detail}`}`)
  }
}

// ---- 1. Constants and request protocol ----
{
  check('constants: config endpoint', captcha.CAPTCHA_CONFIG_PATH === '/api/v1/client/configs', captcha.CAPTCHA_CONFIG_PATH)
  check('constants: param header', captcha.CAPTCHA_PARAM_HEADER === 'X-Aliyun-Captcha-Verify-Param', captcha.CAPTCHA_PARAM_HEADER)
  check('constants: region header', captcha.CAPTCHA_REGION_HEADER === 'X-Aliyun-Captcha-Verify-Region', captcha.CAPTCHA_REGION_HEADER)
  check('constants: SDK URL',
    captcha.ALIYUN_CAPTCHA_SDK_URL === 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
    captcha.ALIYUN_CAPTCHA_SDK_URL)
  check('constants: official DOM ids',
    captcha.CAPTCHA_DOM.container === 'zcode-aliyun-captcha-container'
      && captcha.CAPTCHA_DOM.element === 'zcode-aliyun-captcha-element'
      && captcha.CAPTCHA_DOM.button === 'zcode-aliyun-captcha-button',
    JSON.stringify(captcha.CAPTCHA_DOM))
  check('constants: config cache TTL', captcha.CAPTCHA_CONFIG_TTL_MS === 60_000, String(captcha.CAPTCHA_CONFIG_TTL_MS))
  check('constants: rejection code', captcha.CAPTCHA_REJECTION_CODE === '3007', captcha.CAPTCHA_REJECTION_CODE)
}

// ---- 2. Official p3() skip predicate ----
{
  const good = { enabled: true, region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' }
  check('skip: complete config continues', captcha.shouldSkipCaptcha(good) === false)
  check('skip: null', captcha.shouldSkipCaptcha(null) === true)
  check('skip: undefined', captcha.shouldSkipCaptcha(undefined) === true)
  check('skip: disabled', captcha.shouldSkipCaptcha({ ...good, enabled: false }) === true)
  check('skip: missing region', captcha.shouldSkipCaptcha({ ...good, region: undefined }) === true)
  check('skip: blank region', captcha.shouldSkipCaptcha({ ...good, region: '   ' }) === true)
  check('skip: missing prefix', captcha.shouldSkipCaptcha({ ...good, prefix: undefined }) === true)
  check('skip: missing scene id', captcha.shouldSkipCaptcha({ ...good, sceneId: undefined }) === true)
  check('skip: omitted enabled remains enabled', captcha.shouldSkipCaptcha({ region: 'cn', prefix: 'p', sceneId: 's' }) === false)
}

// ---- 3. Configuration envelope and headers ----
{
  const envelope = { code: 0, data: { configs: { captcha: { enabled: true, prefix: 'no8xfe', region: 'cn', sceneId: '11xygtvd' } } } }
  const read = captcha.readCaptchaConfig(envelope)
  check('read config: nested captcha object', read?.sceneId === '11xygtvd', JSON.stringify(read))
  check('read config: null returns null', captcha.readCaptchaConfig({ data: { configs: { captcha: null } } }) === null)
  check('read config: missing configs returns null', captcha.readCaptchaConfig({ data: {} }) === null)
  check('read config: non-object returns null', captcha.readCaptchaConfig({ data: { configs: { captcha: 'x' } } }) === null)

  const headers = captcha.captchaRequestHeaders({ region: 'cn' }, 'abc')
  check('headers: param', headers['X-Aliyun-Captcha-Verify-Param'] === 'abc', JSON.stringify(headers))
  check('headers: region', headers['X-Aliyun-Captcha-Verify-Region'] === 'cn', JSON.stringify(headers))
  check('headers: blank param omitted', Object.keys(captcha.captchaRequestHeaders({ region: 'cn' }, '  ')).length === 0)
  check('headers: trim param', captcha.captchaRequestHeaders(null, ' x ')['X-Aliyun-Captcha-Verify-Param'] === 'x')
}

// ---- 4. Official qDe() 3007 predicate ----
{
  check('rejection: numeric 3007', captcha.isCaptchaRejection('{"code":3007,"msg":"captcha verify failed"}') === true)
  check('rejection: string 3007', captcha.isCaptchaRejection('{"code":"3007"}') === true)
  check('rejection: other error', captcha.isCaptchaRejection('{"code":3012}') === false)
  check('rejection: normal response', captcha.isCaptchaRejection('{"type":"message_start"}') === false)
  check('rejection: HTML', captcha.isCaptchaRejection('<html>404</html>') === false)
}

// ---- 5. Config fetch cache and fail-open behavior ----
{
  captcha.resetCaptchaConfigCache()
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers })
    return Response.json({ data: { configs: { captcha: { enabled: true, region: 'cn', prefix: 'p', sceneId: 's' } } } })
  }
  const config = await captcha.fetchCaptchaConfig({
    endpointOrigin: 'https://zcode.z.ai', zcodeJwt: 'jwt', appVersion: '3.14.1', platform: 'win32-x64', fetch: fakeFetch,
  })
  check('fetch config: reads scene id', config?.sceneId === 's', JSON.stringify(config))
  check('fetch config: query shape',
    calls[0].url === 'https://zcode.z.ai/api/v1/client/configs?app_version=3.14.1&platform=win32-x64', calls[0].url)
  check('fetch config: bearer token', calls[0].headers.authorization === 'Bearer jwt', JSON.stringify(calls[0].headers))
  await captcha.fetchCaptchaConfig({ endpointOrigin: 'https://zcode.z.ai', zcodeJwt: 'jwt', appVersion: '3.14.1', platform: 'win32-x64', fetch: fakeFetch })
  check('fetch config: 60s cache', calls.length === 1, String(calls.length))

  captcha.resetCaptchaConfigCache()
  const failed = await captcha.fetchCaptchaConfig({
    endpointOrigin: 'https://other.z.ai', zcodeJwt: 'jwt', appVersion: '3.14.1', fetch: async () => { throw new Error('network down') },
  })
  check('fetch config: network failure is fail-open', failed === null)
  captcha.resetCaptchaConfigCache()
  const http500 = await captcha.fetchCaptchaConfig({
    endpointOrigin: 'https://third.z.ai', zcodeJwt: 'jwt', appVersion: '3.14.1', fetch: async () => new Response('nope', { status: 500 }),
  })
  check('fetch config: non-2xx is fail-open', http500 === null)

  captcha.resetCaptchaConfigCache()
  const deviceHeaders = []
  await captcha.fetchCaptchaConfig({
    endpointOrigin: 'https://device.z.ai', zcodeJwt: 'jwt', appVersion: '3.14.3', deviceMid: 'device-mid-fixture',
    fetch: async (_url, init) => { deviceHeaders.push(init.headers); return Response.json({ data: { configs: { captcha: null } } }) },
  })
  check('fetch config: device id', deviceHeaders[0]['x-device-mid'] === 'device-mid-fixture', JSON.stringify(deviceHeaders[0]))

  captcha.resetCaptchaConfigCache()
  const cancelledFetch = new AbortController()
  let resolveSharedFetch
  let sharedFetchCalls = 0
  const sharedFetch = async () => {
    sharedFetchCalls += 1
    return await new Promise(resolve => { resolveSharedFetch = resolve })
  }
  const cancelledWaiter = captcha.fetchCaptchaConfig({
    endpointOrigin: 'https://shared.z.ai', zcodeJwt: 'jwt', appVersion: '3.14.3', signal: cancelledFetch.signal, fetch: sharedFetch,
  })
  const survivingWaiter = captcha.fetchCaptchaConfig({
    endpointOrigin: 'https://shared.z.ai', zcodeJwt: 'jwt', appVersion: '3.14.3', fetch: sharedFetch,
  })
  cancelledFetch.abort(new Error('model request cancelled'))
  let cancelledEarly = false
  try { await cancelledWaiter } catch { cancelledEarly = true }
  check('fetch config: cancelled caller leaves shared read immediately', cancelledEarly)
  resolveSharedFetch(Response.json({ data: { configs: { captcha: { enabled: true, region: 'cn', prefix: 'p', sceneId: 's' } } } }))
  const sharedConfig = await survivingWaiter
  check('fetch config: cancellation does not cancel another caller', sharedConfig?.sceneId === 's', JSON.stringify(sharedConfig))
  await captcha.fetchCaptchaConfig({
    endpointOrigin: 'https://shared.z.ai', zcodeJwt: 'jwt', appVersion: '3.14.3', fetch: sharedFetch,
  })
  check('fetch config: surviving shared read fills cache', sharedFetchCalls === 1, String(sharedFetchCalls))
  captcha.resetCaptchaConfigCache()
}

// ---- 6. Solver port: skip, errors, and cancellation propagation ----
{
  const config = { enabled: true, region: 'cn', prefix: 'p', sceneId: 's' }
  const mockFetch = (captchaConfig) => async () => Response.json({ data: { configs: { captcha: captchaConfig } } })

  captcha.resetCaptchaConfigCache()
  const skipped = await captcha.solveCaptcha({
    endpointOrigin: 'https://skip.z.ai', zcodeJwt: 'j', appVersion: '1', fetch: mockFetch({ enabled: false }),
    solver: async () => { throw new Error('must not be called') },
  })
  check('solver: disabled config skips', skipped.state === 'no-config' && skipped.param === '', JSON.stringify(skipped))

  captcha.resetCaptchaConfigCache()
  const unavailable = await captcha.solveCaptcha({
    endpointOrigin: 'https://unavailable.z.ai', zcodeJwt: 'j', appVersion: '1', fetch: mockFetch(config),
  })
  check('solver: absent bridge returns unavailable', unavailable.state === 'unavailable' && unavailable.param === '', JSON.stringify(unavailable))

  captcha.resetCaptchaConfigCache()
  const controller = new AbortController()
  let receivedSignal
  const solved = await captcha.solveCaptcha({
    endpointOrigin: 'https://success.z.ai', zcodeJwt: 'j', appVersion: '1', fetch: mockFetch(config), signal: controller.signal,
    solver: async (current, signal) => {
      receivedSignal = signal
      return { param: 'PARAM-1', state: 'success', ms: 12, config: current }
    },
  })
  check('solver: success returns param', solved.param === 'PARAM-1' && solved.state === 'success', JSON.stringify(solved))
  check('solver: result carries config', solved.config?.region === 'cn', JSON.stringify(solved.config))
  check('solver: forwards request cancellation signal', receivedSignal === controller.signal)

  captcha.resetCaptchaConfigCache()
  const staleParam = await captcha.solveCaptcha({
    endpointOrigin: 'https://stale-param.z.ai', zcodeJwt: 'j', appVersion: '1', fetch: mockFetch(config),
    solver: async () => ({ param: 'MUST-NOT-RETRY', state: 'fail', ms: 1 }),
  })
  check('solver: non-success state clears stale verification param',
    staleParam.state === 'fail' && staleParam.param === '', JSON.stringify(staleParam))

  captcha.resetCaptchaConfigCache()
  const cancelledController = new AbortController()
  let resolveConfigRead
  const blockedSolve = captcha.solveCaptcha({
    endpointOrigin: 'https://cancelled-solve.z.ai', zcodeJwt: 'j', appVersion: '1', signal: cancelledController.signal,
    fetch: async () => await new Promise(resolve => { resolveConfigRead = resolve }),
    solver: async () => ({ param: 'not-reached', state: 'success', ms: 1 }),
  })
  cancelledController.abort()
  const cancelledSolve = await blockedSolve
  check('solver: cancellation during config read returns unavailable promptly',
    cancelledSolve.state === 'unavailable' && cancelledSolve.param === '', JSON.stringify(cancelledSolve))
  resolveConfigRead(Response.json({ data: { configs: { captcha: config } } }))
  await new Promise(resolve => setTimeout(resolve, 0))

  captcha.resetCaptchaConfigCache()
  const threw = await captcha.solveCaptcha({
    endpointOrigin: 'https://error.z.ai', zcodeJwt: 'j', appVersion: '1', fetch: mockFetch(config),
    solver: async () => { throw new Error('boom') },
  })
  check('solver: exception is normalized', threw.state === 'error' && threw.param === '', JSON.stringify(threw))
  captcha.resetCaptchaConfigCache()
}

// ---- 7. Failure guidance and one-retry predicate ----
{
  const guidance = [
    [{ param: '', state: 'no-config', ms: 0 }, /skip|跳过/i],
    [{ param: '', state: 'unavailable', ms: 0 }, /DSH Web UI/],
    [{ param: '', state: 'timeout', ms: 0 }, /DSH Web UI.*超时/],
    [{ param: '', state: 'fail', verifyCode: 'F001', ms: 0 }, /F001.*无痕/],
    [{ param: '', state: 'fail', verifyCode: 'F008', ms: 0 }, /一次性/],
    [{ param: '', state: 'error', reason: 'x', ms: 0 }, /x/],
  ]
  for (const [result, pattern] of guidance) {
    const text = captcha.describeCaptchaFailure(result)
    check(`guidance: ${result.state}`, pattern.test(text), text)
  }

  const rejected = '{"code":3007,"msg":"captcha verify failed"}'
  check('retry: start-plan + 3007', captcha.shouldRetryWithCaptcha('start-plan', rejected) === true)
  check('retry: off-peak + 3007', captcha.shouldRetryWithCaptcha('off-peak', rejected) === true)
  check('retry: other status is excluded', captcha.shouldRetryWithCaptcha('start-plan', '{"code":3012}') === false)
  check('retry: other route is excluded', captcha.shouldRetryWithCaptcha('individual-coding-plan', rejected) === false)
}

// ---- 8. Host integration: 3007 -> Remote challenge -> one retry ----
{
  const { apply } = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)
  const route = {
    route: 'fixture-start-plan',
    display: 'Fixture Start Plan',
    kind: 'anthropic',
    baseURL: 'https://fixture.zcode.test/api/v1/zcode-plan/anthropic',
    apiKey: 'fixture-jwt',
    models: [{ id: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 128_000, efforts: ['low', 'max'], defaultEffort: 'max' }],
    family: 'bigmodel',
    access: { type: 'zhipu-account', mode: 'start-plan' },
    credential: 'zcode-jwt',
  }
  const adapters = new Map()
  const remotes = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, debug() {}, warn() {} },
    get() { return undefined },
    inject() { return { dispose() {} } },
    provide(name, service) { remotes.set(name, service) },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    llm: {
      registerAdapter(routes, adapter) { for (const name of routes) adapters.set(name, adapter) },
      registerConfigurableProviders() {},
    },
    fiber: { entry: { options: { id: 'zcode-provider-test' } } },
  }
  const requests = []
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.includes('/api/v1/client/configs')) {
      return Response.json({ data: { configs: { captcha: { enabled: true, region: 'cn', prefix: 'fixture-prefix', sceneId: 'fixture-scene' } } } })
    }
    if (href.includes('/v1/messages')) {
      requests.push({ url: href, headers: init?.headers ?? {} })
      if (requests.length === 1 || requests.length === 3) {
        return new Response('{"code":3007,"msg":"captcha verify failed"}', { status: 400 })
      }
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json({ code: 0, data: { plans: [], balances: [], limits: [] } })
  }

  try {
    captcha.resetCaptchaConfigCache()
    await apply(ctx, {
      providerConfigPath: join(pkgRoot, 'tests', 'fixtures', 'missing-device-config.json'),
      credentialsPath: join(pkgRoot, 'tests', 'fixtures', 'credentials.json'),
      telemetryStatePath: join(pkgRoot, 'tests', 'fixtures', 'telemetry-state.json'),
      endpointOrigin: 'https://fixture.zcode.test',
      signingEnabled: false,
      routes: { [route.route]: route },
    })
    const adapter = adapters.get(route.route)
    const remote = remotes.get('zcodeCaptcha')
    check('integration: adapter is registered', adapter !== undefined, [...adapters.keys()].join(','))
    check('integration: captcha Remote is registered once', remote !== undefined, [...remotes.keys()].join(','))

    const responseTask = (async () => {
      try {
        for await (const _chunk of adapter.stream({
          provider: route.route, model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'ping' }],
        })) {}
        return undefined
      } catch (error) {
        return error
      }
    })()
    const claimed = await remote.claim({ clientId: 'captcha-test-client', waitMs: 1_000 })
    check('integration: Web UI claims a challenge', claimed.state === 'challenge', JSON.stringify(claimed))
    check('integration: challenge exposes only captcha config',
      claimed.challenge?.config?.region === 'cn'
        && claimed.challenge?.config?.prefix === 'fixture-prefix'
        && claimed.challenge?.config?.sceneId === 'fixture-scene',
      JSON.stringify(claimed))
    const completed = await remote.complete({
      id: claimed.challenge.id,
      clientId: 'captcha-test-client',
      result: { param: 'fixture-param', state: 'success', ms: 3 },
    })
    check('integration: Remote accepts the one-time result', completed.accepted === true, JSON.stringify(completed))
    const streamError = await responseTask
    check('integration: retry response is consumed', streamError === undefined, String(streamError))

    const failedCaptchaTask = (async () => {
      try {
        for await (const _chunk of adapter.stream({
          provider: route.route, model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'fail-param' }],
        })) {}
        return undefined
      } catch (error) {
        return error
      }
    })()
    const failedClaim = await remote.claim({ clientId: 'captcha-test-client', waitMs: 1_000 })
    check('integration: Web UI claims a second challenge', failedClaim.state === 'challenge', JSON.stringify(failedClaim))
    const failedCompletion = await remote.complete({
      id: failedClaim.challenge.id,
      clientId: 'captcha-test-client',
      // Deliberately include stale data: only `success` is allowed to retry.
      result: { param: 'STALE-PARAM', state: 'fail', verifyCode: 'F001' },
    })
    check('integration: Host accepts a terminal failed captcha callback', failedCompletion.accepted === true, JSON.stringify(failedCompletion))
    const failedStreamError = await failedCaptchaTask
    check('integration: failed captcha leaves original 3007 visible', failedStreamError !== undefined, String(failedStreamError))
  } finally {
    globalThis.fetch = originalFetch
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }

  check('integration: exactly one retry follows successful 3007', requests.length === 3, `requests=${requests.length}`)
  const [first, second, failed] = requests
  check('integration: first request has no captcha header', first?.headers['X-Aliyun-Captcha-Verify-Param'] === undefined, JSON.stringify(first?.headers))
  check('integration: retry includes param', second?.headers['X-Aliyun-Captcha-Verify-Param'] === 'fixture-param', JSON.stringify(second?.headers))
  check('integration: retry includes region', second?.headers['X-Aliyun-Captcha-Verify-Region'] === 'cn', JSON.stringify(second?.headers))
  check('integration: failed captcha with stale param does not retry',
    failed?.headers['X-Aliyun-Captcha-Verify-Param'] === undefined, JSON.stringify(failed?.headers))
}

console.log(`\n${passed}/${passed + failures.length} assertions passed`)
if (failures.length) {
  console.error(`\nFailures:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
