import assert from 'node:assert/strict'
import test from 'node:test'

import { createUsageRemoteService, USAGE_REMOTE_NAMESPACE } from '../lib/usage-remote.js'

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

test('usage Remote exposes split core and supplemental snapshots without credentials', async () => {
  const provided = new Map()
  const coreRefreshes = []
  const supplementRequests = []
  const entitlementSignals = []
  const supplementSignals = []
  const credentialSentinel = 'zcode-secret-must-never-cross-remote'
  const hostOnlyCredentials = { planApiKey: credentialSentinel }
  const ctx = {
    provide(name, service) {
      provided.set(name, service)
      return () => provided.delete(name)
    },
  }
  const service = createUsageRemoteService(ctx, async (force, signal) => {
    coreRefreshes.push(force)
    entitlementSignals.push(signal)
    assert.equal(hostOnlyCredentials.planApiKey, credentialSentinel)
    const { emptyUsageReport } = await import('../lib/usage.js')
    const report = emptyUsageReport()
    return {
      accountProviders: report.accountProviders,
      entitlements: report.entitlements,
      failures: report.failures,
    }
  }, async (range, force, signal) => {
    supplementRequests.push({ range, force })
    supplementSignals.push(signal)
    return { failures: [] }
  }, () => 'builtin:bigmodel-start-plan')

  assert.equal(provided.get(USAGE_REMOTE_NAMESPACE), service)
  assert.equal(service.typertRemote.service, service)
  assert.equal(service.typertRemote.namespace, USAGE_REMOTE_NAMESPACE)

  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(service),
    REMOTE_METHOD_DESCRIPTOR,
  )?.value
  assert.deepEqual(descriptor.methods, [
    { method: 'snapshot', invocation: { kind: 'direct' } },
    { method: 'usage', invocation: { kind: 'direct' } },
  ])

  const snapshot = await service.snapshot({ force: true })
  assert.deepEqual(coreRefreshes, [true])
  assert.match(snapshot.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(snapshot.defaultProvider, 'builtin:bigmodel-start-plan')
  assert.equal(snapshot.core.entitlements.codingPlan.quota, null)
  assert.equal(snapshot.core.accountProviders['account:bigmodel-individual-coding-plan'].state.availability, 'unknown')
  assert.equal(snapshot.core.failures.length, 0)

  const snapshotController = new AbortController()
  await service.snapshot({ force: true }, snapshotController.signal)
  assert.equal(entitlementSignals.at(-1), snapshotController.signal)

  const usage7 = await service.usage({ range: '7d', force: true })
  assert.match(usage7.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(usage7.supplement.failures.length, 0)
  assert.deepEqual(supplementRequests[0], { range: '7d', force: true })

  const usageController = new AbortController()
  await service.usage({ range: '7d', force: true }, usageController.signal)
  assert.equal(supplementSignals.at(-1), usageController.signal)

  await service.usage({ range: 'unexpected' })
  assert.deepEqual(supplementRequests.at(-1), { range: undefined, force: false })
  assert.doesNotMatch(JSON.stringify({ snapshot, usage7 }), new RegExp(credentialSentinel))
})
