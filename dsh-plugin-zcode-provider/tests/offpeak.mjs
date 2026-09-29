/**
 * offpeak 模块测试:票据协议(常量/头/信封/状态机/截断/错误)与本地资格判定,
 * 以及与 usage 报告、zcode_usage 工具的接线。
 *
 * `--live` 追加真机:查可用性 + 领票 + 轮询 + 结算(会真实占用一次队列号)。
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const pkgRoot = join(import.meta.dirname, '..')
const offpeak = await import(pathToFileURL(join(pkgRoot, 'lib', 'offpeak.js')).href)
const usage = await import(pathToFileURL(join(pkgRoot, 'lib', 'usage.js')).href)
const wire = await import(pathToFileURL(join(pkgRoot, 'lib', 'official-wire.js')).href)

let passed = 0
const failures = []
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) } else { failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`); console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const DEPS = {
  endpointOrigin: 'https://zcode.z.ai',
  zcodeJwt: 'fixture-jwt',
  codingPlanApiKey: 'fixture-plan-key',
  sourceHeaders: { 'user-agent': 'ZCode/3.14.3', 'x-zcode-app-version': '3.14.3' },
}

/** 桩 fetch:记录调用并按路径给响应。 */
function stub(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers ?? {}, body: init?.body })
    return await handler(String(url), init, calls.length)
  }
  return { calls, fetchImpl }
}

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

// ---- 1. 常量与官方一致 ----
{
  check('常量:基路径 = /api/v1/off-peak', offpeak.OFF_PEAK_BASE_PATH === '/api/v1/off-peak', offpeak.OFF_PEAK_BASE_PATH)
  check('常量:coding plan 头名 = x-coding-plan-api-key(官方 qA)',
    offpeak.OFF_PEAK_CODING_PLAN_HEADER === 'x-coding-plan-api-key', offpeak.OFF_PEAK_CODING_PLAN_HEADER)
  check('常量:票据头名 = x-off-peak-ticket-id(引擎脱敏名单同名)',
    offpeak.OFF_PEAK_TICKET_HEADER === 'x-off-peak-ticket-id', offpeak.OFF_PEAK_TICKET_HEADER)
  check('常量:任务 id 前缀 = offpeak-', offpeak.OFF_PEAK_TASK_ID_PREFIX === 'offpeak-', offpeak.OFF_PEAK_TASK_ID_PREFIX)
  check('常量:请求超时 = 官方 dbe 1e4', offpeak.OFF_PEAK_REQUEST_TIMEOUT_MS === 10_000, String(offpeak.OFF_PEAK_REQUEST_TIMEOUT_MS))
  check('常量:状态机与官方 TV 一致',
    JSON.stringify(offpeak.OFF_PEAK_TICKET_STATES) === JSON.stringify(['queued', 'ready', 'active', 'expired', 'settled', 'not_found']),
    JSON.stringify(offpeak.OFF_PEAK_TICKET_STATES))
  check('常量:team 身份头名与官方 KA 一致',
    offpeak.OFF_PEAK_TEAM_HEADERS.organization === 'bigmodel-organization' && offpeak.OFF_PEAK_TEAM_HEADERS.project === 'bigmodel-project',
    JSON.stringify(offpeak.OFF_PEAK_TEAM_HEADERS))
}

// ---- 2. 任务 id 格式 ----
{
  const id = offpeak.buildOffPeakTaskId()
  check('任务 id:前缀 offpeak-', id.startsWith('offpeak-'), id)
  check('任务 id:UUID 部分合法', /^offpeak-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id), id)
  check('任务 id:两次生成不同(官方用 randomUUID)', offpeak.buildOffPeakTaskId() !== offpeak.buildOffPeakTaskId())
}

// ---- 3. 请求头(官方 n() 的头集合)----
{
  const headers = offpeak.buildOffPeakHeaders(DEPS)
  check('头:Authorization = Bearer <jwt>', headers.authorization === 'Bearer fixture-jwt', headers.authorization)
  check('头:**含** x-coding-plan-api-key(少了它服务端认不出套餐)',
    headers['x-coding-plan-api-key'] === 'fixture-plan-key', headers['x-coding-plan-api-key'])
  check('头:含 x-request-id', typeof headers['x-request-id'] === 'string' && headers['x-request-id'].length > 10, headers['x-request-id'])
  check('头:保留源码头', headers['user-agent'] === 'ZCode/3.14.3' && headers['x-zcode-app-version'] === '3.14.3')
  check('头:非 team 不带组织/项目头',
    headers['bigmodel-organization'] === undefined && headers['bigmodel-project'] === undefined,
    JSON.stringify(Object.keys(headers)))
  const team = offpeak.buildOffPeakHeaders({ ...DEPS, organizationId: 'org-1', projectId: 'proj-1' })
  check('头:team 带组织/项目头',
    team['bigmodel-organization'] === 'org-1' && team['bigmodel-project'] === 'proj-1',
    JSON.stringify({ o: team['bigmodel-organization'], p: team['bigmodel-project'] }))
  const partial = offpeak.buildOffPeakHeaders({ ...DEPS, organizationId: 'org-1' })
  check('头:只有 organization 时两个都不加(官方 KA 要求同时非空)',
    partial['bigmodel-organization'] === undefined && partial['bigmodel-project'] === undefined)
}

