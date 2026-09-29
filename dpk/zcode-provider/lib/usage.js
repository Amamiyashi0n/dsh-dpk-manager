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
import { createHash } from 'node:crypto';
import { fetchOffPeakAvailability, resolveOffPeakEligibility, } from './offpeak.js';
import { accountProviderSnapshot, buildCodingPlanSnapshot, buildMcpQuotaSnapshot, normalizeQuota, parseCodingPlanEntitlement, resolveStartPlanBalance, } from './entitlements.js';
/** 官方 quota 路径(相对 bigmodel API 根)。 */
export const QUOTA_PATH = '/api/monitor/usage/quota/limit';
/** 官方订阅列表路径。 */
export const SUBSCRIPTION_PATH = '/api/biz/subscription/list';
/** 官方用量曲线路径前缀。 */
export const MODEL_USAGE_PATH = '/api/monitor/usage/model-usage';
/** 官方 Start Plan **余额**路径(官方 `validateStartPlanAvailability` 的准入门)。 */
export const START_PLAN_BALANCE_PATH = '/api/v1/zcode-plan/billing/balance';
/** ZCode Server MCP 用量路径。 */
export const MCP_USAGE_PATH = '/api/v1/mcp/usage';
/**
 * 错峰(idle)通道当前**默认禁用**,`zcode_usage` 因此不再请求错峰端点。
 *
 * 原因此处不重复(见 `index.ts` 的 `OFF_PEAK_ENABLED_DEFAULT`):该通道的派发
 * 一期不做,留着取数只会每次多打两个 HTTP 请求、并在报告里显示一个用不了的额度。
 */
export const OFF_PEAK_REPORT_ENABLED_DEFAULT = false;
/** 官方取数窗口天数(与 `bigmodelUsageMonitorRange.ts` 的 `MONITOR_DEFAULT_RANGE_DAYS` 一致)。 */
export const MONITOR_DEFAULT_RANGE_DAYS = 30;
/** 官方允许的窗口上限(`MONITOR_MAX_RANGE_DAYS`)。 */
export const MONITOR_MAX_RANGE_DAYS = 30;
const DEFAULT_TIMEOUT_MS = 20_000;
/** `YYYY-MM-DD HH:mm:ss`(本地时区),与官方 `formatMonitorDateTime` 一致。 */
function formatMonitorDateTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
/**
 * 官方取数窗口:截止今天 23:59:59,起点为 `days-1` 天前的 00:00:00。
 * @param days - 窗口天数(官方上限 30)。
 * @param now - 注入的"现在"(测试用)。
 * @returns `startTime` / `endTime` 字符串。
 */
export function monitorRange(days = MONITOR_DEFAULT_RANGE_DAYS, now = new Date()) {
    const end = new Date(now);
    end.setHours(23, 59, 59, 0);
    const start = new Date(end);
    start.setDate(end.getDate() - (Math.min(Math.max(days, 1), MONITOR_MAX_RANGE_DAYS) - 1));
    start.setHours(0, 0, 0, 0);
    return { startTime: formatMonitorDateTime(start), endTime: formatMonitorDateTime(end) };
}
/**
 * 窗口名 → 天数,与官方 `resolveUsageTimeRange` 一致:只认 `7d` / `30d`,
 * 其他(含 `today`)落回 `MONITOR_DEFAULT_RANGE_DAYS`。
 * @param range - 窗口名。
 * @returns 天数。
 */
