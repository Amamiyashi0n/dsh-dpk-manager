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
/** off-peak 接口基路径(官方客户端 `${origin}/api/v1/off-peak${path}`)。 */
export declare const OFF_PEAK_BASE_PATH = "/api/v1/off-peak";
/** 携带 coding plan api key 的头(官方 `qA`)。 */
export declare const OFF_PEAK_CODING_PLAN_HEADER = "x-coding-plan-api-key";
/** 携带票据 id 的头(官方 `qA`;引擎把它列入脱敏名单)。 */
export declare const OFF_PEAK_TICKET_HEADER = "x-off-peak-ticket-id";
/** 设备标识头:官方 **ticket 客户端**发送(模型请求不发),抓包实录。 */
export declare const OFF_PEAK_DEVICE_MID_HEADER = "x-device-mid";
/** 任务 id 前缀(官方 `offpeak-${randomUUID()}`)。 */
export declare const OFF_PEAK_TASK_ID_PREFIX = "offpeak-";
/** 客户端请求超时(官方 `dbe = 1e4`)。 */
export declare const OFF_PEAK_REQUEST_TIMEOUT_MS = 10000;
/** team 计划的身份头(官方 `buildOffPeakPlanIdentityHeaders`)。 */
export declare const OFF_PEAK_TEAM_HEADERS: {
    readonly organization: "bigmodel-organization";
    readonly project: "bigmodel-project";
};
/** 票据状态全集(官方 `TV`)。 */
export declare const OFF_PEAK_TICKET_STATES: readonly ["queued", "ready", "active", "expired", "settled", "not_found"];
/** 票据状态。 */
export type OffPeakTicketState = (typeof OFF_PEAK_TICKET_STATES)[number];
/** 领票可用性。 */
export interface OffPeakAvailability {
    /** 现在是否可以领票。 */
    canTakeNumber: boolean;
    /** 不可领时的下次可领时间(epoch 毫秒,官方把 `next_take_at` 当秒处理)。 */
    nextTakeAt?: number;
}
/** 一张票据。 */
export interface OffPeakTicket {
    /** 票据 id,模型请求的 `x-off-peak-ticket-id` 用它。 */
    ticketId: string;
    /** 服务端任务 id。 */
    taskId?: string;
    /** 状态。 */
    state: OffPeakTicketState | 'unknown';
    /** 队列位置。 */
    position?: number;
    /** 距下次轮询的毫秒数(官方 `next_poll_after * 1000`)。 */
    nextPollAfterMs?: number;
    /** 被接纳后的截止时间(epoch 毫秒)。 */
    activeDeadline?: number;
}
/** 取数所需的依赖。 */
export interface OffPeakDeps {
    /** zcode 端点 origin(如 `https://zcode.z.ai`)。 */
    endpointOrigin: string;
    /** `zcodejwttoken`。 */
    zcodeJwt: string;
    /** 账号 individual/team coding plan 的 api key。 */
    codingPlanApiKey: string;
    /** 基础源码头(插件用 `buildSourceHeaders` 生成;测试可注入)。 */
    sourceHeaders?: Record<string, string>;
    /** 设备标识(`telemetry-state.json` 的 `deviceMid`);官方 ticket 客户端会发送它。 */
    deviceMid?: string;
    /** team 计划身份(仅 team 需要)。 */
    organizationId?: string;
    projectId?: string;
    /** 注入的 fetch(测试用)。 */
    fetch?: typeof fetch;
    /** 超时毫秒。 */
    timeoutMs?: number;
    /** 日志出口。 */
    log?: (message: string) => void;
}
/** 官方 `OffPeakServerError` 的等价物:保留 HTTP 状态与业务码,便于给出可执行提示。 */
export declare class OffPeakServerError extends Error {
    /** HTTP 状态码。 */
    readonly httpStatus: number;
    /** 业务码(响应体里的 `code`)。 */
    readonly bizCode?: number | undefined;
    /** 限流时的下次可领时间。 */
    readonly nextTakeAt?: number | undefined;
    constructor(message: string, 
    /** HTTP 状态码。 */
    httpStatus: number, 
    /** 业务码(响应体里的 `code`)。 */
    bizCode?: number | undefined, 
    /** 限流时的下次可领时间。 */
    nextTakeAt?: number | undefined);
}
/** 生成任务 id(官方格式 `offpeak-<uuid>`)。 */
export declare function buildOffPeakTaskId(): string;
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
export declare function buildOffPeakHeaders(deps: OffPeakDeps): Record<string, string>;
/**
 * 组装**模型请求**的 off-peak 鉴权(官方 `qA` / `buildOffPeakRequestAuth`)。
 * @param deps - 端点与凭证。
 * @param ticketId - 已领到的票据 id。
 * @returns `apiKey` 与要附加到模型请求上的头。
 */
