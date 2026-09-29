/**
 * 官方 zcode 的权益/用量视图(与 `ZCode-open/packages/services/src/usage-stats/providers/` 同源)。
 *
 * 官方客户端会主动查询并展示这些数据,而"看不到权益"正是"以为没用到权益"的来源;
 * 本模块把同一批端点、同一批字段搬进 DSH。
 *
 * 端点与凭证(实测确认):
 * | 端点 | 凭证 |
 * | --- | --- |
 * | `GET {bigmodel}/api/monitor/usage/quota/limit` | 账号 Coding Plan key |
 * | `GET {bigmodel}/api/biz/subscription/list` | 账号 Coding Plan key |
 * | `GET {bigmodel}/api/monitor/usage/model-usage?startTime=&endTime=` | 账号 Coding Plan key |
 * | `GET {zcode}/api/v1/zcode-plan/billing/current?app_version=` | `zcodejwttoken`(Start Plan) |
 * | `GET {zcode}/api/v1/off-peak/ticket/availability` | `zcodejwttoken` + `x-coding-plan-api-key`(错峰) |
 *
 * 时间范围格式与官方 `formatMonitorDateTime` 一致(`YYYY-MM-DD HH:mm:ss`,本地时区,含当天)。
 * 鉴权头与官方 `md()` 一致:仅 `authorization: Bearer <key>`。
 *
 * @module zcode-provider/usage
 */
import { type OffPeakAvailability, type OffPeakEligibility } from './offpeak.js';
import { type AccountProviderSnapshot, type ProviderFamily, type UsageEntitlementSnapshot, type UsageMcpQuotaSnapshot, type UsageQuotaLimit } from './entitlements.js';
export type { AccountProviderAccess, AccountProviderMode, AccountProviderSnapshot, AccountProviderState, AccountProviderUnavailableReason, ProviderFamily, UsageEntitlementContext, UsageEntitlementProviderInfo, UsageEntitlementRemaining, UsageEntitlementSnapshot, UsageEntitlementSubscription, UsageEntitlementSubscriptionDetail, UsageMcpQuotaScope, UsageMcpQuotaSnapshot, UsageQuotaLimit, UsageQuotaSnapshot, UsageQuotaUsageDetail, } from './entitlements.js';
/** 官方 quota 路径(相对 bigmodel API 根)。 */
export declare const QUOTA_PATH = "/api/monitor/usage/quota/limit";
/** 官方订阅列表路径。 */
export declare const SUBSCRIPTION_PATH = "/api/biz/subscription/list";
/** 官方用量曲线路径前缀。 */
export declare const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
/** 官方 Start Plan **余额**路径(官方 `validateStartPlanAvailability` 的准入门)。 */
export declare const START_PLAN_BALANCE_PATH = "/api/v1/zcode-plan/billing/balance";
/** ZCode Server MCP 用量路径。 */
export declare const MCP_USAGE_PATH = "/api/v1/mcp/usage";
/**
 * 错峰(idle)通道当前**默认禁用**,`zcode_usage` 因此不再请求错峰端点。
 *
 * 原因此处不重复(见 `index.ts` 的 `OFF_PEAK_ENABLED_DEFAULT`):该通道的派发
 * 一期不做,留着取数只会每次多打两个 HTTP 请求、并在报告里显示一个用不了的额度。
 */
export declare const OFF_PEAK_REPORT_ENABLED_DEFAULT = false;
/** 官方取数窗口天数(与 `bigmodelUsageMonitorRange.ts` 的 `MONITOR_DEFAULT_RANGE_DAYS` 一致)。 */
export declare const MONITOR_DEFAULT_RANGE_DAYS = 30;
/** 官方允许的窗口上限(`MONITOR_MAX_RANGE_DAYS`)。 */
export declare const MONITOR_MAX_RANGE_DAYS = 30;
/**
 * 官方 usage-stats 的窗口取值。
 *
 * 注意官方 `resolveUsageTimeRange` 只区分 `7d` / `30d`,**其他值(含 `today`)都落到 30 天**;
 * 逐时粒度是另一个函数(`resolveCodingPlanUsageTimeRange`)才有的,monitor 端点没有。
 */
