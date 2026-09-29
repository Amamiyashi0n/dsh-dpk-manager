/**
 * zcode 的**错峰 / 空闲额度(off-peak, Idle plan)票据协议**。
 *
 * 这是"用上 Start Plan / 空闲额度"的正路:模型请求不是直接打的,而是要先向服务端
 * 领一张票,再由网关按票接纳。全部契约来自 `app.asar` 实证(函数名即原文):
 *
 * ```js
 * // createOffPeakServerClient 的 request():
 * const cred = await resolveCredentials()        // Dd / resolveOffPeakCredentials
 * const origin = await resolveOrigin()           // 生产=zcode origin;测试=本地 mock
 * headers = { ...buildZCodeSourceHeaders(),      // zy()
 *             authorization: `Bearer ${cred.jwt}`,
 *             "x-coding-plan-api-key": cred.codingPlanApiKey,
 *             ...buildOffPeakPlanIdentityHeaders(cred),   // 仅 team
 *             "x-request-id" }
 * fetch(`${origin}/api/v1/off-peak${path}`, { method, headers, body })
 * ```
 *
 * 端点:
 * - `GET  /api/v1/off-peak/ticket/availability`            → `{can_take_number, next_take_at?}`
 * - `POST /api/v1/off-peak/ticket`      `{task_id}`        → `{ticket_id, state, position?, next_poll_after?}`
 * - `POST /api/v1/off-peak/ticket/status` `{ticket_ids}`   → `{next_poll_after?, tickets[]}`
 * - `POST /api/v1/off-peak/ticket/<id>/settle`
 *
 * 票据状态机:`queued → ready → (被网关接纳) active → settled`;`expired` / `not_found` 为异常终态。
 * 模型请求需要 `buildOffPeakRequestAuth()`(`qA`)产出的三个头。
 *
 * 凭证前置(与官方 `resolveOffPeakCredentials` 同口径):
 * - `oauth:active_provider` 必须等于该 provider 的 family;
 * - 必须有 `zcodejwttoken`;
 * - 必须能解析出账号 individual/team coding plan 的 api key。
 * 注意官方 `resolveSelectedOffPeakCodingPlan()` 对 `planKind === "start-plan"` 直接抛
 * `start_plan_not_supported` —— 错峰通道走的是 **coding plan 连接**,不是 start-plan 连接。
 *
 * @module zcode-provider/offpeak
 */
import { randomUUID } from 'node:crypto';
/** off-peak 接口基路径(官方客户端 `${origin}/api/v1/off-peak${path}`)。 */
export const OFF_PEAK_BASE_PATH = '/api/v1/off-peak';
/** 携带 coding plan api key 的头(官方 `qA`)。 */
export const OFF_PEAK_CODING_PLAN_HEADER = 'x-coding-plan-api-key';
/** 携带票据 id 的头(官方 `qA`;引擎把它列入脱敏名单)。 */
export const OFF_PEAK_TICKET_HEADER = 'x-off-peak-ticket-id';
/** 设备标识头:官方 **ticket 客户端**发送(模型请求不发),抓包实录。 */
export const OFF_PEAK_DEVICE_MID_HEADER = 'x-device-mid';
/** 任务 id 前缀(官方 `offpeak-${randomUUID()}`)。 */
export const OFF_PEAK_TASK_ID_PREFIX = 'offpeak-';
/** 客户端请求超时(官方 `dbe = 1e4`)。 */
export const OFF_PEAK_REQUEST_TIMEOUT_MS = 10_000;
/** team 计划的身份头(官方 `buildOffPeakPlanIdentityHeaders`)。 */
export const OFF_PEAK_TEAM_HEADERS = { organization: 'bigmodel-organization', project: 'bigmodel-project' };
/** 票据状态全集(官方 `TV`)。 */
export const OFF_PEAK_TICKET_STATES = ['queued', 'ready', 'active', 'expired', 'settled', 'not_found'];
/** 官方 `OffPeakServerError` 的等价物:保留 HTTP 状态与业务码,便于给出可执行提示。 */
export class OffPeakServerError extends Error {
    httpStatus;
    bizCode;
    nextTakeAt;
    constructor(message, 
    /** HTTP 状态码。 */
    httpStatus, 
    /** 业务码(响应体里的 `code`)。 */
    bizCode, 
    /** 限流时的下次可领时间。 */
    nextTakeAt) {
        super(message);
        this.httpStatus = httpStatus;
        this.bizCode = bizCode;
        this.nextTakeAt = nextTakeAt;
        this.name = 'OffPeakServerError';
    }
}
/** 生成任务 id(官方格式 `offpeak-<uuid>`)。 */
export function buildOffPeakTaskId() {
    return `${OFF_PEAK_TASK_ID_PREFIX}${randomUUID()}`;
}
/**
 * 组装 off-peak 请求头(官方 ticket 客户端抓包实录的**应用层头集合**)。
 *
 * 关键点一:除 `Authorization` 外还必须带 **`x-coding-plan-api-key`** ——
 * 少了它服务端只认得出「谁在请求」却认不出「用哪个套餐」。
 *
 * 关键点二:**必须带 `x-device-mid`,且不带 `x-zcode-agent`**。
 * 实测抓包(占用官方 mock 端口让官方引擎把请求打过来)得到的官方 ticket 客户端
 * 应用层头是 14 个:`authorization, http-referer, user-agent, x-client-language,
 * x-client-timezone, x-coding-plan-api-key, x-device-mid, x-os-category, x-os-version,
 * x-platform, x-release-channel, x-request-id, x-title, x-zcode-app-version`
 * (另有 6 个由 Electron net 自动附加:accept / accept-encoding / accept-language /
 * connection / host / sec-fetch-mode)。模型请求走的是另一套(见 `buildOffPeakRequestAuth`),
 * 那边**有** `x-zcode-agent`、**没有** `x-device-mid` —— 两条路径不同,不要混用。
 * @param deps - 端点与凭证。
 * @returns 请求头。
 */
