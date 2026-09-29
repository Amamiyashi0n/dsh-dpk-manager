/**
 * zcode 的阿里云验证码(Start Plan / 错峰通道的前置闸门)。
 *
 * 为什么需要它:官方 `zcode.z.ai/api/v1/zcode-plan/**` 在放行模型请求前要求
 * `X-Aliyun-Captcha-Verify-Param`;缺失时返回 `{"code":3007}`。该 param **只能**由
 * 已打开的 DSH Web UI 承载阿里云验证码 2.0 的「无痕验证」得到。Host 只负责
 * 拉取公开挑战配置、等待 Web UI 回传一次性 param，并重试原请求；凭证、模型请求
 * 和会话内容都不会发送到 Web UI。
 *
 * 官方契约(全部来自 `app.asar` 实证,行号省略、以函数名为准):
 * - 配置:`GET {origin}/api/v1/client/configs?app_version=&platform=`
 *   → `data.configs.captcha`(宿主 `getCaptchaConfig()`);
 * - 跳过判定 `p3()`:`!config || config.enabled === false || !region || !prefix || !sceneId`;
 * - 初始化:`window.AliyunCaptchaConfig = {region, prefix}` 后
 *   `initAliyunCaptcha({SceneId, mode, language, captchaLogoImg, showErrorTip, element, button, getInstance, success, fail, onError})`;
 * - 触发:`instance.startTracelessVerification()`(无痕),结果由 `success(param)` 给出;
 * - 请求头 `lnn()`:`X-Aliyun-Captcha-Verify-Param` + 有 region 时加 `X-Aliyun-Captcha-Verify-Region`;
 * - 重试语义 `CaptchaRequestRetry`:`extraAttempts === 1`,仅当错误码为 **3007**(`qDe`/`jNs`)。
 *
 * param 是**一次性的**(官方对重复 `certifyId` 会告警 F008「重复提交」),
 * 所以每次都重新跑一次;只有**配置**按官方的 60s TTL 缓存。
 *
 * @module zcode-provider/captcha
 */
/** 客户端配置端点(与官方 `Mpe` 常量一致)。 */
export const CAPTCHA_CONFIG_PATH = '/api/v1/client/configs';
/** 验证码头名称(官方渲染进程 `snn`)。 */
export const CAPTCHA_PARAM_HEADER = 'X-Aliyun-Captcha-Verify-Param';
/** 验证码区域头名称(官方渲染进程 `cnn`)。 */
export const CAPTCHA_REGION_HEADER = 'X-Aliyun-Captcha-Verify-Region';
/** 阿里云验证码 SDK 地址(官方 `ztn`)。 */
export const ALIYUN_CAPTCHA_SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
/** 官方 DOM 节点 id(容器/元素/按钮)。 */
export const CAPTCHA_DOM = {
    container: 'zcode-aliyun-captcha-container',
    element: 'zcode-aliyun-captcha-element',
    button: 'zcode-aliyun-captcha-button',
};
/** 官方 SDK 初始化模式与语言默认值。 */
export const CAPTCHA_SDK_DEFAULTS = { mode: 'popup', language: 'cn' };
/** 官方配置缓存 TTL(`f3()` 里的 `t + 6e4`)。 */
export const CAPTCHA_CONFIG_TTL_MS = 60_000;
/** 「captcha 拒绝」的唯一错误码(官方 `jNs` = "3007",`qDe()` 只认它)。 */
export const CAPTCHA_REJECTION_CODE = '3007';
/**
 * 按官方 `p3()` 判定是否应当**跳过**验证码。
 *
 * 官方逻辑:任一字段缺失即视为"没配好",直接跳过而不是报错 —— 这条 fail-open
 * 语义必须照抄,否则服务端没开验证码时我们会白白卡住。
 * @param config - `data.configs.captcha`,可为 `undefined`。
 * @returns 是否跳过。
 */
export function shouldSkipCaptcha(config) {
    if (config === null || config === undefined)
        return true;
    if (config.enabled === false)
        return true;
    if (config.region === undefined || config.region.trim() === '')
        return true;
    if (config.prefix === undefined || config.prefix.trim() === '')
        return true;
    if (config.sceneId === undefined || config.sceneId.trim() === '')
        return true;
    return false;
}
/**
 * 从 `client/configs` 响应里取 captcha 段(官方 `getCaptchaConfig()`)。
 * @param envelope - 响应 JSON。
 * @returns captcha 配置;缺失时为 `null`。
 */
