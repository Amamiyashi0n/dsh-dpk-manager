/**
 * 官方 ZCode 本机登录态 → 插件账号路由(插件自身 provider 配置缺失时的回退源)。
 *
 * 以系统里的真实数据为基准,不要求运维预置 `providers.json`:
 * - 端点来自已发现安装自带的内置目录(`zcode-builtin.json`,与官方客户端同源);
 * - 套餐凭证来自官方凭证库(`~/.zcode/v2/credentials.json`,
 *   与插件凭证同键名空间、同 `enc:v1` 解密规则)。
 *
 * 只产出本机确实登录了的套餐(凭证解析不到即不注册),因此不会出现死路由。
 *
 * @module zcode-provider/native-account
 */
/** 官方存储目录(与官方 credential service 一致:环境覆写 > `~/.zcode/v2`)。 */
export declare function nativeStorageDir(): string;
/** 官方凭证库路径。 */
export declare function nativeCredentialPath(): string;
/** 官方 ZCode 设备状态路径。 */
export declare function nativeTelemetryStatePath(): string;
/**
 * 已发现安装自带的内置目录路径。优先使用显式路径和开发仓库路径，
 * 再走安装发现；这些路径必须与官方 app-server 使用同一份目录。
 */
export declare function discoveredBuiltinCatalogPath(): string | undefined;
/** 目录中一条账号端点:插件条目键 + 官方 provider 族 + 可解析的套餐模式。 */
export interface NativeAccountEndpoint {
    key: string;
    family: string;
    modes: Array<'individual-coding-plan' | 'team-coding-plan' | 'start-plan'>;
    baseURL: string;
}
/** 从内置目录 JSON 提取账号端点;individual/team 合并为同一条 coding-plan 路由。 */
export declare function accountEndpointsFromCatalog(catalog: unknown): NativeAccountEndpoint[];
/** 内置目录对单个模型声明的上下文事实(与官方 app-server 同一正则链的结论)。 */
export interface CatalogModelConfig {
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsImage?: boolean;
    supportsPdf?: boolean;
}
/**
 * 把内置目录的 `config.modelConfigRules.modelRules` 应用到一个模型 id:按数组
 * 顺序逐条匹配 `modelMatch` 正则(后条覆盖前条),合并出 ZCode 权威的
 * contextWindow / maxOutputTokens / 输入模态。官方 app-server 用同一条规则链
 * 回答"这个模型多大",插件同步它而不是另猜一个数。目录里其余子键
 * (`modelApiRules` 管线格式映射、`templateModelRules`/`builtinProviderModelRules`
 * 只是 enable 开关)与上下文无关,不参与。
 * @param catalog - 解析后的 `zcode-builtin.json`。
 * @param modelId - 待解析的模型 id(大小写不敏感匹配,与目录正则写法一致)。
 */
export declare function modelConfigFromCatalog(catalog: unknown, modelId: string): CatalogModelConfig;
/** `providers.json` 形状的账号条目(供 extractRoutes 复用同一条处理循环)。 */
export interface NativeProviderEntry {
    kind: 'anthropic';
    options: {
        baseURL: string;
        apiKey: string;
    };
    /** 已解析的官方内置目录;extractRoutes 用它取模型上下文等目录事实。 */
    catalog?: unknown;
}
/**
 * 从本机官方 ZCode 登录态推导账号条目;目录缺失/损坏或套餐未登录时不产出该条。
 * @param options - 路径注入(测试隔离用)与日志出口。
 */
export declare function nativeAccountProviders(options?: {
    builtinPath?: string;
    credentialsPath?: string;
    log?: (message: string) => void;
}): Record<string, NativeProviderEntry>;