export function buildOffPeakHeaders(deps) {
    const organization = deps.organizationId?.trim() ?? '';
    const project = deps.projectId?.trim() ?? '';
    // 模型路径专有的 x-zcode-agent 不属于 ticket 客户端;device-mid 反之。
    const { 'x-zcode-agent': _dropAgent, 'X-ZCode-Agent': _dropAgentUpper, ...source } = deps.sourceHeaders ?? {};
    return {
        ...source,
        authorization: `Bearer ${deps.zcodeJwt}`,
        [OFF_PEAK_CODING_PLAN_HEADER]: deps.codingPlanApiKey,
        'x-request-id': randomUUID(),
        ...(deps.deviceMid === undefined || deps.deviceMid.trim() === '' ? {} : { [OFF_PEAK_DEVICE_MID_HEADER]: deps.deviceMid.trim() }),
        // team 计划才有组织/项目身份头(官方 KA 对非 team 返回空对象)
        ...(organization === '' || project === '' ? {} : {
            [OFF_PEAK_TEAM_HEADERS.organization]: organization,
            [OFF_PEAK_TEAM_HEADERS.project]: project,
        }),
    };
}
/**
 * 组装**模型请求**的 off-peak 鉴权(官方 `qA` / `buildOffPeakRequestAuth`)。
 * @param deps - 端点与凭证。
 * @param ticketId - 已领到的票据 id。
 * @returns `apiKey` 与要附加到模型请求上的头。
 */
export function buildOffPeakRequestAuth(deps, ticketId) {
    const organization = deps.organizationId?.trim() ?? '';
    const project = deps.projectId?.trim() ?? '';
    return {
        apiKey: deps.zcodeJwt,
        headers: {
            authorization: `Bearer ${deps.zcodeJwt}`,
            [OFF_PEAK_CODING_PLAN_HEADER]: deps.codingPlanApiKey,
            [OFF_PEAK_TICKET_HEADER]: ticketId,
            ...(organization === '' || project === '' ? {} : {
                [OFF_PEAK_TEAM_HEADERS.organization]: organization,
                [OFF_PEAK_TEAM_HEADERS.project]: project,
            }),
        },
    };
}
/**
 * 解释 off-peak 响应体,逐字对齐官方客户端 `n()` 的返回:
 *
 * ```js
 * return g && typeof g === "object" && "data" in g && g.code === 0 ? g.data : g
 * ```
 *
 * 即:**只有**「是对象 + 有 `data` + `code === 0`」才拆信封,否则原样返回整个对象。
 * 这一点必须照抄:真实服务端回 `{code:0,msg,data:{...}}`,而官方内置 mock 网关
 * 直接回裸对象(`{can_take_number:true}`)。写成"总是取 data"会把 mock 的裸响应
 * 解成 `undefined`(本模块首次对跑官方 mock 网关时正是这样暴露的)。
 */