export function monitorRangeDays(range) {
    switch (range) {
        case '7d': return 7;
        case '30d': return 30;
        default: return MONITOR_DEFAULT_RANGE_DAYS;
    }
}
/** 从 provider baseURL 推导 BigModel 业务 origin(`https://open.bigmodel.cn/api/anthropic` → `https://open.bigmodel.cn`)。 */
export function bigmodelOriginFrom(baseURL) {
    try {
        return new URL(baseURL).origin;
    }
    catch (_invalidUrl) {
        return undefined;
    }
}
class UsageHttpError extends Error {
    status;
    constructor(status) {
        super(`HTTP ${status}`);
        this.status = status;
    }
}
class UsageTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`request timed out after ${timeoutMs}ms`);
        this.timeoutMs = timeoutMs;
        this.name = 'UsageTimeoutError';
    }
}
/** 带超时的 GET,返回解析后的 JSON;任何失败都抛错由调用方归类。 */
async function getJson(url, auth, deps, explicitHeaders, signal) {
    const controller = new AbortController();
    let rejectCancelled;
    const configuredTimeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 0
        ? configuredTimeout
        : DEFAULT_TIMEOUT_MS;
    const doFetch = deps.fetch ?? fetch;
    // Race the complete response pipeline, not merely the initial fetch call.
    // Some custom fetch implementations ignore AbortSignal or stall while parsing
    // a body; Promise.race gives callers a hard upper bound in either case.
    const request = Promise.resolve().then(async () => {
        // 官方只对 **zcode.z.ai** 带设备头;bigmodel 的用量端点官方只发 authorization
        // (`md()` 实测),因此按 origin 收口,避免把设备标识外泄到另一个域名。
        const isZcodeOrigin = url.startsWith(deps.endpointOrigin);
        const response = await doFetch(url, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: explicitHeaders ?? {
                authorization: `Bearer ${auth}`,
                accept: 'application/json',
                // 官方 app 的每个 zcode.z.ai 请求都带 x-device-mid;少了它服务端只回
                // `3001 parameter error`(实测:billing/balance 仅带 authorization → 3001,
                // 加上 x-device-mid → 200)。这不是"参数错",是设备身份没被识别。
                ...(!isZcodeOrigin || deps.deviceMid === undefined || deps.deviceMid.trim() === ''
                    ? {}
                    : { 'x-device-mid': deps.deviceMid.trim() }),
            },
        });
        if (!response.ok)
            throw new UsageHttpError(response.status);
        return response.json();
    });
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new UsageTimeoutError(timeoutMs));
        }, timeoutMs);
    });
    const cancelled = signal === undefined
        ? undefined
        : new Promise((_resolve, reject) => {
            rejectCancelled = reject;
        });
    const abortFromCaller = () => {
        controller.abort(signal?.reason);
        rejectCancelled?.(signal?.reason ?? new Error('request aborted'));
    };
    if (signal !== undefined) {
        if (signal.aborted)
            abortFromCaller();
        else
            signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    try {
        return await Promise.race(cancelled === undefined ? [request, timeout] : [request, timeout, cancelled]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromCaller);
    }
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function str(value) {
    const t = typeof value === 'string' ? value.trim() : '';
    return t || undefined;
}
/** 官方 `normalizeLimits`:保留 level 之外的完整额度条目,包括 usageDetails。 */
export function normalizeLimits(payload) {
    return normalizeQuota(payload).limits;
}
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
export function parseModelUsage(payload, range) {
    const body = asRecord(payload);
    if (body?.code !== 200)
        throw new Error(`model-usage 接口返回 code=${String(body?.code)}`);
    const data = asRecord(body.data);
    if (data === undefined)
        throw new Error('model-usage 响应缺少 data');
    const xTime = Array.isArray(data.x_time) ? data.x_time : [];
    const tokens = Array.isArray(data.tokensUsage) ? data.tokensUsage : [];
    const calls = Array.isArray(data.modelCallCount) ? data.modelCallCount : [];
    const days = xTime.map((raw, index) => ({
        date: typeof raw === 'string' ? raw : String(raw ?? ''),
        tokens: num(tokens[index]) ?? 0,
        calls: num(calls[index]) ?? 0,
    }));
    const total = asRecord(data.totalUsage);
    // 官方优先 totalUsage 内的汇总,缺失才退回顶层(两个字段名不同,别混用)
    const summaryRaw = Array.isArray(total?.modelSummaryList) ? total.modelSummaryList
        : Array.isArray(data.modelSummaryList) ? data.modelSummaryList
            : [];
    const totalTokens = num(total?.totalTokensUsage) ?? 0;
    const models = summaryRaw
        .flatMap((entry) => {
        const item = asRecord(entry);
        const modelId = str(item?.modelName);
        if (item === undefined || modelId === undefined)
            return [];
        const modelTokens = num(item.totalTokens) ?? 0;
        return [{ modelId, totalTokens: modelTokens, share: totalTokens > 0 ? modelTokens / totalTokens : 0 }];
    })
        .sort((left, right) => right.totalTokens - left.totalTokens);
    const activeDays = days.filter((day) => day.tokens > 0).length;
    const busiest = days.reduce((best, day) => (best === undefined || day.tokens > best.tokens ? day : best), undefined);
    const out = {
        range,
        days,
        totalTokens,
        totalCalls: num(total?.totalModelCallCount) ?? 0,
        models,
        activeDays,
    };
    if (busiest !== undefined && busiest.tokens > 0)
        out.mostActiveDay = busiest;
    return out;
}
function accountConnectionKey(family, ...secrets) {
    const material = secrets.map((value) => value?.trim()).filter((value) => Boolean(value)).join('\n');
    return material === '' ? undefined : createHash('sha256').update(`${family}\n${material}`).digest('hex');
}
function unavailableSnapshot(input) {
    return {
        generatedAt: input.generatedAt,
        authenticated: input.authenticated,
        unavailableReason: input.reason,
        context: { scope: 'personal' },
        provider: input.provider,
        remaining: null,
        subscription: null,
        quota: null,
    };
}
/**
 * 读取不会依赖模型统计或 MCP 服务的核心权益快照。
 *
 * quota、subscription 与 Start Plan 仍在同一批中并行请求；任一核心端点失败只
 * 进入 `failures`，不会阻断另两个核心端点。这是 Web 首屏应使用的入口。
 */
export async function fetchEntitlementReport(deps, signal) {
    signal?.throwIfAborted();
    const generatedAt = Date.now();
    const origin = deps.bigmodelOrigin;
    const planKey = deps.planApiKey?.trim();
    const jwt = deps.zcodeJwt?.trim();
    const oauthAccessToken = deps.oauthAccessToken?.trim();
    const family = deps.accountFamily ?? 'bigmodel';
    const current = deps.activeProvider === undefined || deps.activeProvider === family;
    const connected = Boolean(jwt || oauthAccessToken) && current;
    const startAuthenticated = Boolean(jwt) && current;
    const codingProvider = {
        id: deps.codingProviderId ?? `account:${family}-individual-coding-plan`,
        name: family === 'zai' ? 'Z.ai Coding Plan' : 'BigModel Coding Plan',
    };
    const startProvider = {
        id: deps.startProviderId ?? `account:${family}-start-plan`,
        name: family === 'zai' ? 'Z.ai Start Plan' : 'BigModel Start Plan',
    };
    const connectionKey = accountConnectionKey(family, jwt, oauthAccessToken);
    const failures = [];
    let quota = null;
    let codingEntitlement = { kind: 'unknown' };
    let subscriptionAuthFailed = false;
    let startResolution;
    let startAuthFailed = false;
    const tasks = [];
    if (origin !== undefined && planKey) {
        tasks.push((async () => {
            try {
                quota = normalizeQuota(await getJson(`${origin}${QUOTA_PATH}`, planKey, deps, undefined, signal));
                return undefined;
            }
            catch (error) {
                return { source: 'quota', reason: String(error) };
            }
        })());
        tasks.push((async () => {
            try {
                codingEntitlement = parseCodingPlanEntitlement(await getJson(`${origin}${SUBSCRIPTION_PATH}`, planKey, deps, undefined, signal));
                return undefined;
            }
            catch (error) {
                subscriptionAuthFailed = error instanceof UsageHttpError && [401, 403].includes(error.status);
                return { source: 'subscription', reason: String(error) };
            }
        })());
    }
    else {
        failures.push({ source: 'quota', reason: origin === undefined ? 'baseURL 无法推导 origin' : '缺少账号 Coding Plan key' });
    }
    if (jwt) {
        tasks.push((async () => {
            try {
                const url = `${deps.endpointOrigin}${START_PLAN_BALANCE_PATH}?app_version=${encodeURIComponent(deps.appVersion)}`;
                startResolution = resolveStartPlanBalance(await getJson(url, jwt, deps, undefined, signal), startProvider, generatedAt);
                return undefined;
            }
            catch (error) {
                startAuthFailed = error instanceof UsageHttpError && [401, 403].includes(error.status);
                return { source: 'start-plan', reason: String(error) };
            }
        })());
    }
    // 核心端点彼此独立：一个慢服务只消耗一个超时窗口。
    const taskFailures = await Promise.all(tasks);
    signal?.throwIfAborted();
    failures.push(...taskFailures.filter((failure) => failure !== undefined));
    // Assignments happen inside the concurrently awaited tasks. Keep the
    // post-await value explicit so TypeScript does not retain the initializer's
    // discriminant as if the callbacks had never run.
    const resolvedCodingEntitlement = codingEntitlement;
    const codingPlan = buildCodingPlanSnapshot({
        authenticated: connected,
        provider: origin === undefined ? null : codingProvider,
        entitlement: resolvedCodingEntitlement,
        quota,
        mcpQuota: null,
        configured: origin !== undefined && Boolean(planKey),
        context: deps.teamContext === undefined
            ? { scope: 'personal' }
            : { scope: 'team', organizationId: deps.teamContext.organizationId, projectId: deps.teamContext.projectId },
        generatedAt,
    });
    const startPlan = startResolution?.snapshot ?? unavailableSnapshot({
        authenticated: startAuthenticated,
        reason: !startAuthenticated ? 'not_authenticated' : 'unavailable',
        provider: jwt ? startProvider : null,
        generatedAt,
    });
    const codingStatus = !connected
        ? 'unavailable'
        : resolvedCodingEntitlement.kind === 'available'
            ? 'available'
            : resolvedCodingEntitlement.kind === 'unavailable'
                ? 'unavailable'
                : subscriptionAuthFailed
                    ? 'unavailable'
                    : 'unknown';
    const startStatus = !startAuthenticated
        ? 'unavailable'
        : startResolution?.status ?? (startAuthFailed ? 'unavailable' : 'unknown');
    return {
        accountProviders: {
            [codingProvider.id]: accountProviderSnapshot({
                accountType: family,
                mode: deps.teamContext === undefined ? 'individual-coding-plan' : 'team-coding-plan',
                status: codingStatus,
                current,
                ...(connectionKey === undefined ? {} : { connectionKey }),
                ...(codingStatus !== 'unavailable'
                    ? {}
                    : { unavailableReason: !connected ? 'not-connected' : subscriptionAuthFailed ? 'credential-failed' : 'not-entitled' }),
            }),
            [startProvider.id]: accountProviderSnapshot({
                accountType: family,
                mode: 'start-plan',
                status: startStatus,
                current,
                ...(connectionKey === undefined ? {} : { connectionKey }),
                ...(startResolution?.effectiveAt === undefined ? {} : { effectiveAt: startResolution.effectiveAt }),
                ...(startResolution?.models === undefined ? {} : { models: startResolution.models }),
                ...(startStatus !== 'unavailable'
                    ? {}
                    : { unavailableReason: !startAuthenticated ? 'not-authenticated' : startAuthFailed ? 'credential-failed' : 'not-entitled' }),
            }),
        },
        entitlements: { codingPlan, startPlan },
        failures,
    };
}
/**
 * 读取可延后呈现的模型用量与 MCP 额度。
 *
 * 这两个端点相互并行，但不参与核心权益请求；MCP 仍保持原有的静默失败语义。
 */
export async function fetchUsageSupplement(deps, signal) {
    signal?.throwIfAborted();
    const origin = deps.bigmodelOrigin;
    const planKey = deps.planApiKey?.trim();
    const jwt = deps.zcodeJwt?.trim();
    const oauthAccessToken = deps.oauthAccessToken?.trim();
    const family = deps.accountFamily ?? 'bigmodel';
    const failures = [];
    let modelUsage;
    let mcpQuota;
    const tasks = [];
    if (origin !== undefined && planKey) {
        tasks.push((async () => {
            try {
                const range = deps.range ?? '30d';
                const { startTime, endTime } = monitorRange(monitorRangeDays(range));
                const url = `${origin}${MODEL_USAGE_PATH}?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`;
                modelUsage = parseModelUsage(await getJson(url, planKey, deps, undefined, signal), range);
                return undefined;
            }
            catch (error) {
                return { source: 'model-usage', reason: String(error) };
            }
        })());
    }
    if (jwt && oauthAccessToken) {
        tasks.push((async () => {
            try {
                const scope = deps.teamContext === undefined
                    ? { providerFamily: family, targetType: 'PERSONAL' }
                    : {
                        providerFamily: family,
                        targetType: 'TEAM',
                        organizationId: deps.teamContext.organizationId,
                        projectId: deps.teamContext.projectId,
                    };
                const headers = {
                    Authorization: `Bearer ${jwt}`,
                    'X-Bigmodel-Authorization': `Bearer ${oauthAccessToken}`,
                    'Bigmodel-Target-Type': scope.targetType,
                };
                if (scope.targetType === 'TEAM') {
                    headers['Bigmodel-Organization'] = scope.organizationId;
                    headers['Bigmodel-Project'] = scope.projectId;
                }
                mcpQuota = buildMcpQuotaSnapshot(await getJson(`${deps.endpointOrigin}${MCP_USAGE_PATH}`, jwt, deps, headers, signal), scope) ?? undefined;
                return undefined;
            }
            catch (error) {
                // Official MCP quota is an optional data plane. Its failure must not
                // downgrade or add a visible failure to the entitlement snapshot.
                void error;
                mcpQuota = undefined;
                return undefined;
            }
        })());
    }
    const taskFailures = await Promise.all(tasks);
    signal?.throwIfAborted();
    failures.push(...taskFailures.filter((failure) => failure !== undefined));
    return {
        ...(modelUsage === undefined ? {} : { modelUsage }),
        ...(mcpQuota === undefined ? {} : { mcpQuota }),
        failures,
    };
}
/**
 * Combine an already-renderable core snapshot with optional delayed data.
 *
 * The input objects are never mutated. MCP quota is accepted only when the
 * core snapshot confirms a live Coding Plan subscription, so a late response
 * cannot make an unavailable account look entitled.
 */
export function mergeUsageReport(core, supplement) {
    const codingPlan = core.entitlements.codingPlan;
    const mcpQuota = codingPlan.subscription === null
        ? null
        : supplement.mcpQuota ?? codingPlan.mcpQuota ?? null;
    return {
        accountProviders: { ...core.accountProviders },
        entitlements: {
            codingPlan: { ...codingPlan, mcpQuota },
            startPlan: core.entitlements.startPlan,
        },
        ...(supplement.modelUsage === undefined ? {} : { modelUsage: supplement.modelUsage }),
        failures: [...core.failures, ...supplement.failures],
    };
}
async function appendOffPeakReport(report, deps) {
    // 错峰 / 空闲额度:**默认禁用**(见 `OFF_PEAK_REPORT_ENABLED_DEFAULT`)。
    // 该通道的派发一期不做,继续取数只会每次多打两个请求、报告里多一个用不了的额度。
    // 需要看资格时把 `offPeakReport` 传 true(或恢复默认值)即可,协议仍在 offpeak.ts。
    if (deps.offPeakReport !== true)
        return;
    const jwt = deps.zcodeJwt?.trim();
    // 先做与官方同口径的**本地**资格判定,再问服务端能不能领票。
    // 本地前提不满足时不去打扰服务端 —— 否则只会拿到一个语义模糊的错误码。
    const eligibility = resolveOffPeakEligibility({
        ...(deps.activeProvider === undefined ? {} : { activeProvider: deps.activeProvider }),
        ...(deps.accountFamily === undefined ? {} : { family: deps.accountFamily }),
        ...(deps.accountPlanKind === undefined ? {} : { planKind: deps.accountPlanKind }),
        hasZcodeJwt: jwt !== undefined && jwt !== '',
        hasCodingPlanApiKey: deps.hasCodingPlanApiKey === true,
    });
    report.offPeak = { eligibility };
    if (eligibility.supported && jwt !== undefined && deps.planApiKey !== undefined) {
        try {
            report.offPeak.availability = await fetchOffPeakAvailability({
                endpointOrigin: deps.endpointOrigin,
                zcodeJwt: jwt,
                codingPlanApiKey: deps.planApiKey,
                ...(deps.sourceHeaders === undefined ? {} : { sourceHeaders: deps.sourceHeaders }),
                ...(deps.deviceMid === undefined ? {} : { deviceMid: deps.deviceMid }),
                ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
                ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
            });
        }
        catch (error) {
            report.failures.push({ source: 'off-peak', reason: String(error) });
        }
    }
}
/**
 * Backwards-compatible complete report.
 *
 * The two collectors are started together to preserve the previous five-way
 * endpoint concurrency. Callers that render a first view should use
 * `fetchEntitlementReport` directly and defer `fetchUsageSupplement`.
 */
export async function fetchUsageReport(deps, signal) {
    const corePromise = fetchEntitlementReport(deps, signal);
    const supplementPromise = fetchUsageSupplement(deps, signal);
    const [core, supplement] = await Promise.all([corePromise, supplementPromise]);
    const report = mergeUsageReport(core, supplement);
    await appendOffPeakReport(report, deps);
    return report;
}
/** 把 epoch 毫秒渲染成 `YYYY-MM-DD HH:mm`(本地时区);无效时返回 `-`。 */
export function formatMs(ms) {
    if (ms === undefined)
        return '-';
    return formatDate(new Date(ms));
}
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
export function formatEpochSeconds(seconds) {
    if (seconds === undefined)
        return '-';
    return formatDate(new Date(seconds * 1000));
}
/** 把 ISO 串渲染成 `YYYY-MM-DD HH:mm`(本地时区);无效时返回 `-`。 */
export function formatIso(iso) {
    if (iso === undefined)
        return '-';
    return formatDate(new Date(iso));
}
function formatDate(d) {
    if (Number.isNaN(d.getTime()))
        return '-';
    const pad = (value) => String(value).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 单条额度的人读描述(对齐官方选取 `TIME_LIMIT` 优先的展示口径)。 */
export function describeLimit(limit) {
    const head = limit.type === 'TIME_LIMIT' ? '时间额度' : limit.type === 'CREDIT_LIMIT' ? '额度' : limit.type;
    const window = limit.number !== undefined && limit.unit !== undefined ? `(${limit.number}/${limit.unit})` : '';
    const used = limit.currentValue !== undefined ? `已用 ${limit.currentValue}` : '';
    const cap = limit.usage !== undefined ? `/${limit.usage}` : '';
    const remain = limit.remaining !== undefined ? ` 剩余 ${limit.remaining}` : '';
    const pct = limit.percentage !== undefined ? ` (${limit.percentage}%)` : '';
    const reset = limit.nextResetTime !== undefined ? ` 重置 ${formatMs(limit.nextResetTime)}` : '';
    return `${head}${window}: ${used}${cap}${remain}${pct}${reset}`.trim();
}
/**
 * 把 token 数渲染成紧凑的人读形式(12.0 亿 → `12.0亿`;1.2 万 → `1.2万`)。
 *
 * 中文语境下用「万/亿」比 `1.2B` 更直观;小于 1 万的保留原数,避免把小数压成 `0`.
 * @param value - token 数。
 * @returns 人读字符串。
 */
export function formatTokens(value) {
    if (!Number.isFinite(value))
        return '-';
    const abs = Math.abs(value);
    if (abs >= 1e8)
        return `${(value / 1e8).toFixed(2)}亿`;
    if (abs >= 1e4)
        return `${(value / 1e4).toFixed(1)}万`;
    return String(value);
}
/**
 * 渲染成可直接呈现的文本(激活时日志与工具输出共用)。
 * @param report - `fetchUsageReport` 的结果。
 * @returns 多行文本。
 */
export function renderUsageReport(report) {
    const lines = [];
    const coding = report.entitlements.codingPlan;
    const codingDetails = coding.subscription?.details ?? [];
    if (codingDetails.length > 0) {
        for (const detail of codingDetails) {
            lines.push(`Coding Plan: ${detail.productName}${detail.billingCycle ? ` (${detail.billingCycle})` : ''}`);
            if (detail.renewTime)
                lines.push(`  续费: ${formatIso(detail.renewTime)}`);
            if (detail.expireTime)
                lines.push(`  到期: ${formatIso(detail.expireTime)}`);
        }
    }
    else {
        lines.push(`Coding Plan: ${coding.unavailableReason ?? '未查到生效中的订阅'}`);
    }
    for (const limit of coding.quota?.limits ?? [])
        lines.push(`  ${describeLimit(limit)}`);
    if (coding.mcpQuota)
        lines.push(`  ZCode Server MCP: ${describeLimit(coding.mcpQuota.aggregate)}`);
    if (report.modelUsage !== undefined) {
        const w = report.modelUsage;
        lines.push(`用量(${w.range}): 总计 ${formatTokens(w.totalTokens)} tokens / ${w.totalCalls} 次调用`);
        lines.push(`  活跃 ${w.activeDays}/${w.days.length} 天${w.mostActiveDay === undefined ? '' : `,峰值 ${w.mostActiveDay.date}(${formatTokens(w.mostActiveDay.tokens)})`}`);
        for (const m of w.models) {
            const pct = (m.share * 100).toFixed(1);
            lines.push(`  ${m.modelId}: ${formatTokens(m.totalTokens)} (${pct}%)`);
        }
    }
    const start = report.entitlements.startPlan;
    const startDetails = start.subscription?.details ?? [];
    if (startDetails.length > 0) {
        for (const detail of startDetails) {
            lines.push(`Start Plan: ${detail.productName}`);
            lines.push(`  有效期: ${formatIso(detail.beginTime ?? undefined)} ~ ${formatIso(detail.expireTime ?? undefined)}`);
            for (const entitlement of detail.entitlements ?? []) {
                lines.push(`  权益: ${entitlement.showName ?? entitlement.entitlementId}${entitlement.effectiveTime ? ` (${formatIso(entitlement.effectiveTime)})` : ''}`);
            }
        }
        for (const limit of start.quota?.limits ?? [])
            lines.push(`  ${describeLimit(limit)}`);
    }
    else {
        lines.push(`Start Plan: ${start.unavailableReason ?? '无生效中的套餐'}`);
    }
    for (const [providerId, provider] of Object.entries(report.accountProviders)) {
        const state = provider.state;
        lines.push(`Provider ${providerId}: ${state.availability}; entitled=${state.entitled}; current=${state.current !== false}`);
    }
    if (report.offPeak !== undefined) {
        const { eligibility, availability } = report.offPeak;
        lines.push(`错峰额度(Idle plan): ${eligibility.supported ? '本地前提已满足' : `不可用(${eligibility.reason ?? '未知'})`}`);
        lines.push(`  ${eligibility.detail}`);
        if (availability !== undefined) {
            lines.push(`  领票: ${availability.canTakeNumber ? '现在可以领票' : `暂不可领${availability.nextTakeAt === undefined ? '' : `,下次 ${formatEpochSeconds(availability.nextTakeAt)}`}`}`);
        }
    }
    if (report.failures.length > 0) {
        lines.push(`取数失败: ${report.failures.map((f) => `${f.source}(${f.reason})`).join('; ')}`);
    }
    return lines.join('\n');
}
/** 空报告的便捷构造(激活期静默用)。 */
export function emptyUsageReport() {
    const generatedAt = Date.now();
    const codingProvider = { id: 'account:bigmodel-individual-coding-plan', name: 'BigModel Coding Plan' };
    const startProvider = { id: 'account:bigmodel-start-plan', name: 'BigModel Start Plan' };
    return {
        accountProviders: {
            [codingProvider.id]: accountProviderSnapshot({
                accountType: 'bigmodel', mode: 'individual-coding-plan', status: 'unknown', current: false,
            }),
            [startProvider.id]: accountProviderSnapshot({
                accountType: 'bigmodel', mode: 'start-plan', status: 'unknown', current: false,
            }),
        },
        entitlements: {
            codingPlan: unavailableSnapshot({ authenticated: false, reason: 'not_configured', provider: codingProvider, generatedAt }),
            startPlan: unavailableSnapshot({ authenticated: false, reason: 'not_configured', provider: startProvider, generatedAt }),
        },
        failures: [],
    };
}
