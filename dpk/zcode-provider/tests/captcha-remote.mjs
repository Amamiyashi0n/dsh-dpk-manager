import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPTCHA_REMOTE_NAMESPACE,
  WebCaptchaBroker,
  createCaptchaRemoteService,
} from '../lib/captcha-remote.js'

const config = Object.freeze({ region: 'cn', prefix: 'prefix-fixture', sceneId: 'scene-fixture' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('claims are assigned atomically and a param is consumed exactly once', async () => {
  const broker = new WebCaptchaBroker({ timeoutMs: 500, availabilityWaitMs: 100 })
  const firstRequest = broker.request(config)
  const secondRequest = broker.request(config)

  const [firstClaim, secondClaim] = await Promise.all([
    broker.claim({ clientId: 'web-ui-a', waitMs: 0 }),
    broker.claim({ clientId: 'web-ui-b', waitMs: 0 }),
  ])
  assert.equal(firstClaim.state, 'challenge')
  assert.equal(secondClaim.state, 'challenge')
  if (firstClaim.state !== 'challenge' || secondClaim.state !== 'challenge') throw new Error('missing challenge')
  assert.notEqual(firstClaim.challenge.id, secondClaim.challenge.id)
  assert.deepEqual(firstClaim.challenge.config, config)
  assert.equal((await broker.claim({ clientId: 'web-ui-a', waitMs: 0 })).state, 'empty')

  assert.deepEqual(broker.complete({
    id: firstClaim.challenge.id,
    clientId: 'web-ui-b',
    result: { state: 'success', param: 'wrong-owner-param' },
  }), { accepted: false, status: 'rejected' })
  assert.deepEqual(broker.complete({
    id: firstClaim.challenge.id,
    clientId: 'web-ui-a',
    result: { state: 'success', param: '  PARAM-A  ' },
  }), { accepted: true })
  assert.deepEqual(broker.complete({
    id: firstClaim.challenge.id,
    clientId: 'web-ui-a',
    result: { state: 'success', param: 'PARAM-A-REUSED' },
  }), { accepted: false, status: 'expired' })
  assert.deepEqual(broker.complete({
    id: secondClaim.challenge.id,
    clientId: 'web-ui-b',
    result: { state: 'success', param: 'PARAM-B' },
  }), { accepted: true })

  const firstResult = await firstRequest
  const secondResult = await secondRequest
  assert.equal(firstResult.param, 'PARAM-A')
  assert.equal(firstResult.state, 'success')
  assert.equal(secondResult.param, 'PARAM-B')
  broker.dispose()
})

test('claimed but unfinished captcha expires as timeout', async () => {
  const broker = new WebCaptchaBroker({ timeoutMs: 25, availabilityWaitMs: 100 })
  const request = broker.request(config)
  const claim = await broker.claim({ clientId: 'web-ui', waitMs: 0 })
  assert.equal(claim.state, 'challenge')
  const result = await request
  assert.equal(result.state, 'timeout')
  assert.equal(result.param, '')
  if (claim.state === 'challenge') {
    assert.deepEqual(broker.complete({
      id: claim.challenge.id,
      clientId: 'web-ui',
      result: { state: 'success', param: 'late-param' },
    }), { accepted: false, status: 'expired' })
  }
  broker.dispose()
})

test('an aborted model request settles and invalidates its claimed challenge', async () => {
  const broker = new WebCaptchaBroker({ timeoutMs: 500, availabilityWaitMs: 100 })
  const controller = new AbortController()
  const request = broker.request(config, controller.signal)
  const claim = await broker.claim({ clientId: 'web-ui', waitMs: 0 })
  assert.equal(claim.state, 'challenge')
  controller.abort()
  const result = await request
  assert.equal(result.state, 'unavailable')
  assert.equal(result.param, '')
  assert.match(result.reason ?? '', /取消/)
  if (claim.state === 'challenge') {
    assert.deepEqual(broker.complete({
      id: claim.challenge.id,
      clientId: 'web-ui',
      result: { state: 'success', param: 'too-late' },
    }), { accepted: false, status: 'expired' })
  }
  broker.dispose()
})

test('a departing Web UI releases its claim so a replacement can complete it', async () => {
  const broker = new WebCaptchaBroker({ timeoutMs: 500, availabilityWaitMs: 25 })
  const request = broker.request(config)
  const first = await broker.claim({ clientId: 'departing-web-ui', waitMs: 0 })
  assert.equal(first.state, 'challenge')
  if (first.state !== 'challenge') throw new Error('missing first challenge')

  assert.deepEqual(broker.release({
    clientId: 'departing-web-ui',
    id: first.challenge.id,
  }), { released: true })
  assert.deepEqual(broker.release({
    clientId: 'departing-web-ui',
    id: first.challenge.id,
  }), { released: false })

  const replacement = await broker.claim({ clientId: 'replacement-web-ui', waitMs: 0 })
  assert.equal(replacement.state, 'challenge')
  if (replacement.state !== 'challenge') throw new Error('missing replacement challenge')
  assert.equal(replacement.challenge.id, first.challenge.id)
  assert.deepEqual(broker.complete({
    id: replacement.challenge.id,
    clientId: 'replacement-web-ui',
    result: { state: 'success', param: 'replacement-param' },
  }), { accepted: true })
  assert.equal((await request).param, 'replacement-param')

  assert.deepEqual(
    await broker.claim({ clientId: 'closing-long-poll', waitMs: 500 }),
    { state: 'empty', retryAfterMs: 2_000 },
  )
  assert.deepEqual(broker.release({ clientId: 'closing-long-poll' }), { released: false })
  broker.dispose()
})

test('an aborted idle poll cannot claim a later challenge', async () => {
  const broker = new WebCaptchaBroker({ timeoutMs: 500, availabilityWaitMs: 100 })
  const controller = new AbortController()
  const staleClaim = broker.claim({ clientId: 'stale-web-ui', waitMs: 500 }, controller.signal)
  try {
    controller.abort()
    const stale = await Promise.race([
      staleClaim,
      sleep(50).then(() => Symbol.for('claim-abort-timeout')),
    ])
    assert.notEqual(stale, Symbol.for('claim-abort-timeout'), 'aborted claim must resolve promptly')
    assert.deepEqual(stale, { state: 'empty', retryAfterMs: 2_000 })

    const request = broker.request(config)
    const live = await broker.claim({ clientId: 'live-web-ui', waitMs: 0 })
    assert.equal(live.state, 'challenge')
    if (live.state !== 'challenge') throw new Error('live Web UI did not receive the challenge')
    assert.deepEqual(broker.complete({
      id: live.challenge.id,
      clientId: 'live-web-ui',
      result: { state: 'success', param: 'live-param' },
    }), { accepted: true })
    assert.equal((await request).param, 'live-param')
  } finally {
    broker.dispose()
  }
})

test('idle claims finish immediately without occupying the Web UI connection pool', async () => {
  const broker = new WebCaptchaBroker({ timeoutMs: 500, availabilityWaitMs: 25 })
  try {
    const idleClaims = await Promise.all([
      broker.claim({ clientId: 'primary-web-ui', waitMs: 30_000 }),
      broker.claim({ clientId: 'stale-web-ui', waitMs: 30_000 }),
    ])
    assert.deepEqual(idleClaims, [
      { state: 'empty', retryAfterMs: 2_000 },
      { state: 'empty', retryAfterMs: 2_000 },
    ])

    const request = broker.request(config)
    const primaryClaim = await broker.claim({ clientId: 'primary-web-ui', waitMs: 30_000 })
    assert.equal(primaryClaim.state, 'challenge')
    if (primaryClaim.state !== 'challenge') throw new Error('primary client did not receive the challenge')
    assert.deepEqual(broker.complete({
      id: primaryClaim.challenge.id,
      clientId: 'primary-web-ui',
      result: { state: 'success', param: 'pool-safe-param' },
    }), { accepted: true })
    assert.equal((await request).param, 'pool-safe-param')
  } finally {
    broker.dispose()
  }
})

test('idle polling does not delay the pending challenge availability deadline', async () => {
  const broker = new WebCaptchaBroker({ timeoutMs: 500, availabilityWaitMs: 20 })
  try {
    assert.deepEqual(
      await broker.claim({ clientId: 'idle-web-ui', waitMs: 500 }, new AbortController().signal),
      { state: 'empty', retryAfterMs: 2_000 },
    )
    const request = broker.request(config)
    const watchdog = Symbol('availability-watchdog')
    const result = await Promise.race([
      request,
      sleep(120).then(() => watchdog),
    ])
    assert.notEqual(result, watchdog, 'idle polling must not pause the availability deadline')
    if (result === watchdog) throw new Error('availability deadline did not settle')
    assert.equal(result.state, 'unavailable')
  } finally {
    broker.dispose()
  }
})

test('one connected Web UI drains concurrent challenges serially without busy-timeout', async () => {
  const broker = new WebCaptchaBroker({ timeoutMs: 250, availabilityWaitMs: 10 })
  const firstRequest = broker.request(config)
  const first = await broker.claim({ clientId: 'single-web-ui', waitMs: 0 })
  assert.equal(first.state, 'challenge')
  if (first.state !== 'challenge') throw new Error('missing first challenge')

  const secondRequest = broker.request(config)
  const premature = await Promise.race([
    secondRequest.then(result => ({ settled: true, result })),
    sleep(30).then(() => ({ settled: false })),
  ])
  assert.equal(premature.settled, false, 'queued challenge must outlive availabilityWaitMs while a Web UI is busy')

  assert.deepEqual(broker.complete({
    id: first.challenge.id,
    clientId: 'single-web-ui',
    result: { state: 'success', param: 'first-param' },
  }), { accepted: true })
  const second = await broker.claim({ clientId: 'single-web-ui', waitMs: 0 })
  assert.equal(second.state, 'challenge')
  if (second.state !== 'challenge') throw new Error('missing queued challenge')
  assert.deepEqual(broker.complete({
    id: second.challenge.id,
    clientId: 'single-web-ui',
    result: { state: 'success', param: 'second-param' },
  }), { accepted: true })
  assert.equal((await firstRequest).param, 'first-param')
  assert.equal((await secondRequest).param, 'second-param')
  broker.dispose()
})

test('a request without a claiming Web UI returns unavailable promptly', async () => {
  const broker = new WebCaptchaBroker({ timeoutMs: 500, availabilityWaitMs: 10 })
  const result = await broker.request(config)
  assert.equal(result.state, 'unavailable')
  assert.equal(result.param, '')
  assert.match(result.reason ?? '', /Web UI/)
  broker.dispose()
})

test('the remote service follows the DSH Typert descriptor convention', async () => {
  const provided = new Map()
  const broker = new WebCaptchaBroker({ timeoutMs: 500, availabilityWaitMs: 100 })
  const service = createCaptchaRemoteService({
    provide(name, value) {
      provided.set(name, value)
    },
  }, broker)
  assert.equal(provided.get(CAPTCHA_REMOTE_NAMESPACE), service)
  assert.equal(service.typertRemote.service, service)
  assert.equal(service.typertRemote.namespace, CAPTCHA_REMOTE_NAMESPACE)
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(service),
    '@deepseek-ai/dsh-typert-protocol/remote-methods',
  )?.value
  assert.deepEqual(descriptor.methods, [
    { method: 'claim', invocation: { kind: 'direct' } },
    { method: 'complete', invocation: { kind: 'direct' } },
    { method: 'release', invocation: { kind: 'direct' } },
  ])
  broker.dispose()
})