export function readCaptchaConfig(envelope) {
    const data = envelope?.data;
    const configs = data?.configs;
    const captcha = configs?.captcha;
    return captcha === null || captcha === undefined || typeof captcha !== 'object' ? null : captcha;
}
/**
 * 按官方 `lnn()` 生成验证码头。
 * @param config - captcha 配置(提供 region)。
 * @param param - 已求得的 verify param。
 * @returns 头名 → 值;`param` 为空时返回空对象。
 */
export function captchaRequestHeaders(config, param) {
    const value = param.trim();
    if (value === '')
        return {};
    const region = config?.region?.trim() ?? '';
    return {
        [CAPTCHA_PARAM_HEADER]: value,
        ...(region === '' ? {} : { [CAPTCHA_REGION_HEADER]: region }),
    };
}
/**
 * 判定响应是否为「需要 captcha」的拒绝(官方 `qDe()`:只认 3007)。
 * @param body - 响应体文本。
 * @returns 是否命中。
 */
export function isCaptchaRejection(body) {
    const matched = /"code"\s*:\s*"?(\d+)"?/.exec(body);
    return matched?.[1] === CAPTCHA_REJECTION_CODE;
}
/**
 * 是否应当走「解验证码后重试一次」。
 *
 * 两个条件缺一不可,与官方 `CaptchaRequestRetry.claim()` 一致:
 * 该路由的 access mode 是 `start-plan`(官方另支持 off-peak),且错误码为 3007。
 * 其它路由即使收到 3007 也不解验证码 —— 避免为无关失败创建 Web UI 挑战。
 * @param accessMode - 路由的 `access.mode`。
 * @param body - 响应体文本。
 * @returns 是否重试。
 */
export function shouldRetryWithCaptcha(accessMode, body) {
    if (accessMode !== 'start-plan' && accessMode !== 'off-peak')
        return false;
    return isCaptchaRejection(body);
}
/** 本地缓存的配置(官方 60s TTL,按 origin 分键)。 */
let configCache;
/** 并发去重:同一时刻只发一次配置请求(官方用 `d3` promise 去重)。 */
let configInflight;
/** 清空配置缓存(测试用)。 */
export function resetCaptchaConfigCache() {
    configCache = undefined;
    configInflight = undefined;
}
function cancellationError(signal) {
    return signal.reason ?? new Error('验证码配置请求已取消');
}
// Keep this check behind a function because an AbortSignal may change while an
// awaited configuration read is pending; TypeScript otherwise narrows its
// mutable `aborted` property across the await boundary.
function isCancelled(signal) {
    return signal?.aborted === true;
}
/**
 * Allow a cancelled model request to leave a shared configuration read
 * immediately. The underlying read remains alive so another in-flight model
 * request can still populate the 60s cache instead of being cancelled by an
 * unrelated caller.
 */
