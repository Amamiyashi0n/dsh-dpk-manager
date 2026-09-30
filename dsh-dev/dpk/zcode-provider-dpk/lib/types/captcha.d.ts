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
export declare const CAPTCHA_CONFIG_PATH = "/api/v1/client/configs";
/** 验证码头名称(官方渲染进程 `snn`)。 */
export declare const CAPTCHA_PARAM_HEADER = "X-Aliyun-Captcha-Verify-Param";
/** 验证码区域头名称(官方渲染进程 `cnn`)。 */
export declare const CAPTCHA_REGION_HEADER = "X-Aliyun-Captcha-Verify-Region";
/** 阿里云验证码 SDK 地址(官方 `ztn`)。 */
export declare const ALIYUN_CAPTCHA_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
/** 官方 DOM 节点 id(容器/元素/按钮)。 */
export declare const CAPTCHA_DOM: {
    readonly container: "zcode-aliyun-captcha-container";
    readonly element: "zcode-aliyun-captcha-element";
    readonly button: "zcode-aliyun-captcha-button";
};
/** 官方 SDK 初始化模式与语言默认值。 */
export declare const CAPTCHA_SDK_DEFAULTS: {
    readonly mode: "popup";
    readonly language: "cn";
};
/** 官方配置缓存 TTL(`f3()` 里的 `t + 6e4`)。 */
export declare const CAPTCHA_CONFIG_TTL_MS = 60000;
/** 「captcha 拒绝」的唯一错误码(官方 `jNs` = "3007",`qDe()` 只认它)。 */
export declare const CAPTCHA_REJECTION_CODE = "3007";
/** `data.configs.captcha` 的形状。 */
export interface CaptchaConfig {
    /** 服务端是否启用验证码;`false` 表示直接跳过。 */
    enabled?: boolean;
    /** 场景前缀,用于初始化 SDK 的 `prefix`。 */
    prefix?: string;
    /** 区域,`cn` 等。 */
    region?: string;
    /** 场景 id,初始化 SDK 的 `SceneId`。 */
    sceneId?: string;
}
/** 一次求解的结果。 */
export interface CaptchaSolveResult {
    /** 成功时的 param;失败为空串。 */
    param: string;
    /** 求解时使用的配置(生成请求头需要 region)。 */
    config?: CaptchaConfig;
    /** 结束时状态,便于诊断。 */
    state: 'success' | 'fail' | 'error' | 'timeout' | 'no-config' | 'unavailable';
    /** 阿里云的失败码(如 `F001` 无痕失败、`F008` 重复提交)。 */
    verifyCode?: string;
    /** 人类可读的失败原因。 */
    reason?: string;
    /** 耗时毫秒。 */
    ms: number;
}
/** 拉配置所需的输入。 */
export interface CaptchaConfigInput {
    /** zcode 端点 origin(如 `https://zcode.z.ai`)。 */
    endpointOrigin: string;
    /** `zcodejwttoken`。 */
    zcodeJwt: string;
    /** 客户端版本,官方用作 `app_version`。 */
    appVersion: string;
    /** 平台串,官方用作 `platform`(如 `win32-x64`)。 */
    platform?: string;
    /** 设备标识(官方每个 zcode.z.ai 请求都带 `x-device-mid`)。 */
    deviceMid?: string;
    /** 注入的 fetch(测试用)。 */
    fetch?: typeof fetch;
    /** 超时毫秒。 */
    timeoutMs?: number;
    /** 关联的模型请求取消信号；取消只停止当前等待者，不中断共享配置缓存请求。 */
    signal?: AbortSignal;
}
/**
 * 按官方 `p3()` 判定是否应当**跳过**验证码。
 *
 * 官方逻辑:任一字段缺失即视为"没配好",直接跳过而不是报错 —— 这条 fail-open
 * 语义必须照抄,否则服务端没开验证码时我们会白白卡住。
 * @param config - `data.configs.captcha`,可为 `undefined`。
 * @returns 是否跳过。
 */
export declare function shouldSkipCaptcha(config: CaptchaConfig | null | undefined): boolean;
/**
 * 从 `client/configs` 响应里取 captcha 段(官方 `getCaptchaConfig()`)。
 * @param envelope - 响应 JSON。
 * @returns captcha 配置;缺失时为 `null`。
 */
export declare function readCaptchaConfig(envelope: unknown): CaptchaConfig | null;
/**
 * 按官方 `lnn()` 生成验证码头。
 * @param config - captcha 配置(提供 region)。
 * @param param - 已求得的 verify param。
 * @returns 头名 → 值;`param` 为空时返回空对象。
 */
export declare function captchaRequestHeaders(config: CaptchaConfig | null | undefined, param: string): Record<string, string>;
/**
 * 判定响应是否为「需要 captcha」的拒绝(官方 `qDe()`:只认 3007)。
 * @param body - 响应体文本。
 * @returns 是否命中。
 */
export declare function isCaptchaRejection(body: string): boolean;
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
export declare function shouldRetryWithCaptcha(accessMode: string | undefined, body: string): boolean;
/** 清空配置缓存(测试用)。 */
export declare function resetCaptchaConfigCache(): void;
/**
 * 取 captcha 配置(带官方 60s 缓存与并发去重)。
 * @param input - origin/凭证/版本。
 * @returns captcha 配置或 `null`;请求失败按官方 fail-open 返回 `null`。
 */
export declare function fetchCaptchaConfig(input: CaptchaConfigInput): Promise<CaptchaConfig | null>;
/** 求解器端口:由调用方注入，由 DSH Web UI 的验证码承载层完成交互。 */
export type CaptchaSolverPort = (config: CaptchaConfig, signal?: AbortSignal) => Promise<CaptchaSolveResult>;
/** 一次求解所需的输入。 */
export interface SolveCaptchaInput extends CaptchaConfigInput {
    /** 注入的求解器;缺省时返回 `unavailable`。 */
    solver?: CaptchaSolverPort;
}
/**
 * 取一个**全新**的 verify param。
 *
 * 顺序与官方一致:先取配置 → `p3()` 判定是否该跳过 → 交给求解器。
 * 失败不抛错,统一用 `state` 表达,便于调用方按 fail-open 继续(官方同样 fail-open)。
 * @param input - 端点/凭证/求解器。
 * @returns 求解结果;`state === 'success'` 时 `param` 可用。
 */
export declare function solveCaptcha(input: SolveCaptchaInput): Promise<CaptchaSolveResult>;
/**
 * 描述一次求解失败,给出**可执行**的下一步(而不是把 `state` 原样抛给用户)。
 * @param result - `solveCaptcha` 的结果。
 * @returns 中文说明。
 */
export declare function describeCaptchaFailure(result: CaptchaSolveResult): string;
