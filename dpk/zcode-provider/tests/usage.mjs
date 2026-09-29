/**
 * 权益/用量模块测试:用桩 fetch 校验解析口径与官方一致,并对真实端点做一次端到端取数。
 * 用法:node tests/usage.mjs [--live]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const usage = await import(pathToFileURL(join(pkgRoot, 'lib', 'usage.js')).href)

const failures = []
let passed = 0
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${label}  ${detail}`) }
}

// ---- 1. 时间窗口(官方 formatMonitorDateTime / resolveUsageTimeRange) ----
{
  const now = new Date(2026, 8, 26, 14, 30, 0) // 2026-09-26 14:30 本地
  const r = usage.monitorRange(7, now)
  check('窗口:endTime 为当天 23:59:59', r.endTime === '2026-09-26 23:59:59', r.endTime)
  check('窗口:7 天含当天(起点 09-20 00:00:00)', r.startTime === '2026-09-20 00:00:00', r.startTime)
  const one = usage.monitorRange(1, now)
  check('窗口:1 天只剩当天', one.startTime === '2026-09-26 00:00:00' && one.endTime === '2026-09-26 23:59:59', JSON.stringify(one))
  const capped = usage.monitorRange(90, now)
  check('窗口:上限 30 天(官方 MONITOR_MAX_RANGE_DAYS)', capped.startTime === '2026-08-28 00:00:00', capped.startTime)
  check('窗口:格式为 YYYY-MM-DD HH:mm:ss', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.startTime), r.startTime)
  // 官方 resolveUsageTimeRange 只认 7d/30d,其他(含 today)落到 MONITOR_DEFAULT_RANGE_DAYS=30
  check('窗口:7d → 7 天', usage.monitorRangeDays('7d') === 7, String(usage.monitorRangeDays('7d')))
  check('窗口:30d → 30 天', usage.monitorRangeDays('30d') === 30, String(usage.monitorRangeDays('30d')))
  check('窗口:未指定 → 官方默认 30 天(不是 7)', usage.monitorRangeDays(undefined) === 30, String(usage.monitorRangeDays(undefined)))
  check('窗口:MONITOR_DEFAULT_RANGE_DAYS = 30(与官方常量一致)', usage.MONITOR_DEFAULT_RANGE_DAYS === 30, String(usage.MONITOR_DEFAULT_RANGE_DAYS))
  const d30 = usage.monitorRange(usage.monitorRangeDays('30d'), now)
  check('窗口:30 天窗口起点 = 08-28', d30.startTime === '2026-08-28 00:00:00', d30.startTime)
}

// ---- 2b. model-usage 窗口解析(官方 buildUsageStatsSnapshotFromMonitor) ----
{
  const payload = {
    code: 200,
    data: {
      granularity: 'daily',
      x_time: ['2026-09-24', '2026-09-25', '2026-09-26'],
      tokensUsage: [100, 0, 500],
      modelCallCount: [2, 0, 7],
      modelSummaryList: [{ modelName: 'TOPLEVEL-IGNORED', totalTokens: 999 }],
      totalUsage: {
        totalModelCallCount: 9,
        totalTokensUsage: 600,
        modelSummaryList: [
          { modelName: 'GLM-5.3', totalTokens: 100, sortOrder: 1 },
          { modelName: 'GLM-5.3-Flash', totalTokens: 500, sortOrder: 2 },
        ],
      },
    },
  }
  const w = usage.parseModelUsage(payload, '7d')
  check('窗口用量:回填 range', w.range === '7d', w.range)
  check('窗口用量:逐日序列与 x_time 等长', w.days.length === 3, String(w.days.length))
  check('窗口用量:逐日取 tokensUsage/modelCallCount', w.days[2].tokens === 500 && w.days[2].calls === 7, JSON.stringify(w.days[2]))
  check('窗口用量:缺值补 0', w.days[0].tokens === 100 && w.days[1].tokens === 0 && w.days[1].calls === 0)
  check('窗口用量:总量取 totalUsage', w.totalTokens === 600 && w.totalCalls === 9, `${w.totalTokens}/${w.totalCalls}`)
  check('窗口用量:模型明细优先 totalUsage.modelSummaryList(忽略顶层)',
    w.models.length === 2 && !w.models.some((m) => m.modelId === 'TOPLEVEL-IGNORED'),
    w.models.map((m) => m.modelId).join(','))
  check('窗口用量:模型按 token 降序', w.models[0].modelId === 'GLM-5.3-Flash' && w.models[1].modelId === 'GLM-5.3',
    w.models.map((m) => m.modelId).join(','))
  check('窗口用量:share = 本模型/总量', Math.abs(w.models[0].share - 500 / 600) < 1e-9, String(w.models[0].share))
  check('窗口用量:活跃天数只算有消耗的', w.activeDays === 2, String(w.activeDays))
  check('窗口用量:峰值日 = 消耗最高那天', w.mostActiveDay?.date === '2026-09-26' && w.mostActiveDay.tokens === 500,
    JSON.stringify(w.mostActiveDay))

  // 顶层 modelSummaryList 是 totalUsage 缺失时的回退
  const fallback = usage.parseModelUsage({
    code: 200,
    data: { x_time: ['2026-09-26'], tokensUsage: [10], modelCallCount: [1], modelSummaryList: [{ modelName: 'GLM-5.2', totalTokens: 10 }] },
  }, '30d')
  check('窗口用量:totalUsage 缺失时回退顶层 modelSummaryList',
    fallback.models.length === 1 && fallback.models[0].modelId === 'GLM-5.2', JSON.stringify(fallback.models))
  check('窗口用量:无 totalUsage 时总量为 0 且 share 不除零',
    fallback.totalTokens === 0 && fallback.models[0].share === 0, `${fallback.totalTokens}/${fallback.models[0].share}`)
  check('窗口用量:全 0 消耗时不设峰值日',
    usage.parseModelUsage({ code: 200, data: { x_time: ['a'], tokensUsage: [0], modelCallCount: [0] } }, '7d').mostActiveDay === undefined)
  let threw = false
  try { usage.parseModelUsage({ code: 500, msg: 'boom' }, '7d') } catch { threw = true }
  check('窗口用量:非 200 code 抛错', threw)
}

// ---- 2c. token 数的中文紧凑渲染 ----
{
  check('渲染 token:亿级', usage.formatTokens(10422667138) === '104.23亿', usage.formatTokens(10422667138))
  check('渲染 token:万级', usage.formatTokens(12345) === '1.2万', usage.formatTokens(12345))
  check('渲染 token:小数保留原数', usage.formatTokens(999) === '999', usage.formatTokens(999))
  check('渲染 token:0', usage.formatTokens(0) === '0', usage.formatTokens(0))
  check('渲染 token:非法值给 -', usage.formatTokens(Number.NaN) === '-')
}

// ---- 2. quota/limit 解析(官方 normalizeLimits) ----
{
  const payload = {
    code: 200,
    data: {
      level: 'max',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 39, remaining: 27960, percentage: 1, nextResetTime: 1790371912675 },
        { type: '', usage: 1 },
        { notType: true },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 86301, remaining: 53698, percentage: 61 },
      ],
    },
  }
  const limits = usage.normalizeLimits(payload)
  check('quota:过滤无 type 的条目', limits.length === 2, String(limits.length))
  check('quota:保留数值字段', limits[0].remaining === 27960 && limits[0].nextResetTime === 1790371912675)
  let threw = false
  try { usage.normalizeLimits({ code: 401, msg: '令牌已过期或验证不正确' }) } catch { threw = true }
  check('quota:非 200 code 抛错(JWT 打该端点会 401)', threw)
  check('quota:limits 非数组时返回空', usage.normalizeLimits({ code: 200, data: {} }).length === 0)
}

// ---- 5. 端点与鉴权(桩 fetch 断言请求形状) ----
{
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers })
    if (String(url).includes('/quota/limit')) {
      return new Response(JSON.stringify({ code: 200, data: { limits: [{ type: 'CREDIT_LIMIT', unit: 6, usage: 140000, currentValue: 86301, remaining: 53699, percentage: 61 }] } }), { status: 200 })
    }
    if (String(url).includes('/subscription/list')) {
      return new Response(JSON.stringify({ code: 200, data: [{ productId: 'p', productName: 'Coding', status: 'VALID', inCurrentPeriod: true }] }), { status: 200 })
    }
    if (String(url).includes('/model-usage')) {
      return new Response(JSON.stringify({
        code: 200,
        data: {
          x_time: ['2026-09-25', '2026-09-26'],
          tokensUsage: [100, 500],
          modelCallCount: [1, 3],
          totalUsage: { totalTokensUsage: 600, totalModelCallCount: 4, modelSummaryList: [{ modelName: 'GLM-5.3-Flash', totalTokens: 600 }] },
        },
      }), { status: 200 })
    }
    if (String(url).includes('billing/balance')) {
      return Response.json({
        code: 0,
        data: {
          server_time: 1790418166,
          plans: [{
            user_plan_id: 'up1', plan_id: 'zcode-v3-start-plan', name: 'ZCode Weekend Build', status: 'active',
            starts_at: 1790254626, ends_at: 1790557200,
            entitlements: [{ entitlement_id: 'e1', show_name: 'GLM-5.3-Flash', period: 'one_time', effective_at: 1790254626 }],
          }],
          balances: [{
            bucket_id: 'b1', user_plan_id: 'up1', plan_id: 'zcode-v3-start-plan', entitlement_id: 'e1',
            show_name: 'GLM-5.3-Flash', meter: 'model_usage', unit_type: 'token',
            capabilities: ['model:glm-5.3-flash'], total_units: 300000000, used_units: 1000,
            remaining_units: 299999000, expires_at: 1790557200,
          }],
        },
      })
    }
    if (String(url).includes('/mcp/usage')) {
      return Response.json({ code: 0, data: { server_time: 1790418166, next_refresh_at: 1790500000, level: 'Max', total_usage: { used: 5, limit: 100, remaining: 95 } } })
    }
    return new Response('{}', { status: 404 })
  }
  const report = await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn',
    endpointOrigin: 'https://zcode.z.ai',
    appVersion: '3.14.1',
    planApiKey: 'plan-key',
    zcodeJwt: 'jwt-token',
    oauthAccessToken: 'oauth-token',
    accountFamily: 'bigmodel',
    activeProvider: 'bigmodel',
    deviceMid: 'device-mid-fixture',
    fetch: fakeFetch,
  })
  check('取数:五个端点各调一次', calls.length === 5, String(calls.length))
  check('取数:Start Plan 准入探测走 billing/balance 且带 device-mid',
    calls.some((c) => c.url.includes('billing/balance') && c.headers['x-device-mid'] === 'device-mid-fixture'),
    JSON.stringify(calls.find((c) => c.url.includes('billing/balance'))?.headers))
  check('取数:Start Plan 从 balance 同时解析套餐、余额和模型白名单',
    report.entitlements.startPlan.subscription?.details[0]?.productId === 'zcode-v3-start-plan'
      && report.entitlements.startPlan.quota?.limits[0]?.remaining === 299999000
      && report.accountProviders['account:bigmodel-start-plan']?.models?.includes('glm-5.3-flash'),
    JSON.stringify(report.entitlements.startPlan))
  check('取数:quota 走 {origin}/api/monitor/usage/quota/limit', calls.some((c) => c.url === 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'))
  check('取数:鉴权头为 authorization: Bearer <key>,bigmodel 端点只此一+accept',
    calls.filter((c) => c.url.startsWith('https://open.bigmodel.cn'))
      .every((c) => c.headers.authorization === 'Bearer plan-key' && Object.keys(c.headers).length === 2),
    JSON.stringify(calls.filter((c) => c.url.startsWith('https://open.bigmodel.cn'))[0]?.headers))
  check('取数:billing/balance 带 x-device-mid',
    calls.filter((c) => c.url.includes('billing/balance'))
      .every((c) => c.headers.authorization === 'Bearer jwt-token' && c.headers['x-device-mid'] === 'device-mid-fixture'))
  check('取数:Start Plan 只调用一次 balance 且带 app_version',
    calls.filter((c) => c.url.includes('billing/balance?app_version=3.14.1')).length === 1
      && !calls.some((c) => c.url.includes('billing/current')))
  check('取数:MCP 使用官方个人身份头', calls.some((c) => c.url.includes('/mcp/usage')
    && c.headers.Authorization === 'Bearer jwt-token'
    && c.headers['X-Bigmodel-Authorization'] === 'Bearer oauth-token'
    && c.headers['Bigmodel-Target-Type'] === 'PERSONAL'))
  check('取数:报告含完整 Coding/Start/MCP 权益',
    report.entitlements.codingPlan.quota?.limits.length === 1
      && report.entitlements.codingPlan.subscription?.details.length === 1
      && report.entitlements.startPlan.subscription?.details.length === 1
      && report.entitlements.codingPlan.mcpQuota?.aggregate.remaining === 95)
  check('取数:账号状态含完整 access 与 state',
    report.accountProviders['account:bigmodel-individual-coding-plan']?.access.entitled === true
      && report.accountProviders['account:bigmodel-individual-coding-plan']?.state.availability === 'available')
  check('取数:报告含窗口用量', report.modelUsage !== undefined && report.modelUsage.totalTokens === 600,
    JSON.stringify(report.modelUsage?.totalTokens))
  check('取数:model-usage 默认 30 天窗口',
    calls.some((c) => c.url.includes('/model-usage?startTime=') && c.url.includes('endTime=')),
    calls.find((c) => c.url.includes('/model-usage'))?.url ?? '(未调用)')
  check('取数:无失败项', report.failures.length === 0, JSON.stringify(report.failures))

  // range 参数生效:7d 窗口的起点应比 30d 晚
  const calls7 = []
  const report7 = await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn', endpointOrigin: 'https://zcode.z.ai', appVersion: '3.14.1',
    planApiKey: 'plan-key', range: '7d',
    fetch: async (url, init) => {
      calls7.push(String(url))
      if (String(url).includes('/model-usage')) {
        return new Response(JSON.stringify({ code: 200, data: { x_time: [], tokensUsage: [], modelCallCount: [], totalUsage: { totalTokensUsage: 0, totalModelCallCount: 0 } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 200, data: { limits: [] } }), { status: 200 })
    },
  })
  check('取数:range=7d 时 modelUsage.range 回填 7d', report7.modelUsage?.range === '7d', String(report7.modelUsage?.range))
  const startOf = (u) => decodeURIComponent(new URL(u).searchParams.get('startTime') ?? '')
  check('取数:7d 起点晚于 30d 起点',
    startOf(calls7.find((u) => u.includes('/model-usage'))) > startOf(calls.find((c) => c.url.includes('/model-usage')).url),
    `${startOf(calls7.find((u) => u.includes('/model-usage')))} vs ${startOf(calls.find((c) => c.url.includes('/model-usage')).url)}`)

  // 分项失败隔离
  const partial = await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn', endpointOrigin: 'https://zcode.z.ai', appVersion: '3.14.1',
    planApiKey: 'plan-key',
    fetch: async (url) => {
      if (String(url).includes('/quota/limit')) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({ code: 200, data: [{ productId: 'p', productName: 'Coding', status: 'VALID', inCurrentPeriod: true }] }), { status: 200 })
    },
  })
  check('取数:quota 失败不影响订阅', partial.entitlements.codingPlan.subscription !== null && partial.failures.some((f) => f.source === 'quota'))
  check('取数:缺少 planApiKey 时记失败而不抛', (await usage.fetchUsageReport({ endpointOrigin: 'x', appVersion: '1' })).failures.length > 0)

  // 五个互不依赖的官方端点必须同时在途，避免每个 20s 超时串成约 100s。
  let active = 0
  let peak = 0
  await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn', endpointOrigin: 'https://zcode.z.ai', appVersion: '3.14.1',
    planApiKey: 'plan-key', zcodeJwt: 'jwt', oauthAccessToken: 'oauth',
    fetch: async (url) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      const value = String(url)
      if (value.includes('/quota/limit')) return Response.json({ code: 200, data: { limits: [] } })
      if (value.includes('/subscription/list')) return Response.json({ code: 200, data: [] })
      if (value.includes('/model-usage')) return Response.json({ code: 200, data: { x_time: [], tokensUsage: [], modelCallCount: [] } })
      if (value.includes('/billing/balance')) return Response.json({ code: 0, data: { plans: [] } })
      return Response.json({ code: 0, data: { plans: [] } })
    },
  })
  check('取数:五个独立权益端点并发请求', peak === 5, String(peak))
}

// ---- 5b. 核心权益与可延迟补充数据的分离 ----
{
  const calls = []
  const deps = {
    bigmodelOrigin: 'https://open.bigmodel.cn',
    endpointOrigin: 'https://zcode.z.ai',
    appVersion: '3.14.1',
    planApiKey: 'plan-key',
    zcodeJwt: 'jwt-token',
    oauthAccessToken: 'oauth-token',
    range: '7d',
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('/quota/limit')) return Response.json({ code: 200, data: { limits: [] } })
      if (value.includes('/subscription/list')) {
        return Response.json({ code: 200, data: [{ productId: 'coding', productName: 'Coding', status: 'VALID', inCurrentPeriod: true }] })
      }
      if (value.includes('/billing/balance')) return Response.json({ code: 0, data: { plans: [] } })
      if (value.includes('/model-usage')) {
        return Response.json({
          code: 200,
          data: {
            x_time: ['2026-09-26'], tokensUsage: [7], modelCallCount: [1],
            totalUsage: { totalTokensUsage: 7, totalModelCallCount: 1, modelSummaryList: [{ modelName: 'GLM-5.3-Flash', totalTokens: 7 }] },
          },
        })
      }
      if (value.includes('/mcp/usage')) {
        return Response.json({ code: 0, data: { server_time: 1, level: 'Max', total_usage: { used: 2, limit: 10, remaining: 8 } } })
      }
      return new Response('{}', { status: 404 })
    },
  }
  const core = await usage.fetchEntitlementReport(deps)
  check('拆分:核心快照只请求 quota/subscription/start-plan',
    calls.length === 3 && !calls.some((url) => url.includes('/model-usage') || url.includes('/mcp/usage')),
    calls.join(','))
  check('拆分:核心快照不携带模型用量或 MCP 补充',
    core.modelUsage === undefined && core.entitlements.codingPlan.mcpQuota === null,
    JSON.stringify(core.entitlements.codingPlan))

  const supplement = await usage.fetchUsageSupplement(deps)
  check('拆分:补充数据只请求 model-usage 与 MCP',
    calls.filter((url) => url.includes('/model-usage') || url.includes('/mcp/usage')).length === 2,
    calls.join(','))
  check('拆分:补充数据遵从 range 并保留 MCP 快照',
    supplement.modelUsage?.range === '7d'
      && supplement.mcpQuota?.aggregate.remaining === 8,
    JSON.stringify(supplement))

  const merged = usage.mergeUsageReport(core, supplement)
  check('拆分:合并后恢复旧完整报告字段',
    merged.modelUsage?.totalTokens === 7
      && merged.entitlements.codingPlan.mcpQuota?.aggregate.remaining === 8,
    JSON.stringify(merged.entitlements.codingPlan.mcpQuota))
  check('拆分:合并不变异核心快照',
    core.modelUsage === undefined && core.entitlements.codingPlan.mcpQuota === null,
    JSON.stringify(core.entitlements.codingPlan.mcpQuota))

  const unavailable = usage.mergeUsageReport({
    ...core,
    entitlements: {
      ...core.entitlements,
      codingPlan: { ...core.entitlements.codingPlan, subscription: null },
    },
  }, supplement)
  check('拆分:晚到的 MCP 数据不抬高无订阅账号', unavailable.entitlements.codingPlan.mcpQuota === null)
}

// ---- 5c. 硬超时:忽略 AbortSignal 的 fetch 也不能悬挂取数 ----
{
  let aborts = 0
  const slowFetch = (url, init) => {
    const value = String(url)
    if (value.includes('/model-usage') || value.includes('/mcp/usage')) {
      init.signal.addEventListener('abort', () => { aborts += 1 }, { once: true })
      // Deliberately never settles, even after abort, to exercise Promise.race.
      return new Promise(() => {})
    }
    if (value.includes('/quota/limit')) return Response.json({ code: 200, data: { limits: [] } })
    if (value.includes('/subscription/list')) {
      return Response.json({ code: 200, data: [{ productId: 'coding', productName: 'Coding', status: 'VALID', inCurrentPeriod: true }] })
    }
    if (value.includes('/billing/balance')) return Response.json({ code: 0, data: { plans: [] } })
    return new Response('{}', { status: 404 })
  }
  const deps = {
    bigmodelOrigin: 'https://open.bigmodel.cn', endpointOrigin: 'https://zcode.z.ai', appVersion: '3.14.1',
    planApiKey: 'plan-key', zcodeJwt: 'jwt-token', oauthAccessToken: 'oauth-token',
    timeoutMs: 60, fetch: slowFetch,
  }
  let supplementSettled = false
  const supplementPromise = usage.fetchUsageSupplement(deps).then((result) => {
    supplementSettled = true
    return result
  })
  const core = await usage.fetchEntitlementReport(deps)
  check('硬超时:模型/MCP 在途时核心快照先完成',
    !supplementSettled && core.entitlements.codingPlan.subscription !== null,
    JSON.stringify(core.failures))

  const watchdog = Symbol('usage supplement watchdog')
  const timed = await Promise.race([
    supplementPromise,
    new Promise((resolve) => setTimeout(() => resolve(watchdog), 240)),
  ])
  check('硬超时:忽略 abort 的补充 fetch 仍在时限内返回', timed !== watchdog)
  if (timed !== watchdog) {
    check('硬超时:超时会 abort 两个补充请求', aborts === 2, String(aborts))
    check('硬超时:模型失败可见而 MCP 失败保持静默',
      timed.failures.some((failure) => failure.source === 'model-usage')
        && !timed.failures.some((failure) => failure.source === 'off-peak')
        && timed.mcpQuota === undefined,
      JSON.stringify(timed))
  }
}

// ---- 5d. Remote cancellation reaches in-flight entitlement requests ----
{
  let aborted = 0
  const pendingFetch = (_url, init) => {
    init.signal.addEventListener('abort', () => { aborted += 1 }, { once: true })
    return new Promise(() => {})
  }
  const deps = {
    bigmodelOrigin: 'https://open.bigmodel.cn', endpointOrigin: 'https://zcode.z.ai', appVersion: '3.14.1',
    planApiKey: 'plan-key', zcodeJwt: 'jwt-token', timeoutMs: 10_000, fetch: pendingFetch,
  }
  const controller = new AbortController()
  const pending = usage.fetchEntitlementReport(deps, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  controller.abort(new Error('remote request cancelled'))
  await pending.then(
    () => check('Remote cancellation rejects the core collector', false),
    () => check('Remote cancellation rejects the core collector', true),
  )
  check('Remote cancellation aborts every in-flight core request', aborted === 3, String(aborted))
}

// ---- 6. 渲染 ----
{
  const report = usage.emptyUsageReport()
  report.entitlements.codingPlan = {
    generatedAt: Date.now(), authenticated: true, context: { scope: 'personal' },
    provider: { id: 'account:bigmodel-individual-coding-plan', name: 'BigModel Coding Plan' },
    remaining: { count: 53699, isShow: true },
    subscription: { identityType: 'unknown', identityMasked: null, details: [{
      productId: 'p', productName: 'GLM Coding Max', purchaseTime: null, beginTime: null,
      billingCycle: 'quarterly', renewTime: null, expireTime: '2027-03-15T02:00:00.000Z',
    }] },
    quota: { level: 'Max', limits: [{ type: 'CREDIT_LIMIT', unit: 6, number: 140000, usage: 140000, currentValue: 86301, remaining: 53699, percentage: 61, nextResetTime: 1790653225964, usageDetails: [] }] },
    mcpQuota: null,
  }
  report.entitlements.startPlan = {
    generatedAt: Date.now(), authenticated: true, context: { scope: 'personal' },
    provider: { id: 'account:bigmodel-start-plan', name: 'BigModel Start Plan' }, remaining: null,
    subscription: { identityType: 'unknown', identityMasked: null, details: [{
      productId: 'sp', productName: 'ZCode Weekend Build', purchaseTime: null,
      beginTime: '2026-09-24T00:00:00.000Z', expireTime: '2026-09-27T12:00:00.000Z',
      entitlements: [{ entitlementId: 'e1', showName: 'GLM-5.3-Flash', effectiveTime: '2026-09-24T00:00:00.000Z' }],
    }] },
    quota: { level: 'Start', limits: [{ type: 'e1', number: 300000000, usage: 1000, currentValue: 1000, remaining: 299999000, unitType: 'token', percentage: 0.99, usageDetails: [{ modelCode: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', usage: 1000 }] }] },
  }
  const text = usage.renderUsageReport(report)
  check('渲染:含订阅名与周期', text.includes('GLM Coding Max') && text.includes('quarterly'), text)
  check('渲染:含额度已用/上限/剩余/百分比', /86301/.test(text) && /140000/.test(text) && /53699/.test(text) && /61%/.test(text))
  check('渲染:含 Start Plan 名与权益', text.includes('ZCode Weekend Build') && text.includes('GLM-5.3-Flash'))
  check('渲染:Start Plan 有效期来自标准订阅快照',
    text.includes('2026-09-24') && !text.includes('1970'), text.split('\n').find((l) => l.includes('有效期')))
  check('渲染:订阅到期按 ISO 渲染成本地时间', /到期: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text), text.split('\n').find((l) => l.includes('到期')))
  check('渲染:额度重置时间按毫秒渲染', /重置 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text), text.split('\n').find((l) => l.includes('重置')))
  const empty = usage.renderUsageReport(usage.emptyUsageReport())
  check('渲染:空报告也给出明确状态', empty.includes('not_configured'), empty)
}

// ---- 7. 工具注册:apply 时把 zcode_usage 登记进 tools 服务 ----
{
  const { apply } = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)
  const registered = []
  const logs = []
  const disposers = []
  /** 模拟 cordis 的 ctx.inject:服务就绪即回调,并记录返回的 disposer。 */
  const makeCtx = (withTools) => {
    const scope = {
      logger: { info: (m) => logs.push(String(m)), debug: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
      get: (name) => (withTools && name === 'tools' ? { register: (tool) => { registered.push(tool); const d = () => {}; disposers.push(d); return d } } : undefined),
    }
    return {
      logger: scope.logger,
      get: () => undefined,
      inject: (deps, callback) => {
        if (!deps.includes('tools')) throw new Error(`意外依赖: ${deps.join(',')}`)
        if (withTools) callback(scope)
        return { dispose() {} }
      },
      llm: { registerAdapter() {}, registerConfigurableProviders() {} },
      fiber: { entry: { options: { id: 'zcode-provider' } } },
    }
  }
  const toolConfig = {
    providerConfigPath: join(pkgRoot, 'tests', 'fixtures', 'missing-device-config.json'),
    routes: {
      fixture: {
        id: 'fixture', display: 'Fixture', kind: 'anthropic', baseURL: 'https://fixture.invalid', apiKey: 'fixture',
        models: [{ id: 'fixture-model', contextWindow: 1000, maxTokens: 100 }],
      },
    },
  }
  await apply(makeCtx(true), toolConfig)
  check('工具:apply 时经 ctx.inject(["tools"]) 登记 zcode_usage',
    registered.length === 1 && registered[0].name === 'zcode_usage', JSON.stringify(registered.map((t) => t.name)))
  const tool = registered[0]
  check('工具:描述声明只读并说明与官方同源', /Read-only/.test(tool.description) && /official zcode client/.test(tool.description))
  check('工具:参数为对象且可省略', tool.parameters.type === 'object', JSON.stringify(tool.parameters))
  check('工具:输出契约含 text 且可渲染',
    tool.output.schema.required.includes('text')
    && JSON.stringify(tool.output.render({}, { text: 'hello' })) === JSON.stringify([{ type: 'text', text: 'hello' }]))
  check('工具:execute 返回 text 字段', typeof tool.execute === 'function')

  // tools 服务缺失时不得让插件激活失败(仅不注册工具)
  let survived = true
  try { await apply(makeCtx(false), toolConfig) } catch { survived = false }
  check('工具:tools 服务未就绪时插件仍能激活', survived)
}

