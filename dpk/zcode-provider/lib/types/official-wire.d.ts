/**
 * ZCode 3.14.3-compatible 出站线格式:归因头、请求级身份头与客户端签名。
 *
 * 本文件是协议本身的完整可审计实现，不加载外部运行时或预编译业务模块。
 *
 * @module zcode-provider/official-wire
 */
/**
 * 官方客户端版本;`X-ZCode-App-Version` 与 `User-Agent` 都用它。
 *
 * 取 **3.14.3** 而不是早先抓包时的 3.14.1:本机安装的桌面版 asar 里版本常量就是
 * `var qc="3.14.3"`(构建 `ab4d5e6b`,构建时间 `2026-09-22T03:05:10.708Z`),
 * 而 `~/.zcode/v2/config.json` 也是这个版本生成的。归因头自报的版本与设备上
 * 真实客户端一致才不会自相矛盾。
 */
export declare const ZCODE_CLIENT_VERSION = "3.14.3";
/** 官方默认 zcode 端点(HTTP-Referer / 签名门闩 origin 的来源)。 */
export declare const ZCODE_ENDPOINT_ORIGIN = "https://zcode.z.ai";
/** 签名门闩:GET 该路径,读 `data.codingPlanSignature.enable`。 */
export declare const SIGNATURE_GATE_PATH = "/api/v1/agent/configs";
/** 签名握手:POST `<provider origin>` + 该路径。 */
export declare const SIGN_HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
/** 握手签名消息前缀。 */
export declare const SIGN_MESSAGE_PREFIX = "get_sign_key";
/** 客户端签名主体:appId。 */
export declare const SIGN_APP_ID = "zcode";
/** HKDF salt / info(私钥与握手密钥都从这里派生)。 */
export declare const SIGN_KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
export declare const SIGN_KEY_INFO = "getSignKey_hmac";
export declare const SIGN_PRIVATE_KEY_INFO = "ed25519_priv";
/** PoW 前导零比特数。 */
export declare const SIGN_POW_BITS = 8;
/** 签名 nonce 字节数(hex 后 32 字符);PoW nonce 为 12 字节。 */
export declare const SIGN_NONCE_BYTES = 16;
export declare const SIGN_POW_NONCE_BYTES = 12;
/** 门闩缓存 TTL 与超时(官方 1h / 15s)。 */
export declare const SIGNATURE_GATE_TTL_MS = 3600000;
export declare const SIGNATURE_GATE_TIMEOUT_MS = 15000;
/** 握手超时(官方 10s)。 */
export declare const SIGN_HANDSHAKE_TIMEOUT_MS = 10000;
/** anthropic 系请求带的 beta 头(官方抓包实测值)。 */
export declare const ANTHROPIC_BETA_MID_CONVERSATION_SYSTEM = "mid-conversation-system-2026-04-07";
/** 官方引擎在 UA 尾部追加的 ai-sdk 标识(抓包实测值)。 */
export declare const AI_SDK_USER_AGENT_SUFFIX = "ai-sdk/provider-utils/4.0.27 runtime/node.js/24";
/** 每个请求都要带的官方源码头所需的输入。 */
export interface WireProfile {
    /** `X-ZCode-App-Version` / `User-Agent` 里的版本。 */
    appVersion: string;
    /** `X-Title` 的 `@` 后半段:桌面为 `electron`,独立 CLI 为 `cli`。 */
    sourceTitle: string;
    /** `X-Release-Channel`;官方生产构建为 `production`。 */
    releaseChannel: string;
    /** `HTTP-Referer` 与签名门闩的 origin。 */
    endpointOrigin: string;
    /** `X-Platform`,形如 `win32-x64`(node 的 platform-arch,不是 `windows-x64`)。 */
    platform: string;
    /** `X-Os-Version`,node 的 `os.release()`。 */
    osVersion: string;
    clientLanguage: string;
    clientTimezone: string;
    /** 设备标识;只进 `metadata.user_id`,不作为请求头(与官方抓包一致)。 */
    deviceMid?: string;
}
/**
 * 构造官方源码头集合(逐字段对齐官方 `buildZCodeSourceHeadersFromContext`)。
 * @param profile - 版本、平台、时区等运行时事实。
 * @returns 直接合并进请求的头集合。
 */