export declare function buildOffPeakRequestAuth(deps: OffPeakDeps, ticketId: string): {
    apiKey: string;
    headers: Record<string, string>;
};
/**
 * 查领票可用性(官方 `getTakeNumberAvailability`)。
 * @param deps - 端点与凭证。
 * @returns 可用性与下次可领时间。
 */
export declare function fetchOffPeakAvailability(deps: OffPeakDeps): Promise<OffPeakAvailability>;
/**
 * 领一张票(官方 `takeTicket`)。票据是一次性的调度凭据,领到后要轮询到 `ready` 才能用。
 * @param deps - 端点与凭证。
 * @param taskId - 任务 id;缺省按官方格式生成。
 * @returns 票据。
 */
export declare function takeOffPeakTicket(deps: OffPeakDeps, taskId?: string): Promise<OffPeakTicket>;
/**
 * 批量查票据状态(官方 `batchStatus`;官方最多一次 100 个)。
 * @param deps - 端点与凭证。
 * @param ticketIds - 票据 id 列表。
 * @returns 票据状态与下次轮询间隔。
 */
export declare function fetchOffPeakTicketStatus(deps: OffPeakDeps, ticketIds: readonly string[]): Promise<{
    tickets: OffPeakTicket[];
    nextPollAfterMs?: number;
}>;
/**
 * 结算票据(官方 `settle`)。跑完一段空闲任务后必须调用,否则票会占着名额。
 * @param deps - 端点与凭证。
 * @param ticketId - 票据 id。
 * @returns 结算结果状态。
 */
export declare function settleOffPeakTicket(deps: OffPeakDeps, ticketId: string): Promise<string>;
/** 本地资格判定的输入(与官方 `resolveOffPeakCredentials` 的前置条件一一对应)。 */
export interface OffPeakEligibilityInput {
    /** `oauth:active_provider` 的明文值。 */
    activeProvider?: string;
    /** 该 provider 的 family(`bigmodel` / `zai`)。 */
    family?: string;
    /** 是否解析到 `zcodejwttoken`。 */
    hasZcodeJwt: boolean;
    /** 是否解析到账号 coding plan api key。 */
    hasCodingPlanApiKey: boolean;
    /** 账号连接的 planKind;官方对 `start-plan` 直接判不支持。 */
    planKind?: string;
}
/** 本地资格判定结果。 */
export interface OffPeakEligibility {
    /** 是否具备走错峰通道的前提。 */
    supported: boolean;
    /** 不支持时的原因(官方错误码同名)。 */
    reason?: 'provider_identity_mismatch' | 'jwt_missing' | 'codingPlanApiKey_missing' | 'connection_unavailable' | 'start_plan_not_supported';
    /** 可执行的中文说明。 */
    detail: string;
}
/**
 * 复刻官方 `resolveSelectedOffPeakCodingPlan` + `resolveOffPeakCredentials` 的前置判定。
 *
 * 顺序与官方一致:先看连接是否存在,再看 planKind( **start-plan 明确不支持** ),
 * 再比对 `oauth:active_provider` 与 family,最后要求 jwt 与 coding plan key 都在。
 * @param input - 本地可见的素材。
 * @returns 判定结果与可执行说明。
 */
