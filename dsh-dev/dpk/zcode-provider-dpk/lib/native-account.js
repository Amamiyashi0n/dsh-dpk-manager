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
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverZcodeInstall } from './app-server-discovery.js';
import { readCredentialStore, resolvePlanCredential } from './credentials.js';
/** 内置目录里会被采纳的账号规则:`account:<family>-<plan>`。 */
const ACCOUNT_RULE = /^account:(bigmodel|zai)-(individual-coding-plan|team-coding-plan|start-plan)$/;
/** 官方存储目录(与官方 credential service 一致:环境覆写 > `~/.zcode/v2`)。 */
export function nativeStorageDir() {
    const explicit = process.env.ZCODE_STORAGE_DIR?.trim();
    if (explicit)
        return explicit;
    const dataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim();
    if (dataBaseDir)
        return join(dataBaseDir, '.zcode', 'v2');
    return join(homedir(), '.zcode', 'v2');
}
/** 官方凭证库路径。 */
export function nativeCredentialPath() {
    return join(nativeStorageDir(), 'credentials.json');
}
/** 官方 ZCode 设备状态路径。 */
export function nativeTelemetryStatePath() {
    return join(nativeStorageDir(), 'telemetry-state.json');
}
/**
 * 已发现安装自带的内置目录路径。优先使用显式路径和开发仓库路径，
 * 再走安装发现；这些路径必须与官方 app-server 使用同一份目录。
 */
