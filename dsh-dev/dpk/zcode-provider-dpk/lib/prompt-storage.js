/** Persistent system-prompt overrides owned by zcode-provider. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultStorageRoot } from './storage.js';
import { OFFICIAL_SYSTEM_AGENT_PROMPT, OFFICIAL_SYSTEM_IDENTITY, OFFICIAL_SYSTEM_RUNTIME_PROMPT, } from './official-prompt.js';
export function defaultPromptOverridesPath(storageRoot) {
    return join(storageRoot?.trim() || defaultStorageRoot(), 'prompt-overrides.json');
}
function normalize(value) {
    if (value === null || typeof value !== 'object')
        return {};
    const record = value;
    const result = {};
    const defaults = {
        identity: OFFICIAL_SYSTEM_IDENTITY,
        agent: OFFICIAL_SYSTEM_AGENT_PROMPT,
        runtime: OFFICIAL_SYSTEM_RUNTIME_PROMPT,
    };
    for (const placement of ['before', 'after']) {
        const source = record[placement];
        if (source === null || typeof source !== 'object')
            continue;
        const layer = source;
        const normalized = {};
        for (const key of ['identity', 'agent', 'runtime']) {
            const value = layer[key];
            if (typeof value !== 'string' || value === defaults[key])
                continue;
            if (placement === 'after') {
                // 后置 = 覆写:空串/纯空白是「清空该官方块」的显式标记,必须原样保留,
                // 否则用户无法把某个官方块从请求里移除(0 字节注入)。
                normalized[key] = value.trim() === '' ? '' : value;
            }
            else if (value.trim() !== '') {
                normalized[key] = value;
            }
        }
        if (Object.keys(normalized).length > 0) {
            result[placement] = normalized;
        }
    }
    if (result.before !== undefined || result.after !== undefined) {
        result.placement = record.placement === 'after' ? 'after' : 'before';
    }
    return result;
}
export function readPromptOverrides(path) {
    if (!existsSync(path))
        return {};
    try {
        return normalize(JSON.parse(readFileSync(path, 'utf8')));
    }
    catch (_error) {
        return {};
    }
}
export function writePromptOverrides(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(normalize(value), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
export function hasPromptOverrides(value) {
    // 只看**激活层**:placement=before 时,after 层残留的清空标记(空串)不构成
    // 覆写——否则"后置清空后切回前置"会误触引擎委托旁路(实测边缘状态)。
    const normalized = normalize(value);
    const active = normalized[normalized.placement === 'after' ? 'after' : 'before'];
    return active !== undefined && Object.keys(active).length > 0;
}