export declare function resolveOffPeakEligibility(input: OffPeakEligibilityInput): OffPeakEligibility;
/** 票据状态的中文说明(含可执行下一步)。 */
export declare function describeOffPeakState(state: OffPeakTicket['state']): string;
/** 票据不可用的稳定标记(与官方 `OFF_PEAK_TICKET_EXPIRED_MARKER` 同值,跨进程可识别)。 */
export declare const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";
/** 排队业务码(HTTP 429,带 `Retry-After`)。 */
export declare const OFF_PEAK_QUEUED_CODE = "3105";
/** 票据不可用业务码:服务端最新契约用 3102,滚更期旧网关用 3001。 */
export declare const OFF_PEAK_TICKET_EXPIRED_CODES: readonly ["3102", "3001"];
/**
 * 票据**无效**业务码(HTTP 400,`off-peak ticket is invalid`)。
 *
 * 与 3102(`wrong off-peak ticket`)区分:3102 是"票不对/不归你",
 * 3104 是"票根本没通过校验"。实测出现在**假票 + 合法请求体**时,
 * 也正好是验证"请求体是否通过 3012 门"的判别信号。
 */
export declare const OFF_PEAK_TICKET_INVALID_CODE = "3104";
/**
 * 取号超限业务码(HTTP 429,`take number limit exceeded`,带 `data.next_take_at`)。
 *
 * 官方 UI 用 `canTakeNumber` + `nextTakeAt` 做 fail-closed 禁用与倒计时
 * (`offPeakUiPresentation.ts` 的 `resolveOffPeakCreateBlockReason`:
 * `canTakeNumber === true ? null : "quota"`)。**这是一天级的额度**,
 * 诊断期频繁取号很容易把它打满。
 */
export declare const OFF_PEAK_TAKE_LIMIT_CODE = "3103";
/**
 * 风控门业务码(HTTP 405,`request has been blocked due to unusual activity`)。
 *
 * 实测判据:**请求里有没有官方 agent 的系统提示词**(见 `official-prompt.ts`)。
 * 与票据无关——假票+合法体也会先过这道门再到 3104,所以它排在票据校验之前。
 */
export declare const OFF_PEAK_ATTESTATION_CODE = "3012";
/** 单次排队等待上限(官方 `OFF_PEAK_QUEUE_WAIT_CAP_MS` = 5min)。 */
export declare const OFF_PEAK_QUEUE_WAIT_CAP_MS: number;
/** 无 `Retry-After` 时的排队探测间隔(官方 60s)。 */
export declare const OFF_PEAK_QUEUE_WAIT_DEFAULT_MS = 60000;
/** 一次派发失败的性质(官方 `resolveOffPeakFailureDecision` 的等价物)。 */
export type OffPeakFailureDecision = {
    kind: 'queued';
    delayMs: number;
} | {
    kind: 'ticketExpired';
} | {
    kind: 'ticketInvalid';
} | {
    kind: 'takeLimitExceeded';
    nextTakeAt?: number;
} | {
    kind: 'attestationRejected';
};
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
export declare function resolveOffPeakFailureDecision(status: number, body: string): OffPeakFailureDecision | null;
/** 把票据不可用包装成官方稳定标记(与官方 `offPeakTicketExpiredMessage` 同形)。 */
export declare function offPeakTicketExpiredMessage(original: string): string;
/** 一次 off-peak 派发尝试的结果。 */
export type OffPeakDispatch = {
    /** 拿到可用的调度凭据(票据 + 鉴权头),可以发模型请求了。 */
    kind: 'granted';
    /** 票据。 */
    ticket: OffPeakTicket;
    /** 模型请求要带的鉴权。 */
    auth: {
        apiKey: string;
        headers: Record<string, string>;
    };
} | {
    kind: 'queued';
    delayMs: number;
    ticket: OffPeakTicket;
    reason: string;
} | {
    kind: 'ticketExpired';
    reason: string;
} | {
    kind: 'takeLimitExceeded';
    nextTakeAt?: number;
    reason: string;
} | {
    kind: 'unsupported';
    reason: string;
};
/** 派发所需依赖(在 `OffPeakDeps` 之上加轮询参数)。 */
export interface OffPeakDispatchOptions {
    /** 最长等待票据就绪的时间(毫秒);默认 2 分钟。 */
    waitMs?: number;
    /** 轮询间隔下限(毫秒);服务端 `next_poll_after` 更大时以服务端为准。默认 3s。 */
    pollMs?: number;
    /** 睡眠实现(测试可注入,避免真的等待)。 */
    sleep?: (ms: number) => Promise<void>;
    /** 现在(测试可注入)。 */
    now?: () => number;
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
export declare function acquireOffPeakDispatch(deps: OffPeakDeps, options?: OffPeakDispatchOptions): Promise<OffPeakDispatch>;