export type MonitorRange = '7d' | '30d';
/** 一天的用量(`model-usage` 的 `x_time[i]` / `tokensUsage[i]` / `modelCallCount[i]`)。 */
export interface ModelUsageDay {
    /** 官方 `x_time` 原样(实测形如 `2026-09-26`,granularity=daily)。 */
    date: string;
    /** 当日 token 数(官方 `tokensUsage[i]`)。 */
    tokens: number;
    /** 当日调用次数(官方 `modelCallCount[i]`)。 */
    calls: number;
}
/** 一个模型的窗口用量(官方 `modelSummaryList[]`)。 */
export interface ModelUsageModel {
    modelId: string;
    totalTokens: number;
    /** 占总量的比例(官方 `share`,总量为 0 时为 0)。 */
    share: number;
}
/** 一个窗口的用量视图(字段与官方 `buildUsageStatsSnapshotFromMonitor` 对齐)。 */
export interface ModelUsageWindow {
    range: MonitorRange;
    /** 逐日序列,与 `x_time` 等长。 */
    days: ModelUsageDay[];
    /** 官方 `totalUsage.totalTokensUsage`。 */
    totalTokens: number;
    /** 官方 `totalUsage.totalModelCallCount`。 */
    totalCalls: number;
    /** 按 token 降序(官方对 `summaryList` 的排序口径)。 */
    models: ModelUsageModel[];
    /** 有 token 消耗的天数(官方 `activeDayCount`)。 */
    activeDays: number;
    /** 用量最高的一天(官方 `mostActiveDay`);全为 0 时 undefined。 */
    mostActiveDay?: ModelUsageDay;
}
/** 一项非致命的取数失败。 */
export interface UsageFailure {
    source: 'quota' | 'subscription' | 'model-usage' | 'start-plan' | 'off-peak';
    reason: string;
}
/**
 * 核心权益快照。
 *
 * 只包含决定账号可用性的 Coding Plan quota/subscription 与 Start Plan 数据。
 * 模型用量和 MCP 额度属于可延迟加载的补充数据，见 {@link UsageSupplement}。
 */
export interface EntitlementReport {
    accountProviders: Record<string, AccountProviderSnapshot>;
    entitlements: {
        codingPlan: UsageEntitlementSnapshot;
        startPlan: UsageEntitlementSnapshot;
    };
    /** 核心端点的失败项；单项失败不阻断其余核心数据。 */
    failures: UsageFailure[];
}
/**
 * 可选的用量补充数据。
 *
 * 该数据可在核心权益已呈现后再取；其中 MCP 是纯补充数据，失败时保持静默，
 * 与官方客户端的权益降级语义一致。
 */