export declare function buildSourceHeaders(profile: WireProfile): Record<string, string>;
/** 从可选的设备状态文件读取 `deviceMid`。 */
export declare function readDeviceMid(telemetryStatePath: string): string | undefined;
/**
 * 该 provider 的模型请求是否需要客户端签名(官方 `requiresClientRequestSigning`)。
 * 规则:start-plan / off-peak 不需要;individual/team coding plan 与官方 zcode 主机需要。
 * @param baseURL - provider 的 API 根地址。
 * @param access - provider 的 access 声明(可缺省)。
 * @returns 需要签名时为 true。
 */
export declare function requiresClientSigning(baseURL: string, access?: {
    type?: string;
    mode?: string;
}): boolean;
/** 官方 `parseClientSigningCredential`:凭证必须是 `<apiKeyId>.<apiKeySecret>`,只允许一个分隔点。 */
export declare function parseSigningCredential(apiKey: string): {
    apiKeyId: string;
    apiKeySecret: string;
} | undefined;
/** 客户端请求 PoW(官方 `Jcr`):nonce 12 字节 hex + 计数,sha256 前导零比特达标即返回;消息用换行分隔。 */
export declare function solveProofOfWork(apiKeyId: string, sessionId: string, ts: string, powBits?: number): string;
/** 签名门闩与握手的可注入依赖(测试用)。 */
export interface SignerDeps {
    /** 发送门闩/握手请求;默认用全局 fetch。 */
    fetch?: typeof fetch;
    /** 现在(ms)。 */
    now?: () => number;
    /** 日志出口。 */
    log?: (message: string) => void;
}
/** 网关拒绝签名时的可刷新原因码(官方 `eJt`/`b5i`/`S5i`)。 */
export declare const SIGNATURE_REJECTION_REASONS: readonly ["VERIFY_SIGNATURE_INVALID", "VERIFY_APIKEY_EXPIRED"];
/**
 * 判定 401 响应体是否为可刷新的签名拒绝(官方只在 401 且 reason 命中时才重试/旁路)。
 * @param status - HTTP 状态码。
 * @param body - 已读出的响应文本。
 * @returns 命中时为对应原因码,否则 undefined。
 */
export declare function refreshableSignatureRejection(status: number, body: string): string | undefined;
/** 构造一个签名的请求头集合所需的输入。 */
export interface SignRequestInput {
    /** provider 凭证(`<id>.<secret>` 形态)。 */
    apiKey: string;
    /** provider 的 API 根地址;握手 origin 取它的 origin。 */
    baseURL: string;
    /** `X-Client-Version`。 */
    clientVersion: string;
    /** `X-Session-Id`;官方用会话 id,去掉 `sess_`/`subagent_agent_` 前缀。 */
    sessionId: string;
    /** 门闩与源码头用的 profile。 */
    profile: WireProfile;
    /** 中止信号。 */
    signal?: AbortSignal;
}
/** 官方式客户端签名:门闩 → 握手 → Ed25519(官方 `ClientRequestSigningV4Signer`)。 */
export declare class ClientRequestSigner {
    #private;
    /**
     * @param deps - 可注入的 fetch/时钟/日志。
     */
    constructor(deps?: SignerDeps);
    /** 门闩查询结果(供诊断)。 */
    get bypassing(): boolean;
    /** 丢弃已缓存的私钥,强制下次签名重新握手(官方 `invalidatePrivateKey`)。 */
    invalidatePrivateKey(): void;
    /** 连续两次被拒绝后进入旁路:本签名器实例后续一律发未签名请求(官方 `bypass_entering`)。 */
    enterBypass(): void;
    /**
     * 服务端是否开启了客户端签名(官方 `CodingPlanSignatureFeatureGate`)。
     * @param apiKey - provider 凭证;作为门闩请求的 `x-api-key`。
     * @param profile - 用于构造源码头。
     * @param signal - 中止信号。
     * @returns 门闩为 `data.codingPlanSignature.enable === true` 时返回 true。
     */
    isEnabled(apiKey: string, profile: WireProfile, signal?: AbortSignal): Promise<boolean>;
    /**
     * 按官方语义给请求补充签名头;签名不可用时返回未修改的头(官方 fail-open)。
     * @param headers - 已构造好的请求头(会被复制)。
     * @param input - 凭证、地址、会话与 profile。
     * @returns 追加签名头后的新头集合。
     */
    signHeaders(headers: Record<string, string>, input: SignRequestInput): Promise<Record<string, string>>;
}