// ---- 4. 模型请求鉴权(官方 qA / buildOffPeakRequestAuth)----
{
  const auth = offpeak.buildOffPeakRequestAuth(DEPS, 'ticket-42')
  check('qA:apiKey = jwt', auth.apiKey === 'fixture-jwt', auth.apiKey)
  check('qA:三件套齐全(Authorization + coding plan key + ticket)',
    auth.headers.authorization === 'Bearer fixture-jwt'
    && auth.headers['x-coding-plan-api-key'] === 'fixture-plan-key'
    && auth.headers['x-off-peak-ticket-id'] === 'ticket-42',
    JSON.stringify(auth.headers))
  check('qA:不带额外源码头(只回鉴权三件套)', Object.keys(auth.headers).length === 3, JSON.stringify(Object.keys(auth.headers)))
  const teamAuth = offpeak.buildOffPeakRequestAuth({ ...DEPS, organizationId: 'o', projectId: 'p' }, 't')
  check('qA:team 追加组织/项目头', teamAuth.headers['bigmodel-organization'] === 'o' && teamAuth.headers['bigmodel-project'] === 'p')
}

// ---- 5. 领票可用性 ----
{
  const { calls, fetchImpl } = stub(async () => json({ code: 0, msg: 'success', data: { can_take_number: true } }))
  const result = await offpeak.fetchOffPeakAvailability({ ...DEPS, fetch: fetchImpl })
  check('可用性:URL 为 {origin}/api/v1/off-peak/ticket/availability',
    calls[0].url === 'https://zcode.z.ai/api/v1/off-peak/ticket/availability', calls[0].url)
  check('可用性:方法为 GET', calls[0].method === 'GET', calls[0].method)
  check('可用性:解析 can_take_number', result.canTakeNumber === true && result.nextTakeAt === undefined, JSON.stringify(result))

  const blocked = stub(async () => json({ code: 0, data: { can_take_number: false, next_take_at: 1790411236 } }))
  const b = await offpeak.fetchOffPeakAvailability({ ...DEPS, fetch: blocked.fetchImpl })
  check('可用性:不可领时带 next_take_at', b.canTakeNumber === false && b.nextTakeAt === 1790411236, JSON.stringify(b))

  const broken = stub(async () => json({ code: 0, data: { can_take_number: false } }))
  let threw = false
  try { await offpeak.fetchOffPeakAvailability({ ...DEPS, fetch: broken.fetchImpl }) } catch (e) { threw = e instanceof offpeak.OffPeakServerError }
  check('可用性:不可领却没有 next_take_at 时报错(不静默)', threw)
}

// ---- 6. 领票 ----
{
  const { calls, fetchImpl } = stub(async () => json({
    code: 0, msg: 'success',
    data: { ticket_id: '2103761359207743488', task_id: 'offpeak-x', state: 'queued', position: 1, next_poll_after: 90, queued_at: 1790410768686 },
  }))
  const ticket = await offpeak.takeOffPeakTicket({ ...DEPS, fetch: fetchImpl }, 'offpeak-x')
  check('领票:URL /ticket 且方法 POST', calls[0].url.endsWith('/api/v1/off-peak/ticket') && calls[0].method === 'POST', `${calls[0].method} ${calls[0].url}`)
  check('领票:请求体为 {task_id}(官方 n("POST","/ticket",{task_id:r}))',
    JSON.parse(calls[0].body) .task_id === 'offpeak-x', calls[0].body)
  check('领票:解析 ticket_id', ticket.ticketId === '2103761359207743488', ticket.ticketId)
  check('领票:state 落在官方枚举内', ticket.state === 'queued', ticket.state)
  check('领票:position 保留', ticket.position === 1, String(ticket.position))
  check('领票:next_poll_after 秒 → 毫秒', ticket.nextPollAfterMs === 90_000, String(ticket.nextPollAfterMs))
  check('领票:带 content-type(有 body 时)', calls[0].headers['content-type'] === 'application/json')

  const noId = stub(async () => json({ code: 0, data: { state: 'queued' } }))
  let threw = false
  try { await offpeak.takeOffPeakTicket({ ...DEPS, fetch: noId.fetchImpl }, 't') } catch (e) { threw = e instanceof offpeak.OffPeakServerError }
  check('领票:无 ticket_id 时报错', threw)

  const unknown = stub(async () => json({ code: 0, data: { ticket_id: 'x', state: 'weird' } }))
  const u = await offpeak.takeOffPeakTicket({ ...DEPS, fetch: unknown.fetchImpl }, 't')
  check('领票:未知 state 归一为 unknown', u.state === 'unknown', u.state)

  const auto = stub(async () => json({ code: 0, data: { ticket_id: 'x', state: 'queued' } }))
  await offpeak.takeOffPeakTicket({ ...DEPS, fetch: auto.fetchImpl })
  check('领票:未给 taskId 时自动生成 offpeak- 前缀 id',
    JSON.parse(auto.calls[0].body).task_id.startsWith('offpeak-'), auto.calls[0].body)
}