function unwrapEnvelope(payload) {
    if (payload === null || typeof payload !== 'object')
        return { ok: false, value: undefined };
    const record = payload;
    const code = typeof record.code === 'number' ? record.code : undefined;
    const msg = typeof record.msg === 'string' ? record.msg : typeof record.message === 'string' ? record.message : undefined;
    const meta = { ...(code === undefined ? {} : { code }), ...(msg === undefined ? {} : { msg }) };
    if ('data' in record && code === 0)
        return { ok: true, value: record.data, ...meta };
    // 有业务码且非 0 ⇒ 失败;没有业务码 ⇒ 按裸对象成功处理(与官方 `g.code===0` 的判定等价)
    return { ok: code === undefined || code === 0, value: payload, ...meta };
}
/** 发一次 off-peak 客户端请求(官方 `n()`)。 */
async function offPeakRequest(deps, method, path, body) {
    const doFetch = deps.fetch ?? fetch;
    const headers = {
        ...buildOffPeakHeaders(deps),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    const response = await doFetch(`${deps.endpointOrigin}${OFF_PEAK_BASE_PATH}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? OFF_PEAK_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let payload;
    try {
        payload = text === '' ? undefined : JSON.parse(text);
    }
    catch (_notJson) {
        payload = undefined;
    }
    const envelope = unwrapEnvelope(payload);
    if (!response.ok) {
        const nextTakeAt = readNextTakeAt(payload);
        deps.log?.(`zcode-provider: off-peak ${path} 被拒 HTTP ${response.status}${envelope.code === undefined ? '' : ` code=${envelope.code}`}${envelope.msg === undefined ? '' : ` ${envelope.msg}`}`);
        throw new OffPeakServerError(`off-peak ${path} 失败:HTTP ${response.status}${envelope.code === undefined ? '' : ` code=${envelope.code}`}${envelope.msg === undefined ? '' : ` ${envelope.msg}`}`, response.status, envelope.code, nextTakeAt);
    }
    return envelope.value;
}
/** 从错误体里读 `next_take_at`(顶层或 `data` 内,官方两处都读)。 */
function readNextTakeAt(payload) {
    if (payload === null || typeof payload !== 'object')
        return undefined;
    const record = payload;
    const top = record.next_take_at;
    if (typeof top === 'number' && Number.isFinite(top))
        return top;
    const nested = record.data?.next_take_at;
    return typeof nested === 'number' && Number.isFinite(nested) ? nested : undefined;
}
/** 读 number 字段。 */
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** 读非空 string 字段。 */
function str(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
/**
 * 查领票可用性(官方 `getTakeNumberAvailability`)。
 * @param deps - 端点与凭证。
 * @returns 可用性与下次可领时间。
 */
export async function fetchOffPeakAvailability(deps) {
    const data = await offPeakRequest(deps, 'GET', '/ticket/availability');
    const canTake = data?.can_take_number === true;
    const nextTakeAt = num(data?.next_take_at);
    if (!canTake && nextTakeAt === undefined) {
        throw new OffPeakServerError('off-peak availability 返回不可领但没有 next_take_at,无法判断何时重试', 200);
    }
    return { canTakeNumber: canTake, ...(nextTakeAt === undefined ? {} : { nextTakeAt }) };
}
/**
 * 领一张票(官方 `takeTicket`)。票据是一次性的调度凭据,领到后要轮询到 `ready` 才能用。
 * @param deps - 端点与凭证。
 * @param taskId - 任务 id;缺省按官方格式生成。
 * @returns 票据。
 */
export async function takeOffPeakTicket(deps, taskId) {
    const id = taskId ?? buildOffPeakTaskId();
    const data = await offPeakRequest(deps, 'POST', '/ticket', { task_id: id });
    const ticketId = str(data?.ticket_id);
    if (ticketId === undefined)
        throw new OffPeakServerError('off-peak take ticket 未返回 ticket_id', 200);
    const state = str(data?.state);
    const nextPollAfter = num(data?.next_poll_after);
    return {
        ticketId,
        ...(str(data?.task_id) === undefined ? {} : { taskId: str(data?.task_id) }),
        state: OFF_PEAK_TICKET_STATES.includes(state ?? '') ? state : 'unknown',
        ...(num(data?.position) === undefined ? {} : { position: num(data?.position) }),
        ...(nextPollAfter === undefined ? {} : { nextPollAfterMs: nextPollAfter * 1000 }),
    };
}
/**
 * 批量查票据状态(官方 `batchStatus`;官方最多一次 100 个)。
 * @param deps - 端点与凭证。
 * @param ticketIds - 票据 id 列表。
 * @returns 票据状态与下次轮询间隔。
 */
export async function fetchOffPeakTicketStatus(deps, ticketIds) {
    if (ticketIds.length === 0)
        return { tickets: [] };
    const ids = ticketIds.slice(0, 100);
    if (ids.length < ticketIds.length)
        deps.log?.(`zcode-provider: off-peak 状态查询被截断 ${ticketIds.length} → 100`);
    const data = await offPeakRequest(deps, 'POST', '/ticket/status', { ticket_ids: ids });
    const raw = Array.isArray(data?.tickets) ? data.tickets : [];
    const tickets = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const ticketId = str(record.ticket_id);
        if (ticketId === undefined)
            continue;
        const state = str(record.state);
        const activeDeadline = num(record.active_deadline);
        const position = num(record.position);
        tickets.push({
            ticketId,
            ...(str(record.task_id) === undefined ? {} : { taskId: str(record.task_id) }),
            state: OFF_PEAK_TICKET_STATES.includes(state ?? '') ? state : 'unknown',
            ...(position === undefined ? {} : { position }),
            ...(activeDeadline === undefined ? {} : { activeDeadline }),
        });
    }
    const nextPollAfter = num(data?.next_poll_after);
    return { tickets, ...(nextPollAfter === undefined ? {} : { nextPollAfterMs: nextPollAfter * 1000 }) };
}
/**
 * 结算票据(官方 `settle`)。跑完一段空闲任务后必须调用,否则票会占着名额。
 * @param deps - 端点与凭证。
 * @param ticketId - 票据 id。
 * @returns 结算结果状态。
 */
export async function settleOffPeakTicket(deps, ticketId) {
    const data = await offPeakRequest(deps, 'POST', `/ticket/${encodeURIComponent(ticketId)}/settle`);
    return str(data?.state) ?? 'settled';
}
/**
 * 复刻官方 `resolveSelectedOffPeakCodingPlan` + `resolveOffPeakCredentials` 的前置判定。
 *
 * 顺序与官方一致:先看连接是否存在,再看 planKind( **start-plan 明确不支持** ),
 * 再比对 `oauth:active_provider` 与 family,最后要求 jwt 与 coding plan key 都在。
 * @param input - 本地可见的素材。
 * @returns 判定结果与可执行说明。
 */
export function resolveOffPeakEligibility(input) {
    if (input.family === undefined || input.planKind === undefined) {
        return { supported: false, reason: 'connection_unavailable', detail: '没有可用的账号连接:先在 zcode 客户端登录并连接套餐。' };
    }
    if (input.planKind === 'start-plan') {
        return {
            supported: false,
            reason: 'start_plan_not_supported',
            detail: '官方错峰调度明确不支持 start-plan 连接(引擎 `resolveSelectedOffPeakCodingPlan` 直接抛 start_plan_not_supported);'
                + '错峰走的是账号的 coding plan 连接。',
        };
    }
    if (input.activeProvider !== input.family) {
        return {
            supported: false,
            reason: 'provider_identity_mismatch',
            detail: `账号当前选中的 provider 是 ${input.activeProvider ?? '(空)'},与该套餐族 ${input.family} 不一致;`
                + '请在 zcode 客户端把该族设为当前账号。',
        };
    }
    if (!input.hasZcodeJwt) {
        return { supported: false, reason: 'jwt_missing', detail: '缺少 zcodejwttoken:请先在 zcode 客户端登录账号。' };
    }
    if (!input.hasCodingPlanApiKey) {
        return { supported: false, reason: 'codingPlanApiKey_missing', detail: '缺少账号 coding plan api key:请先在 zcode 客户端连接 coding plan。' };
    }
    return { supported: true, detail: '具备走错峰空闲额度的本地前提(仍需服务端下发票据)。' };
}
/** 票据状态的中文说明(含可执行下一步)。 */
export function describeOffPeakState(state) {
    switch (state) {
        case 'queued': return '排队中:服务端尚未放行,按 next_poll_after 继续轮询';
        case 'ready': return '已就绪:可以携带该票据发起 off-peak 模型请求';
        case 'active': return '使用中:票据已被网关接纳,在 active_deadline 之前有效';
        case 'expired': return '已过期:票据失效,需要重新领票';
        case 'settled': return '已结算:本次空闲任务已归还名额';
        case 'not_found': return '服务端不认识这张票据:需要重新领票';
        default: return '未知状态:服务端返回了未在官方枚举内的值';
    }
}
/** 票据不可用的稳定标记(与官方 `OFF_PEAK_TICKET_EXPIRED_MARKER` 同值,跨进程可识别)。 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = 'off-peak-ticket-expired';
/** 排队业务码(HTTP 429,带 `Retry-After`)。 */
export const OFF_PEAK_QUEUED_CODE = '3105';
/** 票据不可用业务码:服务端最新契约用 3102,滚更期旧网关用 3001。 */
export const OFF_PEAK_TICKET_EXPIRED_CODES = ['3102', '3001'];
/**
 * 票据**无效**业务码(HTTP 400,`off-peak ticket is invalid`)。
 *
 * 与 3102(`wrong off-peak ticket`)区分:3102 是"票不对/不归你",
 * 3104 是"票根本没通过校验"。实测出现在**假票 + 合法请求体**时,
 * 也正好是验证"请求体是否通过 3012 门"的判别信号。
 */
export const OFF_PEAK_TICKET_INVALID_CODE = '3104';
/**
 * 取号超限业务码(HTTP 429,`take number limit exceeded`,带 `data.next_take_at`)。
 *
 * 官方 UI 用 `canTakeNumber` + `nextTakeAt` 做 fail-closed 禁用与倒计时
 * (`offPeakUiPresentation.ts` 的 `resolveOffPeakCreateBlockReason`:
 * `canTakeNumber === true ? null : "quota"`)。**这是一天级的额度**,
 * 诊断期频繁取号很容易把它打满。
 */
export const OFF_PEAK_TAKE_LIMIT_CODE = '3103';
/**
 * 风控门业务码(HTTP 405,`request has been blocked due to unusual activity`)。
 *
 * 实测判据:**请求里有没有官方 agent 的系统提示词**(见 `official-prompt.ts`)。
 * 与票据无关——假票+合法体也会先过这道门再到 3104,所以它排在票据校验之前。
 */
export const OFF_PEAK_ATTESTATION_CODE = '3012';
/** 单次排队等待上限(官方 `OFF_PEAK_QUEUE_WAIT_CAP_MS` = 5min)。 */
export const OFF_PEAK_QUEUE_WAIT_CAP_MS = 5 * 60_000;
/** 无 `Retry-After` 时的排队探测间隔(官方 60s)。 */
export const OFF_PEAK_QUEUE_WAIT_DEFAULT_MS = 60_000;
/**
 * 判定 off-peak 特有失败语义,逐条对齐官方 `resolveOffPeakFailureDecision`,
 * 并补齐官方未覆盖、但实测存在的两类:
 *
 * - 业务码 **3102 或 3001** ⇒ `ticketExpired`(票据不可用:active 3h 到期 / ready 5min 废票 /
 *   已结算 / 非本人)。官方对此**不重试**,而是"同 task_id 重新取号 → resume 续跑"。
 * - 业务码 **3105** 或 **HTTP 429** ⇒ `queued`,等待 `min(Retry-After, 5min)`;
 *   无 `Retry-After` 时保守 60s。
 * - 业务码 **3104**(`off-peak ticket is invalid`)⇒ `ticketInvalid`。与 3102 同属
 *   "票不可用"家族但语义更硬:票没通过校验,重取号即可,不要当成排队。
 * - 业务码 **3103**(`take number limit exceeded`)⇒ `takeLimitExceeded`,
 *   带 `data.next_take_at`。这是**取号额度**耗尽(一天级),不是失败也不是排队;
 *   调用方应等到 `nextTakeAt` 再取,期间不要反复重试(越试越糟)。
 * - 业务码 **3012**(`unusual activity`)⇒ `attestationRejected`。这是**请求体不像
 *   官方 agent** 被挡在票据校验之前,与票据无关;正确处置是补齐官方系统提示词
 *   (见 `official-prompt.ts`),而不是重取号。
 *
 * 为什么必须区分:3001 在别处是通用的"参数错误",容易误判成"我少传了参数"并反复乱试
 * ——本模块第一版就是这样误判的。在这条通道上它只有一个含义:票不可用。
 * @param status - HTTP 状态码。
 * @param body - 响应体文本。
 * @returns 判定结果;非 off-peak 特有失败返回 `null`。
 */
export function resolveOffPeakFailureDecision(status, body) {
    const code = /"code"\s*:\s*"?(\d+)"?/.exec(body)?.[1];
    if (code === OFF_PEAK_ATTESTATION_CODE) {
        return { kind: 'attestationRejected' };
    }
    if (code === OFF_PEAK_TAKE_LIMIT_CODE) {
        const nextTakeAt = /"next_take_at"\s*:\s*(\d+)/.exec(body)?.[1];
        return {
            kind: 'takeLimitExceeded',
            ...(nextTakeAt === undefined ? {} : { nextTakeAt: Number(nextTakeAt) }),
        };
    }
    if (code === OFF_PEAK_TICKET_INVALID_CODE) {
        return { kind: 'ticketInvalid' };
    }
    if (code !== undefined && OFF_PEAK_TICKET_EXPIRED_CODES.includes(code)) {
        return { kind: 'ticketExpired' };
    }
    if (code === OFF_PEAK_QUEUED_CODE || status === 429) {
        const retryAfterSeconds = Number(/retry-after"?\s*:\s*"?(\d+)/i.exec(body)?.[1]);
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined;
        return {
            kind: 'queued',
            delayMs: Math.min(retryAfterMs ?? OFF_PEAK_QUEUE_WAIT_DEFAULT_MS, OFF_PEAK_QUEUE_WAIT_CAP_MS),
        };
    }
    return null;
}
/** 把票据不可用包装成官方稳定标记(与官方 `offPeakTicketExpiredMessage` 同形)。 */
export function offPeakTicketExpiredMessage(original) {
    return `${OFF_PEAK_TICKET_EXPIRED_MARKER}: ${original}`;
}
/**
 * 走官方正路取一次 off-peak 调度资格:领票 → 轮询到 `ready`/`active` → 产出鉴权材料。
 *
 * 与官方 `dispatchOffPeakRun` 的前半段一致(官方由 scheduler 在服务端放行时调用)。
 * **注意**:即便票据 `ready`,真实网关也只在服务端空闲窗口内接受派发;
 * 窗口外会以 3001/3102(票不可用)拒绝 —— 客户端没有任何窗口逻辑(已实证),
 * 因此调用方应当把 `ticketExpired` 当作"等下一个窗口再取号",而不是参数错误。
 * @param deps - 端点与凭证。
 * @param options - 等待与轮询参数。
 * @returns 派发结果。
 */
export async function acquireOffPeakDispatch(deps, options = {}) {
    const waitMs = options.waitMs ?? 120_000;
    const pollMs = options.pollMs ?? 3_000;
    const sleep = options.sleep ?? (async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)); });
    const now = options.now ?? (() => Date.now());
    let ticket;
    try {
        ticket = await takeOffPeakTicket(deps);
    }
    catch (error) {
        if (error instanceof OffPeakServerError) {
            // 取号额度(一天级)打满时单独分流:官方 UI 用 `canTakeNumber` + `nextTakeAt`
            // 做 fail-closed 禁用与倒计时,调用方也需要这个恢复时间去告诉用户何时再试。
            if (error.bizCode === Number(OFF_PEAK_TAKE_LIMIT_CODE)) {
                return {
                    kind: 'takeLimitExceeded',
                    ...(error.nextTakeAt === undefined ? {} : { nextTakeAt: error.nextTakeAt }),
                    reason: error.message,
                };
            }
            // 其余领票阶段拒绝(资格 3101 等)交给调用方按业务码分流
            return { kind: 'unsupported', reason: String(error.message) };
        }
        throw error;
    }
    const deadline = now() + waitMs;
    let poll = ticket.nextPollAfterMs ?? pollMs;
    while (ticket.state !== 'ready' && ticket.state !== 'active') {
        if (ticket.state === 'expired' || ticket.state === 'settled' || ticket.state === 'not_found') {
            return { kind: 'ticketExpired', reason: describeOffPeakState(ticket.state) };
        }
        if (now() >= deadline) {
            return { kind: 'queued', delayMs: poll, ticket, reason: `等待 ${waitMs}ms 仍未就绪(${describeOffPeakState(ticket.state)})` };
        }
        await sleep(poll);
        const status = await fetchOffPeakTicketStatus(deps, [ticket.ticketId]);
        const fresh = status.tickets.find((item) => item.ticketId === ticket.ticketId);
        if (fresh === undefined)
            return { kind: 'ticketExpired', reason: '服务端不再返回这张票据' };
        ticket = fresh;
        poll = Math.max(status.nextPollAfterMs ?? pollMs, pollMs);
    }
    return { kind: 'granted', ticket, auth: buildOffPeakRequestAuth(deps, ticket.ticketId) };
}