function awaitCaptchaConfig(pending, signal) {
    if (signal === undefined)
        return pending;
    if (signal.aborted)
        return Promise.reject(cancellationError(signal));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(cancellationError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void pending.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
/**
 * 取 captcha 配置(带官方 60s 缓存与并发去重)。
 * @param input - origin/凭证/版本。
 * @returns captcha 配置或 `null`;请求失败按官方 fail-open 返回 `null`。
 */
export async function fetchCaptchaConfig(input) {
    const now = Date.now();
    if (isCancelled(input.signal))
        throw cancellationError(input.signal);
    if (configCache !== undefined && configCache.origin === input.endpointOrigin && configCache.expiresAt > now) {
        return configCache.value;
    }
    if (configInflight !== undefined)
        return await awaitCaptchaConfig(configInflight, input.signal);
    const doFetch = input.fetch ?? fetch;
    const url = new URL(CAPTCHA_CONFIG_PATH, input.endpointOrigin);
    url.searchParams.set('app_version', input.appVersion);
    if (input.platform !== undefined && input.platform !== '')
        url.searchParams.set('platform', input.platform);
    const pending = (async () => {
        try {
            const response = await doFetch(url.toString(), {
                method: 'GET',
                headers: {
                    authorization: `Bearer ${input.zcodeJwt}`,
                    accept: 'application/json',
                    // 官方每个 zcode.z.ai 请求都带 x-device-mid;缺它会被判 3001(设备身份未识别)
                    ...(input.deviceMid === undefined || input.deviceMid.trim() === '' ? {} : { 'x-device-mid': input.deviceMid.trim() }),
                },
                signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
            });
            if (!response.ok)
                return null;
            return readCaptchaConfig(await response.json());
        }
        catch (_unreachable) {
            // 官方 `f3()` 同样吞掉异常并返回 null(拿不到配置就跳过验证码)
            return null;
        }
    })();
    const inflight = pending.then((value) => {
        configCache = { origin: input.endpointOrigin, value, expiresAt: now + CAPTCHA_CONFIG_TTL_MS };
        return value;
    }).finally(() => {
        if (configInflight === inflight)
            configInflight = undefined;
    });
    configInflight = inflight;
    return await awaitCaptchaConfig(inflight, input.signal);
}
/**
 * 取一个**全新**的 verify param。
 *
 * 顺序与官方一致:先取配置 → `p3()` 判定是否该跳过 → 交给求解器。
 * 失败不抛错,统一用 `state` 表达,便于调用方按 fail-open 继续(官方同样 fail-open)。
 * @param input - 端点/凭证/求解器。
 * @returns 求解结果;`state === 'success'` 时 `param` 可用。
 */
export async function solveCaptcha(input) {
    const started = Date.now();
    if (isCancelled(input.signal)) {
        return { param: '', state: 'unavailable', reason: '验证码请求已取消', ms: Date.now() - started };
    }
    let config;
    try {
        config = await fetchCaptchaConfig(input);
    }
    catch (error) {
        if (isCancelled(input.signal)) {
            return { param: '', state: 'unavailable', reason: '验证码请求已取消', ms: Date.now() - started };
        }
        return { param: '', state: 'error', reason: String(error), ms: Date.now() - started };
    }
    if (isCancelled(input.signal)) {
        return { param: '', config: config ?? undefined, state: 'unavailable', reason: '验证码请求已取消', ms: Date.now() - started };
    }
    if (shouldSkipCaptcha(config)) {
        return { param: '', state: 'no-config', reason: '服务端未启用验证码(或配置缺 region/prefix/sceneId),按官方语义跳过', ms: Date.now() - started };
    }
    const solver = input.solver;
    if (solver === undefined) {
        return { param: '', config: config, state: 'unavailable', reason: 'DSH Web UI 验证码承载层尚未就绪', ms: Date.now() - started };
    }
    try {
        const result = await solver(config, input.signal);
        return {
            ...result,
            // Only an Aliyun success callback may carry a reusable verification
            // parameter. A failed SDK callback with stale data must never trigger a
            // model retry.
            param: result.state === 'success' ? result.param : '',
            config: config,
        };
    }
    catch (error) {
        return { param: '', config: config, state: 'error', reason: String(error), ms: Date.now() - started };
    }
}
/**
 * 描述一次求解失败,给出**可执行**的下一步(而不是把 `state` 原样抛给用户)。
 * @param result - `solveCaptcha` 的结果。
 * @returns 中文说明。
 */
export function describeCaptchaFailure(result) {
    switch (result.state) {
        case 'no-config':
            return '服务端未启用验证码,已按官方语义跳过';
        case 'unavailable':
            return 'DSH Web UI 验证码承载层未连接;请保持 Web UI 打开后重试';
        case 'timeout':
            return '等待 DSH Web UI 完成验证码超时;请在验证码浮层完成验证后重试';
        case 'fail':
            return `验证码被风控拒绝${result.verifyCode === undefined ? '' : `(${result.verifyCode})`}`
                + (result.verifyCode === 'F001' ? ':无痕验证判定失败' : '')
                + (result.verifyCode === 'F008' ? ':certifyId 重复提交,param 是一次性的,不能复用' : '');
        case 'error':
            return `验证码执行异常:${result.reason ?? '未知'}`;
        default:
            return result.reason ?? '';
    }
}