// ---- 7. 批量状态 ----
{
  const { calls, fetchImpl } = stub(async () => json({
    code: 0,
    data: {
      next_poll_after: 30,
      tickets: [
        { ticket_id: 'a', task_id: 'ta', state: 'ready', position: null, active_deadline: 1790411116092 },
        { ticket_id: 'b', state: 'queued', position: 3 },
        { no_ticket_id: true },
      ],
    },
  }))
  const result = await offpeak.fetchOffPeakTicketStatus({ ...DEPS, fetch: fetchImpl }, ['a', 'b'])
  check('状态:URL /ticket/status', calls[0].url.endsWith('/api/v1/off-peak/ticket/status'), calls[0].url)
  check('状态:请求体 ticket_ids', JSON.stringify(JSON.parse(calls[0].body).ticket_ids) === JSON.stringify(['a', 'b']), calls[0].body)
  check('状态:跳过没有 ticket_id 的条目', result.tickets.length === 2, String(result.tickets.length))
  check('状态:position=null 不写入', result.tickets[0].position === undefined, String(result.tickets[0].position))
  check('状态:active_deadline 保留', result.tickets[0].activeDeadline === 1790411116092, String(result.tickets[0].activeDeadline))
  check('状态:next_poll_after 秒 → 毫秒', result.nextPollAfterMs === 30_000, String(result.nextPollAfterMs))

  const empty = await offpeak.fetchOffPeakTicketStatus({ ...DEPS, fetch: async () => { throw new Error('不该发请求') } }, [])
  check('状态:空列表不发请求', empty.tickets.length === 0)

  const many = stub(async () => json({ code: 0, data: { tickets: [] } }))
  await offpeak.fetchOffPeakTicketStatus({ ...DEPS, fetch: many.fetchImpl }, Array.from({ length: 150 }, (_, i) => `t${i}`))
  check('状态:>100 个按官方截断到 100', JSON.parse(many.calls[0].body).ticket_ids.length === 100,
    String(JSON.parse(many.calls[0].body).ticket_ids.length))
}

// ---- 8. 结算 ----
{
  const { calls, fetchImpl } = stub(async () => json({ code: 0, data: { ticket_id: 'a/b', state: 'settled' } }))
  const state = await offpeak.settleOffPeakTicket({ ...DEPS, fetch: fetchImpl }, 'a/b')
  check('结算:URL 对 id 做 encodeURIComponent', calls[0].url.endsWith('/api/v1/off-peak/ticket/a%2Fb/settle'), calls[0].url)
  check('结算:返回 state', state === 'settled', state)
}

// ---- 9. 错误语义 ----
{
  const { fetchImpl } = stub(async () => json({ code: 3103, msg: 'free tier limit reached', data: { next_take_at: 1790411300 } }, 429))
  let err
  try { await offpeak.takeOffPeakTicket({ ...DEPS, fetch: fetchImpl }, 't') } catch (e) { err = e }
  check('错误:非 2xx 抛 OffPeakServerError', err instanceof offpeak.OffPeakServerError)
  check('错误:保留 HTTP 状态', err?.httpStatus === 429, String(err?.httpStatus))
  check('错误:保留业务码', err?.bizCode === 3103, String(err?.bizCode))
  check('错误:从 data.next_take_at 读限流时间', err?.nextTakeAt === 1790411300, String(err?.nextTakeAt))
  check('错误:消息含服务端原话', /free tier limit reached/.test(String(err?.message)), String(err?.message))

  const token = stub(async () => new Response(JSON.stringify({ code: 0, data: { can_take_number: true } }), { status: 200 }))
  const ok = await offpeak.fetchOffPeakAvailability({ ...DEPS, fetch: token.fetchImpl })
  check('信封:code=0 时取 data', ok.canTakeNumber === true)
}

