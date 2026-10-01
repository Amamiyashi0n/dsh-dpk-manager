/**
 * Standalone, auditable ZCode-compatible provider for DSH. The package owns the
 * wire protocol and prompt projection; DSH owns conversation history, tools,
 * and the agent loop. No ZCode executable or bundled runtime is loaded.
 *
 * @module zcode-provider
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import { type PromptOverrides, type RuntimePromptContext } from './official-prompt.js';
import { type CredentialSource } from './credentials.js';
import { type AppServerConfig } from './openzcode-app-server.js';
import { type AuthBackend } from './auth-backend.js';
export declare const name = "@local/zcode-provider";
export declare const inject: string[];
interface ZcodeModel {
    id: string;
    contextWindow?: number;
    maxTokens?: number;
    /** zcode 模型目录声明的输入模态; DSH 当前支持 text/image。 */
    inputModalities?: readonly ('text' | 'image')[];
    /** 该模型的推理档位(zcode reasoning.variants),无 reasoning 时为空 */
    efforts?: string[];
    defaultEffort?: string;
}
interface ZcodeRoute {
    route: string;
    display: string;
    kind: string;
    baseURL: string;
    apiKey: string;
    models: ZcodeModel[];
    /** 账号族:bigmodel | zai(用于还原官方运行期 provider id)。 */
    family?: string;
    /** 官方目录里的 access 声明:决定是否需要客户端签名(zhipu-account/individual-coding-plan 等) */
    access?: {
        type?: string;
        mode?: string;
        accountType?: string;
    };
    /** 该路由的凭证来源:credential-store(账号级)/ zcode-jwt / config / none */
    credential?: CredentialSource;
}
/**
 * `builtin:<family>-coding-plan/start-plan` → 官方运行期 id 与套餐种类
 * (`account:<family>-individual-coding-plan` 等),用于命中目录与凭证解析。
 */
/** `builtin:<family>-...` 展开出的运行期 provider 描述。 */
export interface RuntimeProvider {
    id: string;
    planKind?: 'individual-coding-plan' | 'team-coding-plan' | 'start-plan' | 'off-peak';
    family?: string;
}
/**
 * 错峰(idle/off-peak)通道当前**默认禁用**。
 *
 * 原因:该端点除了票据还要求"请求体里带官方 agent 系统提示词"这道取证门(见
 * `official-prompt.ts`),派发链路要"取号 → 等 active → 派发 → 结算",一期不做。
 * 关掉后错峰路由**不注册**为模型提供商,`zcode_usage` 也不再请求错峰端点。
 * 协议与判据都留在 `offpeak.ts` / `official-prompt.ts`,需要时把开关打开即可。
 */
export declare const OFF_PEAK_ENABLED_DEFAULT = false;
/**
 * `builtin:<family>-coding-plan/start-plan/offpeak-idle-plan` → 官方运行期 id 与套餐种类
 * (`account:<family>-individual-coding-plan` 等),用于命中目录与凭证解析。
 * @param pid - provider id。
 * @param offPeakEnabled - 是否启用错峰通道;禁用时不产出错峰路由。
 * @returns 运行期 provider 列表。
 */
export declare function runtimeProviders(pid: string, offPeakEnabled?: boolean): RuntimeProvider[];
/** 官方运行时提示词使用识别端点 id,而不是 DSH 设置卡上的持久化 id。 */
export declare function officialProviderId(route: Pick<ZcodeRoute, 'route' | 'family' | 'access'>): string;
/** 从 zcode 配置提取可用模型路由(enabled + 有密钥 + 有模型目录)。 */
/**
 * 从 zcode 配置提取可用模型路由(enabled + 有密钥 + 有模型目录)。
 * 套餐类条目的凭证按官方规则从 `credentials.json` 解析(凭证库优先,配置层回落)。
 * 插件配置文件缺失时,回退到官方 ZCode 本机登录态推导账号路由。
 */
export declare function extractRoutes(providerConfigPath: string, includeDisabled: boolean, credentialsPath: string, native: {
    builtinPath?: string;
    credentialsPath: string;
}, log?: Log): ZcodeRoute[];
/** 日志出口:插件把诊断交给 ctx.logger,而不是直接写 stderr。 */
type Log = (message: string) => void;
/**
 * ZCode 3.14.3 的完整官方系统提示词三块(见 `official-prompt.ts` 的实测记录)。
 *
 * 前两块是 3012 门的逐字识别前缀,第三块决定官方客户端行为。placement 为
 * `before` 时三层附加块插在官方 agent 块与运行时块之间(官方三块完整保留);
 * 为 `after` 时三层是**覆写**:逐块替换官方对应块,清空的块从请求移除。
 * @returns system 块数组,0~6 块(每次新建,避免被下游改写)。
 */
export declare function officialSystemBlocks(providerId?: string, modelId?: string, runtime?: RuntimePromptContext, overrides?: PromptOverrides): Array<Record<string, unknown>>;
/**
 * 判断通道是否受**系统提示词前缀门**约束(实测:门只逐字校验官方①②,
 * 之后的块不校验)。start-plan 与 off-peak 受限;coding-plan 直连不受限。
 */