// ---- 8. 真机(可选) ----
if (process.argv.includes('--live')) {
  const creds = await import(pathToFileURL(join(pkgRoot, 'lib', 'credentials.js')).href)
  const V2 = 'C:\\Users\\Amamiya\\.zcode\\v2'
  const cfg = JSON.parse(readFileSync(join(V2, 'config.json'), 'utf8'))
  const plan = creds.resolvePlanCredential({
    credentialsPath: join(V2, 'credentials.json'), providerId: 'account:bigmodel-individual-coding-plan',
    family: 'bigmodel', planKind: 'individual-coding-plan',
    fallbackApiKey: cfg.provider['builtin:bigmodel-coding-plan']?.options.apiKey,
  })
  const jwt = creds.resolvePlanCredential({
    credentialsPath: join(V2, 'credentials.json'), providerId: 'account:bigmodel-start-plan',
    family: 'bigmodel', planKind: 'start-plan',
    fallbackApiKey: cfg.provider['builtin:bigmodel-start-plan']?.options.apiKey,
  })
  const live = await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn',
    endpointOrigin: 'https://zcode.z.ai',
    appVersion: '3.14.1',
    planApiKey: plan.apiKey,
    zcodeJwt: jwt.apiKey,
    // 错峰资格需要本地前提:把真机的 active_provider 与 planKind 一并给出
    hasCodingPlanApiKey: plan.apiKey !== '',
    activeProvider: creds.readCredentialValue(join(V2, 'credentials.json'), creds.ACTIVE_PROVIDER_KEY),
    accountFamily: 'bigmodel',
    accountPlanKind: 'individual-coding-plan',
    // 设备标识:官方每个 zcode.z.ai 请求都带;缺它 billing/balance 回 3001
    deviceMid: JSON.parse(readFileSync(join(V2, 'telemetry-state.json'), 'utf8')).deviceMid,
  })
  console.log('\n--- 真机取数结果 ---')
  console.log(usage.renderUsageReport(live))
  check('真机:取到额度条目', live.limits.length > 0, String(live.limits.length))
  check('真机:取到生效订阅', live.subscription !== undefined, JSON.stringify(live.subscription))
  check('真机:取到 Start Plan', live.startPlan !== undefined, JSON.stringify(live.startPlan?.planId))
  check('真机:取到窗口用量', live.modelUsage !== undefined, JSON.stringify(live.failures))
  if (live.modelUsage !== undefined) {
    const w = live.modelUsage
    check('真机:窗口内总量 > 0', w.totalTokens > 0, String(w.totalTokens))
    check('真机:有逐日序列', w.days.length > 0, String(w.days.length))
    check('真机:逐日长度与天数上限一致(30d → 30 天)', w.days.length === 30, String(w.days.length))
    check('真机:有按模型的明细', w.models.length > 0, JSON.stringify(w.models))
    check('真机:模型占比之和约等于 1',
      Math.abs(w.models.reduce((sum, m) => sum + m.share, 0) - 1) < 0.02,
      String(w.models.reduce((sum, m) => sum + m.share, 0)))
    check('真机:模型按 token 降序',
      w.models.every((m, i) => i === 0 || w.models[i - 1].totalTokens >= m.totalTokens),
      w.models.map((m) => m.totalTokens).join(','))
    check('真机:活跃天数不超过总天数', w.activeDays <= w.days.length, `${w.activeDays}/${w.days.length}`)
    check('真机:模型明细总量与总量一致(±1%)',
      Math.abs(w.models.reduce((s, m) => s + m.totalTokens, 0) - w.totalTokens) / w.totalTokens < 0.01,
      `${w.models.reduce((s, m) => s + m.totalTokens, 0)} vs ${w.totalTokens}`)
  }
  // 显式打开时资格判定仍在(协议没删,只是默认不取)
  const optIn = await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn', endpointOrigin: 'https://zcode.z.ai',
    appVersion: '3.14.3', planApiKey: plan.apiKey, zcodeJwt: jwt.apiKey,
    hasCodingPlanApiKey: plan.apiKey !== '', activeProvider: 'bigmodel',
    accountFamily: 'bigmodel', accountPlanKind: 'individual-coding-plan',
    deviceMid: JSON.parse(readFileSync(join(V2, 'telemetry-state.json'), 'utf8')).deviceMid,
    offPeakReport: true,
  })
  check('真机:显式 offPeakReport:true 时资格判定仍可用(协议保留)',
    optIn.offPeak !== undefined && optIn.offPeak.eligibility.supported === true,
    JSON.stringify(optIn.offPeak?.eligibility))
  // 错峰报告默认关闭(派发一期不做):默认取数**不该**出现该段,也不该去打错峰端点
  check('真机:错峰段默认不出现(默认禁用)',
    live.offPeak === undefined, JSON.stringify(live.offPeak?.eligibility))
  check('真机:默认取数没有 off-peak 失败项(说明没请求该端点)',
    !live.failures.some((f) => f.source === 'off-peak'), JSON.stringify(live.failures))
  check('真机:Start Plan 准入通过(带 device-mid 后 billing/balance 返回 code=0)',
    live.startPlanBalance?.ok === true, JSON.stringify(live.startPlanBalance))
  check('真机:准入探测确认本次带了设备标识', live.startPlanBalance?.deviceIdentified === true,
    JSON.stringify(live.startPlanBalance))
}