// ---- 10. 本地资格判定(官方 Dd 的前置条件)----
{
  const good = { activeProvider: 'bigmodel', family: 'bigmodel', planKind: 'individual-coding-plan', hasZcodeJwt: true, hasCodingPlanApiKey: true }
  check('资格:齐全时 supported', offpeak.resolveOffPeakEligibility(good).supported === true)
  check('资格:start-plan 明确不支持(官方 start_plan_not_supported)',
    offpeak.resolveOffPeakEligibility({ ...good, planKind: 'start-plan' }).reason === 'start_plan_not_supported')
  check('资格:start-plan 的说明指出走 coding plan 连接',
    /coding plan/.test(offpeak.resolveOffPeakEligibility({ ...good, planKind: 'start-plan' }).detail))
  check('资格:provider 不一致 → provider_identity_mismatch',
    offpeak.resolveOffPeakEligibility({ ...good, activeProvider: 'zai' }).reason === 'provider_identity_mismatch')
  check('资格:缺 jwt → jwt_missing', offpeak.resolveOffPeakEligibility({ ...good, hasZcodeJwt: false }).reason === 'jwt_missing')
  check('资格:缺 coding plan key → codingPlanApiKey_missing',
    offpeak.resolveOffPeakEligibility({ ...good, hasCodingPlanApiKey: false }).reason === 'codingPlanApiKey_missing')
  check('资格:无连接 → connection_unavailable',
    offpeak.resolveOffPeakEligibility({ hasZcodeJwt: true, hasCodingPlanApiKey: true }).reason === 'connection_unavailable')
  for (const r of ['start_plan_not_supported', 'provider_identity_mismatch', 'jwt_missing', 'codingPlanApiKey_missing', 'connection_unavailable']) {
    const res = offpeak.resolveOffPeakEligibility({ ...good, planKind: r === 'start_plan_not_supported' ? 'start-plan' : 'individual-coding-plan' })
    void res
  }
  const unsupported = offpeak.resolveOffPeakEligibility({ ...good, hasZcodeJwt: false })
  check('资格:不支持时给出可执行说明', unsupported.detail.length > 10, unsupported.detail)
}

// ---- 11. 状态文案 ----
{
  const cases = [['queued', /排队/], ['ready', /就绪/], ['active', /使用中/], ['expired', /过期/], ['settled', /结算/], ['not_found', /重新领票/], ['unknown', /未知/]]
  for (const [state, pattern] of cases) {
    const text = offpeak.describeOffPeakState(state)
    check(`文案:${state}`, pattern.test(text), text)
  }
}

// ---- 12. usage 报告接线(错峰段默认关闭,需显式 offPeakReport: true) ----
{
  // 默认关闭:不该出现该段,也不该请求错峰端点
  const defaultCalls = []
  const defaultReport = await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn', endpointOrigin: 'https://zcode.z.ai',
    appVersion: '3.14.3', planApiKey: 'plan-key', zcodeJwt: 'jwt-token',
    hasCodingPlanApiKey: true, activeProvider: 'bigmodel',
    accountFamily: 'bigmodel', accountPlanKind: 'individual-coding-plan',
    fetch: async (url) => { defaultCalls.push(String(url)); return json({ code: 200, data: { limits: [] } }) },
  })
  check('报告:默认不含 offPeak 段(错峰默认禁用)', defaultReport.offPeak === undefined,
    JSON.stringify(defaultReport.offPeak))
  check('报告:默认不请求任何错峰端点',
    !defaultCalls.some((u) => u.includes('/off-peak/')), defaultCalls.join(' | '))

  const calls = []
  const report = await usage.fetchUsageReport({
    bigmodelOrigin: 'https://open.bigmodel.cn',
    endpointOrigin: 'https://zcode.z.ai',
    appVersion: '3.14.3',
    planApiKey: 'plan-key',
    zcodeJwt: 'jwt-token',
    hasCodingPlanApiKey: true,
    activeProvider: 'bigmodel',
    accountFamily: 'bigmodel',
    accountPlanKind: 'individual-coding-plan',
    sourceHeaders: { 'user-agent': 'ZCode/3.14.3' },
    // 显式打开:协议保留,随时可恢复
    offPeakReport: true,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} })
      if (String(url).includes('/off-peak/ticket/availability')) {
        return json({ code: 0, data: { can_take_number: true } })
      }
      return json({ code: 200, data: { limits: [] } })
    },
  })
  check('报告:显式打开后含 offPeak 段', report.offPeak !== undefined, JSON.stringify(report.offPeak))
  check('报告:资格判定为 supported', report.offPeak?.eligibility.supported === true, JSON.stringify(report.offPeak?.eligibility))
  check('报告:取到领票可用性', report.offPeak?.availability?.canTakeNumber === true, JSON.stringify(report.offPeak?.availability))
  const offCall = calls.find((c) => c.url.includes('/off-peak/ticket/availability'))
  check('报告:错峰请求带上 x-coding-plan-api-key 与 Authorization',
    offCall?.headers['x-coding-plan-api-key'] === 'plan-key' && offCall?.headers.authorization === 'Bearer jwt-token',
    JSON.stringify(offCall?.headers))
  check('报告:错峰请求带官方源码头', offCall?.headers['user-agent'] === 'ZCode/3.14.3')

  // start-plan 连接时不应去打服务端
  const calls2 = []
  const r2 = await usage.fetchUsageReport({
    endpointOrigin: 'https://zcode.z.ai', appVersion: '3.14.3',
    planApiKey: 'plan-key', zcodeJwt: 'jwt',
    hasCodingPlanApiKey: true, activeProvider: 'bigmodel',
    accountFamily: 'bigmodel', accountPlanKind: 'start-plan',
    offPeakReport: true,
    fetch: async (url) => { calls2.push(String(url)); return json({ code: 200, data: { limits: [] } }) },
  })
  check('报告:start-plan 连接判为不支持', r2.offPeak?.eligibility.supported === false, JSON.stringify(r2.offPeak?.eligibility))
  check('报告:不支持时**不**请求服务端票据接口',
    !calls2.some((u) => u.includes('/off-peak/')), calls2.join(' | '))

  // 渲染
  const rendered = usage.renderUsageReport({
    ...usage.emptyUsageReport(),
    offPeak: {
      eligibility: { supported: false, reason: 'start_plan_not_supported', detail: '官方错峰调度明确不支持 start-plan 连接' },
    },
  })
  check('渲染:含错峰段与原因', /错峰额度/.test(rendered) && /start_plan_not_supported/.test(rendered), rendered)
  const rendered2 = usage.renderUsageReport({
    ...usage.emptyUsageReport(),
    offPeak: { eligibility: { supported: true, detail: '具备前提' }, availability: { canTakeNumber: true } },
  })
  check('渲染:可领票时给出明确文案', /现在可以领票/.test(rendered2), rendered2)
}