export declare function hasPromptPrefixGate(conn: {
    access?: {
        mode?: string;
    };
    route?: string;
    display?: string;
    baseURL?: string;
}): boolean;
/**
 * 按通道装配最终 system 块。
 *
 * - **无门通道(coding-plan)**:直接用 `officialSystemBlocks` 的真覆写结果
 *   (逐块替换/移除,三层全清空 → 0 块,请求省略 system)。
 * - **有门通道(start-plan / off-peak)**:wire 层替换①②必被 405 拒绝
 *   (实测)。改为**等效覆写**:保留官方①②作网关兼容前缀(≈0.6K token),
 *   runtime 槽位照常覆写/清空(门不管③),identity/agent 的覆写与清空以一块
 *   显式 SUPERSEDE 声明置于 system 末尾——声明优先级最高,模型以覆写内容
 *   为准。官方客户端自身就用 mid-conversation system 更新规则,机制同源。
 * @returns system 块数组;空数组表示请求省略 system 字段。
 */
export declare function systemBlocksForChannel(conn: {
    access?: {
        mode?: string;
    };
    route?: string;
    display?: string;
    baseURL?: string;
}, providerId: string, modelId: string, runtime: RuntimePromptContext, overrides?: PromptOverrides): Array<Record<string, unknown>>;
/**
 * 判断本次请求是否走**错峰(idle)通道**。所有 ZCode 路由都使用官方系统提示词;
 * 这个判据只用于错峰票据与错误处理。
 *
 * 官方标识在这几处出现,拼写不统一,故先把 `-`/`_`/空格去掉再比 `offpeak`:
 *   - 路由 id:`account:bigmodel-offpeak-idle-plan`
 *   - 端点:`/api/v1/off-peak/anthropic/v1/messages`
 * @param conn - 当前连接。
 * @returns 是否错峰通道。
 */
export declare function isOffPeakRoute(conn: {
    route?: string;
    display?: string;
    baseURL?: string;
}): boolean;
/**
 * 判断最终请求 URL 是否指向**错峰通道**。
 *
 * 这是最可靠的判据:错峰路由可能复用编码套餐的 baseURL(`off-peak uses the coding plan
 * connection`),此时只有路径里的 `/off-peak/` 能区分开。
 * @param url - 已拼好的请求 URL。
 * @returns 是否错峰通道。
 */
export declare function isOffPeakRequest(url: string): boolean;
/** 插件配置。`routes` 在激活时与插件自有 provider 配置增量同步,并回写设置层。 */
export interface Config {
    /** 插件 provider 配置路径(默认 `~/.dsh/zcode-provider/providers.json`)。 */
    providerConfigPath?: string;
    /** 是否把 provider 配置中 `enabled: false` 的条目也纳入路由目录。 */
    includeDisabled?: Volatile<boolean>;
    /** 已同步的路由表,键为 provider id;设置 → 模型 页的提供商卡片读它。 */
    routes?: Volatile<Record<string, StoredRoute> | undefined>;
    /** 插件账号凭证库(`~/.dsh/zcode-provider/credentials.json`)。 */
    credentialsPath?: string;
    /** 插件设备标识文件(`~/.dsh/zcode-provider/telemetry-state.json`)。 */
    telemetryStatePath?: string;
    /** 提示词覆盖文件(`…/config/prompt-overrides.json`);测试注入以隔离机器状态。 */
    promptOverridesPath?: string;
    /** 鉴权链路持久化路径(`…/state/auth-backend.json`);测试注入以隔离机器状态。 */
    authBackendPath?: string;
    /** 官方内置目录路径覆写(本机账号回退推导用);测试注入以隔离机器状态。 */
    nativeBuiltinCatalogPath?: string;
    /** 官方本机凭证库路径覆写;测试注入以隔离机器状态。 */
    nativeCredentialsPath?: string;
    /** 是否在 start-plan/off-peak 路由收到 3007 时自动解验证码。 */
    captchaEnabled?: boolean;
    /** 客户端版本:`X-ZCode-App-Version` / `User-Agent` / `X-Client-Version`。 */ appVersion?: string;
    /** `X-Title` 的 `@` 后半段:桌面 `electron`、独立 CLI `cli`。 */
    sourceTitle?: string;
    /** `X-Release-Channel`。 */
    releaseChannel?: string;
    /** `HTTP-Referer` 与签名门闩的 origin。 */
    endpointOrigin?: string;
    /** 是否启用客户端签名(官方允许时追加 `X-Client-*` 头)。 */
    signingEnabled?: boolean;
    /** 是否给 anthropic 请求加官方 `anthropic-beta` 头。 */
    midConversationSystemBeta?: boolean;
    /** 可选的附加三段;由 placement 选择放在官方运行时块前或后。 */
    promptOverrides?: Volatile<PromptOverrides>;
    /** Authentication transport selected by the plugin UI. */
    authBackend?: AuthBackend;
    /** Optional app-server launch settings. */
    appServer?: AppServerConfig;
}
/** 设置层持久化的一条路由:由 zcode 设备配置派生,`id` 与派生路由的 `route` 同义。 */
interface StoredRoute {
    id?: string;
    display: string;
    kind?: string;
    baseURL: string;
    apiKey: string;
    models: ZcodeModel[];
    family?: string;
    access?: {
        type?: string;
        mode?: string;
        accountType?: string;
    };
    credential?: CredentialSource;
}
/** 校验并默认插件配置;`.volatile()` 的字段由设置层按引用读取。 */
export declare const Config: any;
/**
 * 接入 zcode 路由:与设备配置增量同步,并按路由注册 LLM 适配器与可配置提供商。
 * @param ctx - 携带 `llm` 服务的 Cordis 上下文;本插件只读 `settings`。
 * @param config - 该行的配置,缺省时全部取默认值。
 */
export declare function apply(ctx: Context, config?: Config): void;
export {};
