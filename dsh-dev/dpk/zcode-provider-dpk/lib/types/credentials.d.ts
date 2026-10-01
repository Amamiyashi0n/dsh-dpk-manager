/**
 * 官方 zcode 的凭证解析(与 `credentials.json` 同源、同规则)。
 *
 * 官方桌面/引擎取模型凭证的顺序(见 `ZCode-open/packages/services/src/model-provider/`):
 * - `account:<family>-individual-coding-plan` / `-team-coding-plan`:
 *   先读 `account-provider:<providerId>:identity` 拿到账号身份,再读
 *   `account-provider:coding-plan:<providerId>:account:<identity>:api-key`;
 * - `account:<family>-start-plan`:账号 active provider 命中该 family 时,用 `zcodejwttoken`;
 * - 都取不到时才回落到 provider 配置里的 `apiKey`。
 *
 * 存储值可能是密文(`enc:v1:<iv>.<tag>.<ct>`,AES-256-GCM),
 * 密钥 = SHA-256(`zcode-credential-fallback:win32:<homedir>:<username>`)。
 *
 * @module zcode-provider/credentials
 */
export { defaultCredentialsPath } from './storage.js';
/** 凭证键:`account-provider:<providerId>:identity`。 */
export declare const identityKey: (providerId: string) => string;
/** 凭证键:套餐 api-key(individual/team coding plan)。 */
export declare const codingPlanApiKeyKey: (providerId: string, identity: string) => string;
/** 账号级注入的 start-plan JWT 键。 */
export declare const ZCODE_JWT_KEY = "zcodejwttoken";
/** 账号当前选中的 OAuth provider 键。 */
export declare const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
/** 凭证来源(用于日志与诊断)。 */
export type CredentialSource = 'credential-store' | 'zcode-jwt' | 'config' | 'none';
/** 解析结果。 */
export interface ResolvedCredential {
    /** 实际使用的凭证;`source` 为 `none` 时为空串。 */
    apiKey: string;
    /** 凭证来自哪一层。 */
    source: CredentialSource;
}
/** 解析所需输入。 */
export interface ResolvePlanCredentialInput {
    /** `credentials.json` 路径。 */
    credentialsPath: string;
    /** 官方运行期 provider id(如 `account:bigmodel-individual-coding-plan`)。 */
    providerId: string;
    /** 账号族:`bigmodel` / `zai`。 */
    family?: string;
    /** 套餐种类。 */
    planKind?: 'individual-coding-plan' | 'team-coding-plan' | 'start-plan' | 'off-peak';
    /** 配置层 `options.apiKey`,作为最后回落。 */
    fallbackApiKey?: string;
    /** 官方本机凭证库(如 `~/.zcode/v2/credentials.json`):插件凭证库缺键时从这里补。 */
    fallbackCredentialsPath?: string;
    /** 派生密钥用的主目录(默认当前用户主目录;凭证换机后拷来才会不同)。 */
    home?: string;
    /** 派生密钥用的用户名。 */
    user?: string;
    /** 日志出口。 */
    log?: (message: string) => void;
}
/** 读凭证库;文件缺失或损坏时返回空表(官方同样按"未登录"处理)。 */
export declare function readCredentialStore(credentialsPath: string): Record<string, string>;
/**
 * 解出存储值:明文原样返回,密文按官方算法解密。
 * @param value - 存储里的原始值。
 * @param key - 32 字节派生密钥。
 * @returns 明文;解密失败抛错(调用方决定回落)。
 */
export declare function decryptStoreValue(value: string, key: Buffer): string;
/** 派生凭证库密钥(官方 fallback 种子)。 */
export declare function deriveCredentialKey(home: string, user: string): Buffer;
/**
 * 读单个凭证键并解密(官方 `credentialService.load(name)`)。
 *
 * 与 `resolvePlanCredential` 的区别:这里不做任何套餐规则推断,只按名字取值,
 * 供「读 `oauth:active_provider` 做本地资格判定」这类场景使用。
 * @param credentialsPath - `credentials.json` 路径。
 * @param name - 凭证键名。
 * @param options - 可选的 home/user 与日志出口。
 * @returns 明文值;缺失或解密失败返回空串。
 */
export declare function readCredentialValue(credentialsPath: string, name: string, options?: {
    home?: string;
    user?: string;
    log?: (message: string) => void;
    fallbackPath?: string;
}): string;
/**
 * 按官方规则解析某个套餐 provider 的模型凭证。
 * @param input - 凭证库路径、provider id、套餐种类与回落值。
 * @returns 凭证与来源;`config` 表示回落到了配置层,`none` 表示都拿不到。
 */
export declare function resolvePlanCredential(input: ResolvePlanCredentialInput): ResolvedCredential;
