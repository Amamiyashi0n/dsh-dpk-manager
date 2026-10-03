/**
 * Provider failure classification shared by both transports.
 *
 * `zcode-provider` reaches the account endpoints two ways — the direct wire
 * (`index.ts`, Coding Plan) and the delegated app-server engine (`start-plan` /
 * off-peak) — and a quota failure must classify identically on both, because
 * DSH routes on the code, never on message text.
 *
 * The domestic endpoints report a terminal out-of-quota condition as an
 * ordinary rate-limit status with the reason in the body:
 *   实测 `429 {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}`
 * Classifying by status alone therefore degrades a payable, terminal failure
 * into a retryable `RATE_LIMIT`, and DSH's quota reminder — the failed turn's
 * neutral quota copy plus the frame-wide `shell.quota-notice` — never fires.
 *
 * @module zcode-provider/failure
 */
import { isQuotaExceededError, LlmError } from '@deepseek-ai/dsh-llm';
/**
 * 额度耗尽的业务码。官方把**终态欠费**发成 HTTP 429,所以业务码必须参与分类,
 * 只看状态码会把欠费误判成可重试的限流。
 */
const QUOTA_BUSINESS_CODES = new Set(['1113']);
/** 额度耗尽的中文措辞:DSH 共享判定 `isQuotaExceededError` 只覆盖英文。 */
const QUOTA_WORDING = /余额不足|额度不足|无可用资源包|欠费|请充值|额度(?:已)?(?:用尽|耗尽|用完)/u;
/**
 * 把一次失败分类成 DSH 的 provider-neutral code(顺序有意义,与
 * `llm-deepseek/transport.ts` 同序)。
 *
 * 额度判断必须排在限流之前:官方把可充值的终态欠费也发成 HTTP 429,先判 429 就降级成
 * `RATE_LIMIT`;而 DSH 依据 code 路由——只有 `QUOTA` 会触发失败行的额度文案与全局
 * `shell.quota-notice` 提醒。
 *
 * **本插件一律产出 `QUOTA`,绝不产出 `ACCOUNT_QUOTA`**:后者是第一方 DeepSeek 账号路由
 * (`llm-deepseek-account`)把自己的 `QUOTA` 改写出来的码,而客户端的账号条目只认领它并
 * 弹出「去充值」Modal。ZCode 额度用尽的诉求是**提醒**,不是购买入口,所以这里停在 `QUOTA`;
 * `tests/error-classification.mjs` 锁住这条不变量。
 * @param status - HTTP 状态码;流内错误与 app-server 委托没有状态码。
 * @param type - 提供方的错误类型字段(如 `rate_limit_error`)。
 * @param businessCode - 业务码原文(如 `1113`);app-server 传 `providerErrorCode`。
 * @param detail - 类型/业务码/消息拼成的判定文本。
 * @returns 稳定的失败 code。
 */
export function failureCode(status, type, businessCode, detail) {
    if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error')
        return 'AUTH';
    if (status === 402
        || type === 'billing_error'
        || isQuotaExceededError(detail)
        || QUOTA_BUSINESS_CODES.has(businessCode)
        || QUOTA_WORDING.test(detail))
        return 'QUOTA';
    if (status === 429 || type === 'rate_limit_error')
        return 'RATE_LIMIT';
    if (status === 400 || status === 413 || type === 'invalid_request_error')
        return 'INVALID_REQUEST';
    if ((status !== undefined && status >= 500) || type === 'api_error' || type === 'overloaded_error')
        return 'SERVER';
    return status === undefined ? 'SERVER' : `HTTP_${status}`;
}
/**
 * 从一次失败的原始载荷构造 `LlmError`。三种形态都认:Anthropic 的
 * `{error:{type,message,code}}`、国内端点的 `{code,msg}`(如 3007 验证码、1113 余额不足),
 * 以及直接把消息放在顶层的 `{message}`(流内 `error` 事件即此形态)。
 * 消息与业务码都要参与分类——额度提醒完全建立在它们之上。
 * @param status - HTTP 状态码;流内错误传 undefined。
 * @param raw - 已解析的响应体或流内 `error` 事件;非对象时视为无结构化信息。
 * @param fallbackMessage - 载荷里没有消息时使用的文本。
 * @returns 带稳定 code 的失败;`QUOTA` 是欠费提醒(而非重试)的触发条件。
 */
export function failureFrom(status, raw, fallbackMessage) {
    const envelope = (typeof raw === 'object' && raw !== null ? raw : {});
    const nested = (typeof envelope.error === 'object' && envelope.error !== null ? envelope.error : {});
    const message = String(nested.message ?? nested.msg ?? envelope.message ?? envelope.msg ?? fallbackMessage);
    const type = typeof nested.type === 'string' ? nested.type : '';
    const rawCode = nested.code ?? envelope.code;
    const businessCode = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : '';
    const code = failureCode(status, type, businessCode, `${type} ${businessCode} ${message}`);
    return new LlmError(message, code, status === undefined ? {} : { status });
}