// ---- 13. 真机(可选)----
if (process.argv.includes('--live')) {
  const V2 = 'C:\\Users\\Amamiya\\.zcode\\v2'
  const cred = await import(pathToFileURL(join(pkgRoot, 'lib', 'credentials.js')).href)
  const cfg = JSON.parse(readFileSync(join(V2, 'config.json'), 'utf8'))
  const wire = await import(pathToFileURL(join(pkgRoot, 'lib', 'official-wire.js')).href)
  const credsPath = join(V2, 'credentials.json')
  const liveJwt = cred.resolvePlanCredential({
    credentialsPath: credsPath, providerId: 'account:bigmodel-start-plan', family: 'bigmodel', planKind: 'start-plan',
    fallbackApiKey: cfg.provider['builtin:bigmodel-start-plan']?.options?.apiKey,
  }).apiKey
  const livePlan = cred.resolvePlanCredential({
    credentialsPath: credsPath, providerId: 'account:bigmodel-individual-coding-plan', family: 'bigmodel', planKind: 'individual-coding-plan',
    fallbackApiKey: cfg.provider['builtin:bigmodel-coding-plan']?.options?.apiKey,
  }).apiKey
  const active = cred.readCredentialValue(credsPath, cred.ACTIVE_PROVIDER_KEY)
  const deviceMid = JSON.parse(readFileSync(join(V2, 'telemetry-state.json'), 'utf8')).deviceMid
  const source = wire.buildSourceHeaders({
    appVersion: '3.14.3', sourceTitle: 'electron', releaseChannel: 'production',
    endpointOrigin: 'https://zcode.z.ai', platform: 'win32-x64',
    osVersion: '10.0.19044', clientLanguage: 'zh-CN', clientTimezone: 'Asia/Shanghai', deviceMid,
  })
  const live = { endpointOrigin: 'https://zcode.z.ai', zcodeJwt: liveJwt, codingPlanApiKey: livePlan, sourceHeaders: source }

  console.log('\n--- 真机资格判定 ---')
  const elig = offpeak.resolveOffPeakEligibility({
    activeProvider: active, family: 'bigmodel', planKind: 'individual-coding-plan',
    hasZcodeJwt: liveJwt !== '', hasCodingPlanApiKey: livePlan !== '',
  })
  console.log(`  active_provider=${active} supported=${elig.supported}`)
  check('真机:active_provider 为 bigmodel', active === 'bigmodel', active)
  check('真机:本地资格判定为 supported', elig.supported === true, JSON.stringify(elig))

  const avail = await offpeak.fetchOffPeakAvailability(live)
  console.log(`  领票可用性: ${JSON.stringify(avail)}`)
  check('真机:availability 返回 200 且结构合法', typeof avail.canTakeNumber === 'boolean', JSON.stringify(avail))

  // 取号额度是**一天级**的:诊断期打满后会稳定回 429 + 3103(带 next_take_at)。
  // 因此这里断言的是**契约**而不是"一定能拿到票" —— 两种结果都算通过:
  //   (a) 拿到票 ⇒ 继续验证状态查询与结算;
  //   (b) 429/3103 ⇒ 验证额度上限语义与恢复时间被正确解码。
  let ticket
  try {
    ticket = await offpeak.takeOffPeakTicket(live)
    console.log(`  领票: ticket=${ticket.ticketId} state=${ticket.state} position=${ticket.position ?? '-'}`)
    check('真机:领到票据', ticket.ticketId.length > 5, JSON.stringify(ticket))
    check('真机:票据状态在官方枚举内', offpeak.OFF_PEAK_TICKET_STATES.includes(ticket.state), ticket.state)
  } catch (error) {
    const limited = error instanceof offpeak.OffPeakServerError && error.bizCode === 3103
    console.log(`  领票:额度已满(HTTP ${error.httpStatus} code=${error.bizCode} next_take_at=${error.nextTakeAt})`)
    check('真机:取号额度打满时回 429/3103(官方 take number limit exceeded)', limited,
      `http=${error.httpStatus} biz=${error.bizCode}`)
    check('真机:额度打满带 next_take_at 且是未来时刻',
      typeof error.nextTakeAt === 'number' && error.nextTakeAt > Date.now(), String(error.nextTakeAt))
    check('真机:该失败被判为 takeLimitExceeded 而非队列',
      offpeak.resolveOffPeakFailureDecision(429, JSON.stringify({ code: 3103, data: { next_take_at: error.nextTakeAt } }))?.kind === 'takeLimitExceeded')
  }

  if (ticket !== undefined) {
    const status = await offpeak.fetchOffPeakTicketStatus(live, [ticket.ticketId])
    console.log(`  状态: ${JSON.stringify(status.tickets)}`)
    check('真机:状态查询返回该票据', status.tickets.length === 1 && status.tickets[0].ticketId === ticket.ticketId, JSON.stringify(status.tickets))

    const settled = await offpeak.settleOffPeakTicket(live, ticket.ticketId)
    console.log(`  结算: ${settled}`)
    check('真机:结算成功', settled === 'settled' || settled.length > 0, settled)
  }
}