export interface UsageSupplement {
    /** 窗口用量(按模型 + 逐日);查询失败时 undefined。 */
    modelUsage?: ModelUsageWindow;
    /** ZCode Server MCP 额度；无可用 MCP 额度或请求失败时 undefined。 */
    mcpQuota?: UsageMcpQuotaSnapshot;
    /** 补充端点的可见失败项(当前仅 model-usage)。 */
    failures: UsageFailure[];
}
/** 用量报告:账号状态、核心权益与可选用量快照沿用官方字段语义。 */
export interface UsageReport extends EntitlementReport {
    /** 窗口用量(按模型 + 逐日);查询失败时 undefined。 */
    modelUsage?: ModelUsageWindow;
    /** 错峰 / 空闲额度(Idle plan)的本地资格与领票可用性。 */
    offPeak?: OffPeakReport;
}
/** 错峰通道(Idle plan / Start Plan 额度)的可见性报告。 */
export interface OffPeakReport {
    /** 本地前置判定(官方 `resolveOffPeakCredentials` 同口径)。 */
    eligibility: OffPeakEligibility;
    /** 服务端领票可用性;本地前提不满足或请求失败时 undefined。 */
    availability?: OffPeakAvailability;
}
/** 取数依赖。 */
export interface UsageDeps {
    /** BigModel API 根(如 `https://open.bigmodel.cn`);缺省时按 baseURL 推导。 */
    bigmodelOrigin?: string;
    /** zcode 端点 origin(Start Plan 与 `app_version` 用)。 */
    endpointOrigin: string;
    /** 客户端版本(`app_version` 查询参数)。 */
    appVersion: string;
    /** 账号 Coding Plan key。 */
    planApiKey?: string;
    /** `zcodejwttoken`(Start Plan 用)。 */
    zcodeJwt?: string;
    /** MaaS 登录 JWT(`oauth:<family>:access_token`),官方 MCP 额度使用。 */
    oauthAccessToken?: string;
    /** 当前账号族。 */
    accountFamily?: ProviderFamily;
    /** Coding Plan 的官方运行期 provider id。 */
    codingProviderId?: string;
    /** Start Plan 的官方运行期 provider id。 */
    startProviderId?: string;
    /** Team Plan 的精确额度归属;个人套餐省略。 */
    teamContext?: {
        organizationId: string;
        projectId: string;
    };
    /** 账号 coding plan api key 是否可解析(错峰资格的本地前提之一)。 */
    hasCodingPlanApiKey?: boolean;
    /** `oauth:active_provider` 明文值(错峰资格的本地前提之一)。 */
    activeProvider?: string;
    /** 该账号连接的 family 与 planKind(错峰资格判定用)。 */
    accountPlanKind?: string;
    /** 错峰取数用的源码头;缺省不加(测试可注入)。 */
    sourceHeaders?: Record<string, string>;
    /** 设备标识:官方 ticket 客户端会发送 `x-device-mid`。 */
    deviceMid?: string;
    /**
     * 是否在报告里包含错峰(idle)额度段。
     *
     * 默认 **false**:该通道派发一期不做,取数只会白打两个请求。传 true 可临时查看。
     */
    offPeakReport?: boolean;
    /** 窗口用量取数范围;缺省 `30d`(官方 monitor 默认)。 */
    range?: MonitorRange;
    /** 注入 fetch(测试用)。 */
    fetch?: typeof fetch;
    /** 请求超时(ms)。 */
    timeoutMs?: number;
}
/**
 * 官方取数窗口:截止今天 23:59:59,起点为 `days-1` 天前的 00:00:00。
 * @param days - 窗口天数(官方上限 30)。
 * @param now - 注入的"现在"(测试用)。
 * @returns `startTime` / `endTime` 字符串。
 */
export declare function monitorRange(days?: number, now?: Date): {
    startTime: string;
    endTime: string;
};
/**
 * 窗口名 → 天数,与官方 `resolveUsageTimeRange` 一致:只认 `7d` / `30d`,
 * 其他(含 `today`)落回 `MONITOR_DEFAULT_RANGE_DAYS`。
 * @param range - 窗口名。
 * @returns 天数。
 */
export declare function monitorRangeDays(range: MonitorRange | undefined): number;
/** 从 provider baseURL 推导 BigModel 业务 origin(`https://open.bigmodel.cn/api/anthropic` → `https://open.bigmodel.cn`)。 */
export declare function bigmodelOriginFrom(baseURL: string): string | undefined;
/** 官方 `normalizeLimits`:保留 level 之外的完整额度条目,包括 usageDetails。 */
export declare function normalizeLimits(payload: unknown): UsageQuotaLimit[];
/**
 * `model-usage` → 窗口用量视图(口径对齐官方 `buildUsageStatsSnapshotFromMonitor`)。
 *
 * 官方只取三处:`x_time`/`tokensUsage`/`modelCallCount` 组成逐日序列,
 * `totalUsage.totalTokensUsage`/`totalModelCallCount` 是总量,
 * 模型明细优先 `totalUsage.modelSummaryList`,没有才退回顶层 `modelSummaryList`;
 * 模型按 token **降序**排列,`share` = 本模型 / 总量。
 *
 * @param payload - `model-usage` 的响应体。
 * @param range - 请求时用的窗口名(仅回填,不影响解析)。
 * @returns 窗口用量视图;`code !== 200` 或 `data` 缺失时抛错。
 */
