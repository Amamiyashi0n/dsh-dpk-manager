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
import { LlmError } from '@deepseek-ai/dsh-llm';
/**
 * 把一次失败分类成 DSH 的 provider-neutral code(顺序有意义,与
 * `llm-deepseek/transport.ts` 同序)。
 *
 * 额度判断必须排在限流之前:官方把可充值的终态欠费也发成 HTTP 429,先判 429 就降级成
 * `RATE_LIMIT`;而 DSH 依据 code 路由——只有 `QUOTA` 会触发失败行的额度文案与全局
 * `shell.quota-notice` 提醒(第一方账号路由还会改写为 `ACCOUNT_QUOTA` 以提供充值入口)。
 * @param status - HTTP 状态码;流内错误与 app-server 委托没有状态码。
 * @param type - 提供方的错误类型字段(如 `rate_limit_error`)。
 * @param businessCode - 业务码原文(如 `1113`);app-server 传 `providerErrorCode`。
 * @param detail - 类型/业务码/消息拼成的判定文本。
 * @returns 稳定的失败 code。
 */
export declare function failureCode(status: number | undefined, type: string, businessCode: string, detail: string): string;
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
export declare function failureFrom(status: number | undefined, raw: unknown, fallbackMessage: string): LlmError;