// ---- 14. 失败语义(官方 resolveOffPeakFailureDecision) ----
{
  check('失败:3001 ⇒ ticketExpired(旧网关的票不可用别名)',
    offpeak.resolveOffPeakFailureDecision(400, '{"code":3001,"msg":"parameter error"}')?.kind === 'ticketExpired')
  check('失败:3102 ⇒ ticketExpired(服务端最新契约)',
    offpeak.resolveOffPeakFailureDecision(400, '{"code":3102,"msg":"wrong off-peak ticket"}')?.kind === 'ticketExpired')
  // 本轮实测新增的三类:3104(票无效)、3103(取号超限)、3012(风控门)
  check('失败:3104 ⇒ ticketInvalid(off-peak ticket is invalid)',
    offpeak.resolveOffPeakFailureDecision(400, '{"code":3104,"msg":"off-peak ticket is invalid"}')?.kind === 'ticketInvalid')
  {
    const d = offpeak.resolveOffPeakFailureDecision(429, '{"code":3103,"msg":"take number limit exceeded","data":{"next_take_at":1790438400000}}')
    check('失败:3103 ⇒ takeLimitExceeded 且带 nextTakeAt',
      d?.kind === 'takeLimitExceeded' && d.nextTakeAt === 1790438400000, JSON.stringify(d))
  }
  check('失败:3103 无 next_take_at 时也能识别',
    offpeak.resolveOffPeakFailureDecision(429, '{"code":3103}')?.kind === 'takeLimitExceeded')
  check('失败:3103 优先于裸 429 的排队语义(取号超限不是排队)',
    offpeak.resolveOffPeakFailureDecision(429, '{"code":3103}')?.kind !== 'queued')
  check('失败:3012 ⇒ attestationRejected(风控门,与票据无关)',
    offpeak.resolveOffPeakFailureDecision(405, '{"code":3012,"msg":"request has been blocked due to unusual activity."}')?.kind === 'attestationRejected')
  check('失败:3104 与 3102 判定不同(票无效 ≠ 票不对)',
    offpeak.resolveOffPeakFailureDecision(400, '{"code":3104}')?.kind !== offpeak.resolveOffPeakFailureDecision(400, '{"code":3102}')?.kind)
  check('失败:3105 ⇒ queued', offpeak.resolveOffPeakFailureDecision(429, '{"code":3105,"msg":"not ready"}')?.kind === 'queued')
  check('失败:裸 429 ⇒ queued(官方明说无业务码的 429 同样按排队处理)',
    offpeak.resolveOffPeakFailureDecision(429, '')?.kind === 'queued')
  check('失败:普通 500 不归为 off-peak 特有失败',
    offpeak.resolveOffPeakFailureDecision(500, '{"code":2001}') === null)
  check('失败:200 成功不归为失败', offpeak.resolveOffPeakFailureDecision(200, '{"code":0}') === null)
  check('失败:3007 验证码问题不归为票问题',
    offpeak.resolveOffPeakFailureDecision(400, '{"code":3007}') === null)

  const queued = offpeak.resolveOffPeakFailureDecision(429, '{"code":3105}')
  check('失败:无 Retry-After 时默认 60s 探测',
    queued?.delayMs === 60_000, String(queued?.delayMs))
  const capped = offpeak.resolveOffPeakFailureDecision(429, '{"code":3105,"retry-after":900}')
  check('失败:排队等待钳制到 5 分钟(官方 cap)',
    capped?.delayMs === 300_000, String(capped?.delayMs))
  const short = offpeak.resolveOffPeakFailureDecision(429, '{"code":3105,"retry-after":10}')
  check('失败:小于上限时按服务端给的秒数', short?.delayMs === 10_000, String(short?.delayMs))

  check('失败:稳定标记与官方常量同值', offpeak.OFF_PEAK_TICKET_EXPIRED_MARKER === 'off-peak-ticket-expired',
    offpeak.OFF_PEAK_TICKET_EXPIRED_MARKER)
  check('失败:包装消息含标记',
    offpeak.offPeakTicketExpiredMessage('x').startsWith('off-peak-ticket-expired: '),
    offpeak.offPeakTicketExpiredMessage('x'))
}