export declare function parseModelUsage(payload: unknown, range: MonitorRange): ModelUsageWindow;
/**
 * 读取不会依赖模型统计或 MCP 服务的核心权益快照。
 *
 * quota、subscription 与 Start Plan 仍在同一批中并行请求；任一核心端点失败只
 * 进入 `failures`，不会阻断另两个核心端点。这是 Web 首屏应使用的入口。
 */
export declare function fetchEntitlementReport(deps: UsageDeps, signal?: AbortSignal): Promise<EntitlementReport>;
/**
 * 读取可延后呈现的模型用量与 MCP 额度。
 *
 * 这两个端点相互并行，但不参与核心权益请求；MCP 仍保持原有的静默失败语义。
 */
export declare function fetchUsageSupplement(deps: UsageDeps, signal?: AbortSignal): Promise<UsageSupplement>;
/**
 * Combine an already-renderable core snapshot with optional delayed data.
 *
 * The input objects are never mutated. MCP quota is accepted only when the
 * core snapshot confirms a live Coding Plan subscription, so a late response
 * cannot make an unavailable account look entitled.
 */
export declare function mergeUsageReport(core: EntitlementReport, supplement: UsageSupplement): UsageReport;
/**
 * Backwards-compatible complete report.
 *
 * The two collectors are started together to preserve the previous five-way
 * endpoint concurrency. Callers that render a first view should use
 * `fetchEntitlementReport` directly and defer `fetchUsageSupplement`.
 */
export declare function fetchUsageReport(deps: UsageDeps, signal?: AbortSignal): Promise<UsageReport>;
/** 把 epoch 毫秒渲染成 `YYYY-MM-DD HH:mm`(本地时区);无效时返回 `-`。 */
export declare function formatMs(ms: number | undefined): string;
/**
 * 把 epoch **秒** 渲染成 `YYYY-MM-DD HH:mm`(本地时区)。
 *
 * 官方 `billing/current` 的 `starts_at` / `ends_at` / `entitlements[].effective_at`
 * 与 `server_time` 都是**秒**(见官方 `lfe` 里 `n>=0?n:Date.now()/1e3`);
 * 而 `quota/limit` 的 `nextResetTime` 是**毫秒**。单位不同,不能共用同一个渲染函数——
 * 曾经共用导致 Start Plan 有效期渲染成 1970(真机取数时暴露)。
 * @param seconds - epoch 秒。
 * @returns `YYYY-MM-DD HH:mm`;无效时返回 `-`。
 */
export declare function formatEpochSeconds(seconds: number | undefined): string;
/** 把 ISO 串渲染成 `YYYY-MM-DD HH:mm`(本地时区);无效时返回 `-`。 */
export declare function formatIso(iso: string | undefined): string;
/** 单条额度的人读描述(对齐官方选取 `TIME_LIMIT` 优先的展示口径)。 */
export declare function describeLimit(limit: UsageQuotaLimit): string;
/**
 * 把 token 数渲染成紧凑的人读形式(12.0 亿 → `12.0亿`;1.2 万 → `1.2万`)。
 *
 * 中文语境下用「万/亿」比 `1.2B` 更直观;小于 1 万的保留原数,避免把小数压成 `0`.
 * @param value - token 数。
 * @returns 人读字符串。
 */
export declare function formatTokens(value: number): string;
/**
 * 渲染成可直接呈现的文本(激活时日志与工具输出共用)。
 * @param report - `fetchUsageReport` 的结果。
 * @returns 多行文本。
 */
export declare function renderUsageReport(report: UsageReport): string;
/** 空报告的便捷构造(激活期静默用)。 */
export declare function emptyUsageReport(): UsageReport;