// ---- 16. x-device-mid:zcode.z.ai 请求的身份头(少了它服务端回 3001) ----
{
  // 实测(2026-09-26):
  //   GET /api/v1/zcode-plan/billing/balance  仅 authorization            → 3001 parameter error
  //   + 全部 16 个源码头(不含 device-mid)                                → 3001
  //   仅 authorization + x-device-mid                                    → 200 {"code":0}
  // 即 3001 在这里的含义是"设备身份未识别",不是请求参数有误。
  const calls = []
  await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn',
    endpointOrigin: 'https://zcode.z.ai',
    appVersion: '3.14.3',
    planApiKey: 'plan-key',
    zcodeJwt: 'jwt-token',
    deviceMid: 'device-mid-fixture',
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} })
      return new Response(JSON.stringify({ code: 200, data: { limits: [] } }), { status: 200 })
    },
  })
  const zcodeCalls = calls.filter((c) => c.url.startsWith('https://zcode.z.ai'))
  check('device-mid:zcode.z.ai 请求都带 x-device-mid',
    zcodeCalls.length > 0 && zcodeCalls.every((c) => c.headers['x-device-mid'] === 'device-mid-fixture'),
    `zcode 请求 ${zcodeCalls.length} 个;缺头的=${zcodeCalls.filter((c) => c.headers['x-device-mid'] === undefined).map((c) => c.url).join(',')}`)
  check('device-mid:Start Plan 取数带 x-device-mid',
    calls.find((c) => c.url.includes('/zcode-plan/billing/balance'))?.headers['x-device-mid'] === 'device-mid-fixture')
  check('device-mid:大模型端点(bigmodel)不需要 device-mid',
    calls.filter((c) => c.url.startsWith('https://open.bigmodel.cn')).every((c) => c.headers['x-device-mid'] === undefined),
    'bigmodel 端点不应带 zcode 的设备头')

  // 未配置时不硬塞该头
  const calls2 = []
  await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn', endpointOrigin: 'https://zcode.z.ai',
    appVersion: '3.14.3', planApiKey: 'k', zcodeJwt: 'j',
    fetch: async (url, init) => { calls2.push({ url: String(url), headers: init?.headers ?? {} }); return new Response(JSON.stringify({ code: 200, data: { limits: [] } }), { status: 200 }) },
  })
  check('device-mid:未配置时不带该头(避免送出空值)',
    calls2.every((c) => c.headers['x-device-mid'] === undefined))
}

console.log(`\n${passed}/${passed + failures.length} 项通过`)
if (failures.length) {
  console.error(`\n失败项:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