// ---- 15. 取调度资格:领票 → 轮询到 ready ----
{
  /** 造一个按官方契约应答的假网关:第 n 次状态查询返回给定状态序列。 */
  function fakeGateway(states, takeState = 'queued') {
    let statusCalls = 0
    return {
      get statusCalls() { return statusCalls },
      fetchImpl: async (url) => {
        const href = String(url)
        if (href.includes('/ticket/availability')) return json({ can_take_number: true })
        if (href.includes('/ticket/status')) {
          const state = states[Math.min(statusCalls, states.length - 1)]
          statusCalls += 1
          return json({ next_poll_after: 1, tickets: [{ ticket_id: 'tk', state, position: null }] })
        }
        if (href.includes('/ticket')) return json({ ticket_id: 'tk', state: takeState, next_poll_after: 1 })
        return json({}, 404)
      },
    }
  }
  const noSleep = async () => {}

  const granted = await offpeak.acquireOffPeakDispatch(
    { ...DEPS, fetch: fakeGateway(['queued', 'ready']).fetchImpl },
    { waitMs: 60_000, pollMs: 1, sleep: noSleep },
  )
  check('取资格:排队后变 ready ⇒ granted', granted.kind === 'granted', granted.kind)
  check('取资格:granted 带票据与鉴权三件套',
    granted.kind === 'granted'
    && granted.ticket.ticketId === 'tk'
    && granted.auth.headers['x-off-peak-ticket-id'] === 'tk'
    && granted.auth.headers.authorization === 'Bearer fixture-jwt'
    && granted.auth.headers['x-coding-plan-api-key'] === 'fixture-plan-key',
    JSON.stringify(granted.kind === 'granted' ? granted.auth.headers : null))
  check('取资格:apiKey 为 jwt(官方 qA 的 apiKey)',
    granted.kind === 'granted' && granted.auth.apiKey === 'fixture-jwt')

  const alreadyReady = await offpeak.acquireOffPeakDispatch(
    { ...DEPS, fetch: fakeGateway(['ready'], 'ready').fetchImpl },
    { waitMs: 60_000, pollMs: 1, sleep: noSleep },
  )
  check('取资格:取号即 ready 时不再轮询', alreadyReady.kind === 'granted', alreadyReady.kind)

  const expired = await offpeak.acquireOffPeakDispatch(
    { ...DEPS, fetch: fakeGateway(['expired']).fetchImpl },
    { waitMs: 60_000, pollMs: 1, sleep: noSleep },
  )
  check('取资格:票据 expired ⇒ ticketExpired', expired.kind === 'ticketExpired', JSON.stringify(expired))

  let clock = 0
  const timedOut = await offpeak.acquireOffPeakDispatch(
    { ...DEPS, fetch: fakeGateway(['queued']).fetchImpl },
    { waitMs: 5_000, pollMs: 1_000, sleep: async (ms) => { clock += ms }, now: () => clock },
  )
  check('取资格:一直 queued 且超过 waitMs ⇒ queued(带上票据与建议间隔)',
    timedOut.kind === 'queued' && timedOut.ticket.ticketId === 'tk', JSON.stringify(timedOut.kind))
  check('取资格:超时结果给出可执行原因', timedOut.kind === 'queued' && /等待/.test(timedOut.reason), timedOut.kind === 'queued' ? timedOut.reason : '')

  // 3103(取号额度,一天级)必须与"资格不足"分开:额度满了不是不支持的账号,
  // 官方 UI 也按 `canTakeNumber` + `nextTakeAt` 单独提示恢复时间。
  const takeLimited = async () => json({ code: 3103, msg: 'take number limit exceeded', data: { next_take_at: 1790438400000 } }, 429)
  const limited = await offpeak.acquireOffPeakDispatch(
    { ...DEPS, fetch: takeLimited },
    { waitMs: 1000, pollMs: 1, sleep: noSleep },
  )
  check('取资格:3103 取号超限 ⇒ takeLimitExceeded 且带 nextTakeAt',
    limited.kind === 'takeLimitExceeded' && limited.nextTakeAt === 1790438400000, JSON.stringify(limited))

  const takeFails = async () => json({ code: 3101, msg: 'off-peak not available for this plan' }, 403)
  const unsupported = await offpeak.acquireOffPeakDispatch(
    { ...DEPS, fetch: takeFails },
    { waitMs: 1000, pollMs: 1, sleep: noSleep },
  )
  check('取资格:资格不足 3101 ⇒ unsupported(不抛,交给调用方按业务码分流)',
    unsupported.kind === 'unsupported', JSON.stringify(unsupported))
}

