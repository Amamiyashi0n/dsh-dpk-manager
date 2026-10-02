import assert from 'node:assert/strict'
import test from 'node:test'

const { DiagnosticLog, createDiagnosticsRemoteService } = await import('../lib/diagnostics.js')
const { fetchEntitlementReport } = await import('../lib/usage.js')

test('diagnostic log is bounded and redacts credential-shaped values', () => {
  const redactionLog = new DiagnosticLog()
  redactionLog.updateContext({ endpointOrigin: 'https://zcode.z.ai', apiKey: 'secret-context-value' })
  redactionLog.record({
    level: 'error',
    phase: 'quota',
    message: 'request failed Authorization: Bearer secret-token api_key=secret-key eyJhbGciOiJ.fake.signature',
    details: { apiKey: 'secret', endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit' },
  })
  const redacted = redactionLog.snapshot()
  assert.match(redacted.entries[0].message, /\[redacted\]/)
  assert.doesNotMatch(JSON.stringify(redacted), /secret-token|secret-context-value|secret-key|fake\.signature/)
  assert.equal(redacted.entries[0].details.apiKey, '[redacted]')

  redactionLog.record({ level: 'info', phase: 'route-discovery', message: 'presence', details: { hasPlanApiKey: true, hasJwt: false } })
  assert.equal(redactionLog.snapshot().entries[1].details.hasPlanApiKey, true)
  assert.equal(redactionLog.snapshot().entries[1].details.hasJwt, false)

  redactionLog.record({ level: 'info', phase: 'route-discovery', message: 'credential source', details: {
    codingPlanCredential: 'credential-store', startPlanCredential: 'zcode-jwt', missingCredential: null,
    leakedCredential: 'actual-secret',
  } })
  assert.equal(redactionLog.snapshot().entries[2].details.codingPlanCredential, 'credential-store')
  assert.equal(redactionLog.snapshot().entries[2].details.startPlanCredential, 'zcode-jwt')
  assert.equal(redactionLog.snapshot().entries[2].details.missingCredential, null)
  assert.equal(redactionLog.snapshot().entries[2].details.leakedCredential, '[redacted]')

  const log = new DiagnosticLog(2)
  log.record({ level: 'info', phase: 'second', message: 'second' })
  log.record({ level: 'debug', phase: 'third', message: 'third' })
  const snapshot = log.snapshot()
  assert.equal(snapshot.entries.length, 2)
  assert.equal(snapshot.entries[0].phase, 'second')
})

test('HTTP diagnostics preserve safe response fields and device presence', async () => {
  const events = []
  const report = await fetchEntitlementReport({
    endpointOrigin: 'https://zcode.z.ai',
    appVersion: 'fixture',
    zcodeJwt: 'jwt-fixture',
    deviceMid: 'device-fixture',
    diagnostics: { record(event) { events.push(event) } },
    fetch: async () => new Response(JSON.stringify({ code: 3001, msg: 'parameter error', request_id: 'req-1' }), { status: 400 }),
  })
  assert.match(report.failures.find(failure => failure.source === 'start-plan').reason, /HTTP 400 code=3001 msg=parameter error request_id=req-1/)
  const start = events.find(event => event.phase === 'start-plan')
  assert.equal(start.details.hasDeviceMid, true)
  assert.doesNotMatch(JSON.stringify(events), /jwt-fixture|device-fixture/)
})

test('diagnostics Remote exposes bounded snapshots and clear', async () => {
  const log = new DiagnosticLog()
  log.record({ level: 'warn', phase: 'startup', message: 'fixture' })
  let provided
  const service = createDiagnosticsRemoteService({ provide(_name, value) { provided = value } }, log)
  assert.equal(provided, service)
  assert.equal(service.typertRemote.namespace, 'zcodeDiagnostics')
  assert.equal((await service.snapshot({ limit: 1 })).entries.length, 1)
  assert.equal((await service.clear()).entries.length, 0)
})

test('missing Coding Plan origin creates a useful, credential-free event', async () => {
  const events = []
  const report = await fetchEntitlementReport({
    endpointOrigin: 'https://zcode.z.ai',
    appVersion: 'fixture',
    bigmodelBaseURL: 'not a URL',
    planApiKey: 'secret-plan-key',
    diagnostics: { record(event) { events.push(event) } },
  })
  assert.equal(report.failures[0].reason, 'baseURL 无法推导 origin')
  const route = events.find(event => event.phase === 'route-discovery')
  assert.equal(route.details.baseURL, 'not a URL')
  assert.equal(route.details.hasPlanApiKey, true)
  assert.doesNotMatch(JSON.stringify(events), /secret-plan-key/)
})
