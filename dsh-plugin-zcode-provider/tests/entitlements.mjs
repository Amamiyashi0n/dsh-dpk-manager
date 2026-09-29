import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accountProviderSnapshot,
  buildCodingPlanSnapshot,
  buildMcpQuotaSnapshot,
  normalizeQuota,
  parseCodingPlanEntitlement,
  reconcileUsageReport,
  resolveStartPlanBalance,
} from '../lib/entitlements.js'

test('Coding Plan subscription is authoritative and quota preserves official detail fields', () => {
  const entitlement = parseCodingPlanEntitlement({
    code: 200,
    data: [{
      productId: 'coding-max', productName: 'GLM Coding Max', status: 'VALID',
      inCurrentPeriod: true, billingCycle: 'monthly', autoRenew: 1,
      nextRenewTime: '2026-10-01 00:00:00', valid: '2026-09-01 00:00:00-2026-10-01 00:00:00',
    }],
  })
  const quota = normalizeQuota({
    code: 200,
    data: {
      level: 'Max',
      limits: [{
        type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 20,
        remaining: 80, percentage: 20,
        usageDetails: [{ modelCode: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', usage: 20 }],
      }],
    },
  })
  const snapshot = buildCodingPlanSnapshot({
    authenticated: true,
    configured: true,
    entitlement,
    provider: { id: 'account:bigmodel-individual-coding-plan', name: 'BigModel Coding Plan' },
    quota,
  })

  assert.equal(entitlement.kind, 'available')
  assert.equal(snapshot.unavailableReason, undefined)
  assert.equal(snapshot.subscription?.details[0]?.productName, 'GLM Coding Max')
  assert.equal(snapshot.quota?.level, 'Max')
  assert.deepEqual(snapshot.quota?.limits[0]?.usageDetails, [
    { modelCode: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', usage: 20 },
  ])
})

test('quota presence never manufactures Coding Plan entitlement', () => {
  const entitlement = parseCodingPlanEntitlement({ code: 200, data: [] })
  const quota = normalizeQuota({ code: 200, data: { level: 'Free', limits: [{ type: 'TOKENS_LIMIT', remaining: 99 }] } })
  const snapshot = buildCodingPlanSnapshot({
    authenticated: true,
    configured: true,
    entitlement,
    provider: { id: 'account:bigmodel-individual-coding-plan', name: 'BigModel Coding Plan' },
    quota,
  })

  assert.equal(entitlement.kind, 'unavailable')
  assert.equal(snapshot.unavailableReason, 'no_plan')
  assert.equal(snapshot.subscription, null)
  assert.equal(snapshot.quota?.limits[0]?.remaining, 99)
})

test('malformed Coding product stays unknown instead of becoming no-plan', () => {
  assert.deepEqual(
    parseCodingPlanEntitlement({ code: 200, data: [{ productId: 'coding-broken' }] }),
    { kind: 'unknown' },
  )
})

test('Start Plan balance maps plans, buckets, model whitelist and pending state', () => {
  const available = resolveStartPlanBalance({
    code: 0,
    data: {
      server_time: 100,
      plans: [{
        user_plan_id: 'up', plan_id: 'zcode-v3-start-plan', name: 'Start Plan', status: 'active',
        starts_at: 90, ends_at: 200,
        entitlements: [{ entitlement_id: 'e', show_name: 'GLM Flash', period: 'daily', effective_at: 90 }],
      }],
      balances: [{
        bucket_id: 'b', user_plan_id: 'up', plan_id: 'zcode-v3-start-plan', entitlement_id: 'e',
        show_name: 'GLM Flash', meter: 'model_usage', unit_type: 'token', capabilities: ['model:glm-5.3-flash'],
        total_units: '1000', used_units: '250', remaining_units: '750', period_start: 90, period_end: 200, expires_at: 200,
      }],
    },
  }, { id: 'account:bigmodel-start-plan', name: 'BigModel Start Plan' }, 100_000)

  assert.equal(available.status, 'available')
  assert.deepEqual(available.models, ['glm-5.3-flash'])
  assert.equal(available.snapshot.serverTime, 100_000)
  assert.equal(available.snapshot.quota?.limits[0]?.bucketId, 'b')
  assert.equal(available.snapshot.quota?.limits[0]?.period, 'daily')
  assert.equal(available.snapshot.quota?.limits[0]?.remaining, 750)

  const pending = resolveStartPlanBalance({
    code: 0,
    data: {
      server_time: 100,
      plans: [{
        plan_id: 'zcode-v3-start-plan', name: 'Start Plan', status: 'active',
        entitlements: [{ entitlement_id: 'future', effective_at: 150 }],
      }],
      balances: [],
    },
  }, { id: 'account:bigmodel-start-plan', name: 'BigModel Start Plan' }, 100_000)
  assert.equal(pending.status, 'pending')
  assert.equal(pending.effectiveAt, 150)
})

test('MCP aggregate and account provider state preserve official semantics', () => {
  const mcp = buildMcpQuotaSnapshot({
    code: 0,
    data: { server_time: 100, next_refresh_at: 200, level: 'Max', total_usage: { used: 25, limit: 100, remaining: 75 } },
  }, { providerFamily: 'bigmodel', targetType: 'PERSONAL' })
  assert.equal(mcp?.aggregate.type, 'MCP_USAGE_LIMIT')
  assert.equal(mcp?.aggregate.number, 100)
  assert.equal(mcp?.aggregate.percentage, 25)
  assert.equal(mcp?.aggregate.nextResetTime, 200_000)

  const provider = accountProviderSnapshot({
    accountType: 'bigmodel', mode: 'individual-coding-plan', status: 'available',
    current: true, connectionKey: 'fixture',
  })
  assert.deepEqual(provider.access, {
    type: 'zhipu-account', accountType: 'bigmodel', mode: 'individual-coding-plan', entitled: true,
  })
  assert.equal(provider.state.availability, 'available')
  assert.equal(provider.state.entitled, true)
  assert.equal(provider.state.current, true)
})

test('unknown refresh retains last-known-good entitlement for the same account only', () => {
  const availableProvider = accountProviderSnapshot({
    accountType: 'bigmodel', mode: 'individual-coding-plan', status: 'available',
    current: true, connectionKey: 'account-a',
  })
  const unknownProvider = accountProviderSnapshot({
    accountType: 'bigmodel', mode: 'individual-coding-plan', status: 'unknown',
    current: true, connectionKey: 'account-a',
  })
  const changedAccount = accountProviderSnapshot({
    accountType: 'bigmodel', mode: 'individual-coding-plan', status: 'unknown',
    current: true, connectionKey: 'account-b',
  })
  const codingPlan = buildCodingPlanSnapshot({
    authenticated: true,
    configured: true,
    entitlement: {
      kind: 'available',
      subscription: {
        identityType: 'unknown', identityMasked: null,
        details: [{ productId: 'coding-max', productName: 'Coding Max', purchaseTime: null, beginTime: null, expireTime: null }],
      },
    },
    provider: { id: 'account:bigmodel-individual-coding-plan', name: 'BigModel Coding Plan' },
    quota: null,
    generatedAt: 1,
  })
  const unavailable = buildCodingPlanSnapshot({
    authenticated: true,
    configured: true,
    entitlement: { kind: 'unknown' },
    provider: { id: 'account:bigmodel-individual-coding-plan', name: 'BigModel Coding Plan' },
    quota: null,
    generatedAt: 2,
  })
  const previous = {
    accountProviders: { 'account:bigmodel-individual-coding-plan': availableProvider },
    entitlements: { codingPlan, startPlan: unavailable },
    failures: [],
  }
  const refresh = {
    accountProviders: { 'account:bigmodel-individual-coding-plan': unknownProvider },
    entitlements: { codingPlan: unavailable, startPlan: unavailable },
    failures: [{ source: 'subscription', reason: '503' }],
  }
  const retained = reconcileUsageReport(refresh, previous)
  assert.equal(retained.accountProviders['account:bigmodel-individual-coding-plan'].state.entitled, true)
  assert.equal(retained.accountProviders['account:bigmodel-individual-coding-plan'].state.availability, 'available')
  assert.equal(retained.entitlements.codingPlan.subscription?.details[0]?.productName, 'Coding Max')
  assert.equal(retained.failures.length, 1)

  const reset = reconcileUsageReport({
    ...refresh,
    accountProviders: { 'account:bigmodel-individual-coding-plan': changedAccount },
  }, previous)
  assert.equal(reset.accountProviders['account:bigmodel-individual-coding-plan'].state.entitled, false)
  assert.equal(reset.entitlements.codingPlan.subscription, null)
})