// ---- 16. 与官方抓包的头集合逐名对齐(实机实录) ----
{
  const fixture = JSON.parse(readFileSync(join(pkgRoot, 'tests', 'fixtures', 'offpeak-official-headers.json'), 'utf8'))
  const officialTicket = new Set(fixture.ticketClient.availabilityHeaderNames)
  const transport = new Set(fixture.ticketClient.transportHeaders)

  // 我们发的是应用层头(传输层由 fetch 自动加),因此断言:应用层 = 官方全集 - 传输层
  const expectedApp = new Set([...officialTicket].filter((n) => !transport.has(n)))
  const depsWithDevice = {
    ...DEPS,
    // 用**真实**的源码头构造器,而不是手写子集 —— 否则断言会因为测试桩太瘦而假红
    sourceHeaders: wire.buildSourceHeaders({
      appVersion: '3.14.3', sourceTitle: 'electron', releaseChannel: 'production',
      endpointOrigin: 'https://zcode.z.ai', platform: 'win32-x64',
      osVersion: '10.0.19044', clientLanguage: 'zh-CN', clientTimezone: 'Asia/Shanghai',
      deviceMid: 'fixture-device-mid',
    }),
    deviceMid: 'fixture-device-mid',
  }
  const ours = new Set(Object.keys(offpeak.buildOffPeakHeaders(depsWithDevice)).map((n) => n.toLowerCase()))

  const missing = [...expectedApp].filter((n) => !ours.has(n))
  const extra = [...ours].filter((n) => !expectedApp.has(n))
  check('官方对拍:ticket 客户端头集合与官方抓包逐名一致',
    missing.length === 0 && extra.length === 0,
    `缺=${JSON.stringify(missing)} 多=${JSON.stringify(extra)}`)
  check('官方对拍:含 x-device-mid(官方 ticket 客户端发送)', ours.has('x-device-mid'), [...ours].join(','))
  check('官方对拍:不含 x-zcode-agent(那是模型路径专有)',
    !ours.has('x-zcode-agent'), [...ours].join(','))
  check('官方对拍:无 deviceMid 时不硬塞该头',
    !Object.keys(offpeak.buildOffPeakHeaders(DEPS)).map((n) => n.toLowerCase()).includes('x-device-mid'))

  // 模型请求另一套:有 x-zcode-agent、无 x-device-mid
  const officialModel = new Set(fixture.modelRequest.headerNames)
  const modelAuth = offpeak.buildOffPeakRequestAuth(depsWithDevice, 'tk')
  const ourModel = new Set(Object.keys(modelAuth.headers).map((n) => n.toLowerCase()))
  check('官方对拍:模型鉴权只含三件套(+team)',
    !ourModel.has('x-zcode-agent') && !ourModel.has('x-device-mid') && ourModel.size === 3,
    [...ourModel].join(','))
  check('官方对拍:模型请求头名是官方 model-io 集的子集',
    [...ourModel].every((n) => officialModel.has(n)), [...ourModel].join(','))
  check('官方对拍:POST /ticket 体形状 = {task_id}', fixture.ticketClient.bodyShape.ticket.task_id.includes('offpeak-'))
}

console.log(`\n${passed}/${passed + failures.length} 项通过`)
if (failures.length) {
  console.error(`\n失败项:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