export function discoveredBuiltinCatalogPath() {
    const explicit = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
    if (explicit)
        return explicit;
    const cliPath = process.env.DSH_ZCODE_CLI_PATH?.trim();
    if (cliPath)
        return join(dirname(dirname(cliPath)), 'config', 'provider', 'zcode-builtin.json');
    const repo = process.env.DSH_ZCODE_REPO?.trim();
    if (repo)
        return join(repo, 're-zcode', 'zcode-unpacked', 'resources', 'config', 'provider', 'zcode-builtin.json');
    return discoverZcodeInstall()?.builtinProviderConfigPath;
}
/** 官方目录不可用时的稳定端点兜底；仍由凭证门控，不会注册死路由。 */
const FALLBACK_ENDPOINTS = [
    { key: 'builtin:bigmodel-coding-plan', family: 'bigmodel', modes: ['individual-coding-plan', 'team-coding-plan'], baseURL: 'https://open.bigmodel.cn/api/anthropic' },
    { key: 'builtin:bigmodel-start-plan', family: 'bigmodel', modes: ['start-plan'], baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
    { key: 'builtin:zai-coding-plan', family: 'zai', modes: ['individual-coding-plan', 'team-coding-plan'], baseURL: 'https://api.z.ai/api/anthropic' },
    { key: 'builtin:zai-start-plan', family: 'zai', modes: ['start-plan'], baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
];
/** 从内置目录 JSON 提取账号端点;individual/team 合并为同一条 coding-plan 路由。 */
export function accountEndpointsFromCatalog(catalog) {
    const rules = catalog?.config?.providerConfigRules?.providerRules;
    if (!Array.isArray(rules))
        return [];
    const endpoints = new Map();
    for (const rule of rules) {
        const providerId = rule?.providerId;
        if (typeof providerId !== 'string')
            continue;
        const matched = ACCOUNT_RULE.exec(providerId);
        if (matched === null)
            continue;
        const config = rule?.config;
        if (config?.access?.type !== 'zhipu-account')
            continue;
        const rawBase = config?.api?.baseUrl;
        if (typeof rawBase !== 'string')
            continue;
        const baseURL = rawBase.trim().replace(/\/+$/, '');
        if (baseURL === '')
            continue;
        const family = matched[1];
        const mode = matched[2];
        const key = mode === 'start-plan' ? `builtin:${family}-start-plan` : `builtin:${family}-coding-plan`;
        const existing = endpoints.get(key);
        if (existing === undefined) {
            endpoints.set(key, { key, family, modes: [mode], baseURL });
        }
        else if (!existing.modes.includes(mode)) {
            existing.modes.push(mode);
        }
    }
    return [...endpoints.values()];
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
export function modelConfigFromCatalog(catalog, modelId) {
    const rules = catalog?.config?.modelConfigRules?.modelRules;
    const result = {};
    if (!Array.isArray(rules))
        return result;
    for (const rule of rules) {
        if (typeof rule?.modelMatch !== 'string')
            continue;
        let pattern;
        try {
            pattern = new RegExp(rule.modelMatch, 'iu');
        }
        catch {
            continue;
        }
        if (!pattern.test(modelId))
            continue;
        const properties = rule.config?.properties;
        if (typeof properties?.contextWindow === 'number')
            result.contextWindow = properties.contextWindow;
        if (typeof properties?.inputFormat?.supportsImage === 'boolean') {
            result.supportsImage = properties.inputFormat.supportsImage;
        }
        if (typeof properties?.inputFormat?.supportsPdf === 'boolean') {
            result.supportsPdf = properties.inputFormat.supportsPdf;
        }
        const maxOutput = rule.config?.optionSpecs?.maxOutputTokens?.max;
        if (typeof maxOutput === 'number')
            result.maxOutputTokens = maxOutput;
    }
    return result;
}
/**
 * 从本机官方 ZCode 登录态推导账号条目;目录缺失/损坏或套餐未登录时不产出该条。
 * @param options - 路径注入(测试隔离用)与日志出口。
 */
export function nativeAccountProviders(options = {}) {
    const builtinPath = options.builtinPath?.trim() || discoveredBuiltinCatalogPath();
    let catalog;
    let catalogEndpoints = [];
    if (builtinPath === undefined || builtinPath === '') {
        options.log?.('zcode-provider: 未定位到官方 zcode-builtin.json,使用内置端点候选');
    }
    else {
        options.log?.(`zcode-provider: 尝试读取官方内置目录(${builtinPath})`);
        try {
            catalog = JSON.parse(readFileSync(builtinPath, 'utf8'));
            catalogEndpoints = accountEndpointsFromCatalog(catalog);
            options.log?.(`zcode-provider: 官方内置目录可读,识别账号端点 ${catalogEndpoints.length} 个`);
        }
        catch (error) {
            options.log?.(`zcode-provider: 官方内置目录不可读(${builtinPath}),原因=${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const endpoints = catalogEndpoints.length > 0 ? catalogEndpoints : FALLBACK_ENDPOINTS;
    if (catalogEndpoints.length === 0) {
        options.log?.(`zcode-provider: 使用 ${endpoints.length} 个官方端点候选,逐项执行凭证门控`);
    }
    const credentialsPath = options.credentialsPath?.trim() || nativeCredentialPath();
    const credentialStore = readCredentialStore(credentialsPath);
    let credentialFileState = `存在=${existsSync(credentialsPath)},可读键数=${Object.keys(credentialStore).length}`;
    if (existsSync(credentialsPath)) {
        try {
            JSON.parse(readFileSync(credentialsPath, 'utf8'));
        }
        catch (error) {
            credentialFileState += `,JSON=非法(${error instanceof Error ? error.message : String(error)})`;
        }
    }
    options.log?.(`zcode-provider: 官方凭证库路径=${credentialsPath},${credentialFileState}`);
    const entries = {};
    for (const endpoint of endpoints) {
        const resolved = endpoint.modes
            .map((mode) => resolvePlanCredential({
            credentialsPath,
            providerId: `account:${endpoint.family}-${mode}`,
            family: endpoint.family,
            planKind: mode,
            log: (message) => { options.log?.(message); },
        }))
            .find((credential) => credential.apiKey !== '');
        if (resolved === undefined) {
            options.log?.(`zcode-provider: 端点 ${endpoint.key} 未通过凭证门控`);
            continue;
        }
        entries[endpoint.key] = {
            kind: 'anthropic',
            options: { baseURL: endpoint.baseURL, apiKey: resolved.apiKey },
            ...(catalog === undefined ? {} : { catalog }),
        };
        options.log?.(`zcode-provider: 端点 ${endpoint.key} 已通过凭证门控,credential=${resolved.source}`);
    }
    options.log?.(`zcode-provider: 本机账号路由推导完成,产出 ${Object.keys(entries).length} 条(${Object.keys(entries).join(', ') || 'none'})`);
    return entries;
}
