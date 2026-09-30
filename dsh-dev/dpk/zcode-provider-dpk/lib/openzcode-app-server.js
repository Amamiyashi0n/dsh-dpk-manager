import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';
// The app-server follows the host's normal Node runtime.  A persisted
// profile may still provide an explicit executable, but the plugin itself
// must not silently select a removed MSYS2 toolchain.
const DEFAULT_NODE_PATH = process.env.DSH_NODE_PATH?.trim() || 'node';
const DEFAULT_CLI_PATH = process.env.DSH_ZCODE_CLI_PATH?.trim() || '';
const DEFAULT_STORAGE_DIR = process.env.ZCODE_STORAGE_DIR?.trim() || '';
const DEFAULT_BUILTIN_CONFIG = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || '';
const DEFAULT_APP_SERVER_MAX_OUTPUT_TOKENS = 32000;
/** Hard cap for one delegated Start-Plan agent turn (the engine runs its own loop). */
const SESSION_TURN_TIMEOUT_MS = 15 * 60 * 1000;
/** Poll cadence for delegated session turns (progress granularity). */
const SESSION_POLL_MS = 900;
/** Hard cap for one buffered workspace/generateText model request. */
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;
/** Recent-history budget for the delegated session prompt (chars). */
const SESSION_PROMPT_BUDGET = 60_000;
function dataBaseDirFromStorageDir(storageDir) {
    const value = storageDir?.trim();
    if (!value)
        return undefined;
    const normalized = value.replace(/[\\/]+$/, '');
    const parts = normalized.split(/[\\/]/);
    if (parts.at(-1)?.toLowerCase() === 'v2' && parts.at(-2)?.toLowerCase() === '.zcode') {
        return parts.slice(0, -2).join(normalized.includes('\\') ? '\\' : '/') || (normalized.includes('\\') ? '\\' : '/');
    }
    return value;
}
function builtinRevision(path) {
    if (!path)
        return 'openzcode-builtin-unknown';
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const revision = parsed.revision;
        if (typeof revision !== 'string' && typeof revision !== 'number') {
            return 'openzcode-builtin-unknown';
        }
        // NodeProviderRegistryRuntime scopes the release revision to the active
        // config path. Account overlays are rejected until this exact revision
        // matches the Config source snapshot.
        const sourceKey = createHash('sha256').update(resolve(path)).digest('hex');
        return `zcode-builtin:${revision}:${sourceKey}`;
    }
    catch {
        return 'openzcode-builtin-unknown';
    }
}
function appServerProviderId(route) {
    const family = route.family?.trim() || 'provider';
    const mode = route.access?.mode?.trim() || 'route';
    return `dsh-zcode-${family}-${mode}`.replace(/[^A-Za-z0-9._:-]+/g, '-');
}
function appServerMaxOutputTokens(options, route) {
    const configured = options.maxTokens
        ?? route.models?.find((model) => model.id === options.model)?.maxTokens
        ?? DEFAULT_APP_SERVER_MAX_OUTPUT_TOKENS;
    // The bundled ZCode model catalog currently exposes a 32K normal-request
    // ceiling for GLM models; keep the white-box request inside that range.
    return Math.min(configured, DEFAULT_APP_SERVER_MAX_OUTPUT_TOKENS);
}
function materializePersonalProviderConfig(route, providerId) {
    if (!route.baseURL?.trim() || !route.apiKey?.trim() || !route.models?.length)
        return undefined;
    const providerModels = route.models.map((model) => ({
        providerId,
        modelId: model.id,
        config: {
            properties: { contextWindow: model.contextWindow ?? 200000 },
            optionSpecs: {
                maxOutputTokens: { max: model.maxTokens ?? 32000 },
                ...(model.efforts?.length ? { reasoningLevel: { values: [...model.efforts] } } : {}),
            },
        },
    }));
    const catalog = {
        schemaVersion: 1,
        config: {
            providerConfigRules: {
                providerRules: [{
                        providerId,
                        providerName: route.display?.trim() || 'ZCode Provider',
                        enabled: true,
                        config: {
                            group: 'standard-personal',
                            access: { type: 'api-key', apiKey: route.apiKey.trim() },
                            api: {
                                type: route.kind === 'openai' || route.kind === 'openai-compatible'
                                    ? 'openai-chat-completions'
                                    : 'anthropic-messages',
                                baseUrl: route.baseURL.trim(),
                            },
                            personalModelIds: route.models.map((model) => model.id),
                            modelOrder: route.models.map((model) => model.id),
                        },
                    }],
            },
            modelConfigRules: {
                providerModelRules: providerModels,
                manualProviderModelRules: [],
            },
        },
    };
    const directory = mkdtempSync(join(tmpdir(), 'openzcode-app-server-'));
    const file = join(directory, 'provider_config.json');
    writeFileSync(file, JSON.stringify(catalog), 'utf8');
    return file;
}
function textOf(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .filter((block) => (typeof block === 'object' && block !== null && block.type === 'text'))
        .map((block) => String(block.text ?? ''))
        .filter(Boolean)
        .join('\n');
}
function imagePlaceholder(content) {
    if (!Array.isArray(content))
        return '';
    const count = content.filter((block) => (typeof block === 'object' && block !== null && block.type === 'image')).length;
    return count > 0 ? `[${count} image${count === 1 ? '' : 's'} attached]` : '';
}
function messageText(content) {
    return [textOf(content), imagePlaceholder(content)].filter(Boolean).join('\n');
}
/**
 * Flatten the DSH conversation into the single task string a delegated engine
 * agent turn consumes. The engine applies its own official system prompt and
 * tools; this transcript only carries the recent task context — older history
 * beyond SESSION_PROMPT_BUDGET is omitted so huge sessions do not turn into a
 * multi-minute silent engine turn.
 */
function sessionPromptFrom(options) {
    const rendered = [];
    let budget = SESSION_PROMPT_BUDGET;
    for (let i = (options.messages ?? []).length - 1; i >= 0; i -= 1) {
        const message = options.messages[i];
        const text = messageText(message.content).trim();
        if (!text)
            continue;
        if (text.length > budget)
            break;
        budget -= text.length;
        const role = message.role === 'assistant' ? '助手'
            : message.role === 'system' ? '约定'
                : '用户';
        rendered.push(`[${role}]\n${text}`);
    }
    if (rendered.length === 0)
        return '请继续。';
    rendered.reverse();
    if (budget <= 0 || rendered.length < (options.messages ?? []).length) {
        rendered.unshift('[更早的会话历史已省略]');
    }
    return rendered.join('\n\n');
}
function waitForProviderRegistry(delayMs, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(signal?.reason ?? new LlmError('app-server request aborted', 'ABORTED'));
        };
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => {
            cleanup();
            resolve();
        }, delayMs);
    });
}
function isProviderRegistryNotReady(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Provider Registry 中不存在 Provider:');
}
export function toWorkspaceMessages(options) {
    const messages = [];
    // DSH tool-result messages carry the call id, while the app-server schema
    // also requires the tool name. Recover it from the preceding assistant call
    // so replayed sessions remain valid after crossing the transport boundary.
    const toolNames = new Map();
    for (const message of options.messages) {
        if (message.role !== 'assistant' || !Array.isArray(message.content))
            continue;
        for (const value of message.content) {
            if (typeof value !== 'object' || value === null)
                continue;
            const block = value;
            if (block.type !== 'tool-call')
                continue;
            const id = String(block.id ?? '').trim();
            const name = String(block.name ?? '').trim();
            if (id && name)
                toolNames.set(id, name);
        }
    }
    for (const message of options.messages) {
        const role = message.role;
        const content = message.content;
        if (role === 'system')
            continue;
        if (role === 'user') {
            const text = messageText(content);
            if (text)
                messages.push({ role: 'user', content: text });
            continue;
        }
        if (role === 'assistant') {
            const toolCalls = [];
            for (const block of content ?? []) {
                if (typeof block !== 'object' || block === null)
                    continue;
                const item = block;
                if (item.type !== 'tool-call')
                    continue;
                let input = {};
                try {
                    input = JSON.parse(String(item.arguments ?? '{}'));
                }
                catch {
                    input = {};
                }
                const id = String(item.id ?? '').trim();
                const name = String(item.name ?? '').trim();
                if (id && name)
                    toolCalls.push({ id, name, input });
            }
            const text = messageText(content);
            if (text || toolCalls.length > 0)
                messages.push({
                    role: 'assistant',
                    content: text,
                    ...(toolCalls.length > 0 ? { toolCalls } : {}),
                });
            continue;
        }
        if (role === 'tool') {
            const text = messageText(content);
            const toolCallId = String(message.toolCallId ?? '').trim();
            if (text || toolCallId)
                messages.push({
                    role: 'tool',
                    content: text,
                    toolCallId,
                    toolName: String(message.toolName ?? '').trim() || toolNames.get(toolCallId) || 'tool',
                    ...(message.isError === true ? { isError: true } : {}),
                });
        }
    }
    return messages;
}
function toWorkspaceTools(options) {
    if (!options.tools?.length)
        return undefined;
    return options.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.parameters,
    }));
}
function finishReason(value, toolCalls) {
    const reason = String(value ?? '').toLowerCase();
    if (toolCalls.length > 0 || reason.includes('tool'))
        return { kind: 'tool-calls' };
    if (reason.includes('max') || reason.includes('length'))
        return { kind: 'max-tokens' };
    return { kind: 'stop' };
}
function usageChunk(usage) {
    if (!usage)
        return undefined;
    const read = (key) => {
        const value = usage[key];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const inputTokens = read('inputTokens') ?? read('input_tokens');
    const outputTokens = read('outputTokens') ?? read('output_tokens');
    const totalTokens = read('totalTokens') ?? read('total_tokens');
    const cacheReadTokens = read('cacheReadTokens') ?? read('cache_read_input_tokens');
    const cacheWriteTokens = read('cacheWriteTokens') ?? read('cache_creation_input_tokens');
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
        && cacheReadTokens === undefined && cacheWriteTokens === undefined)
        return undefined;
    return {
        type: 'usage',
        usage: {
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            ...(totalTokens === undefined ? {} : { totalTokens }),
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        },
    };
}
export function appServerResultToStreamChunks(result) {
    const chunks = [];
    const text = typeof result.text === 'string' ? result.text : '';
    let index = 0;
    if (text) {
        chunks.push({ type: 'block-start', index, blockType: 'text' });
        chunks.push({ type: 'text-delta', index, text });
        chunks.push({ type: 'block-end', index, block: { type: 'text', text } });
        index += 1;
    }
    const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    for (const call of toolCalls) {
        const id = String(call?.id ?? '');
        const name = String(call?.name ?? '');
        let args = '{}';
        try {
            args = JSON.stringify(call?.input ?? {});
        }
        catch {
            args = '{}';
        }
        chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
        chunks.push({ type: 'tool-call-delta', index, id: id, name, argumentsDelta: args });
        chunks.push({
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: id, name, arguments: args },
        });
        index += 1;
    }
    const usage = usageChunk(result.usage);
    if (usage)
        chunks.push(usage);
    chunks.push({ type: 'finish', reason: finishReason(result.finishReason, toolCalls) });
    return chunks;
}
/** A long-lived NDJSON client for the white-box openzcode-app-server boundary. */
export class OpenZCodeAppServerTransport {
    config;
    log;
    child;
    startPromise;
    pending = new Map();
    buffer = '';
    sequence = 0;
    disposed = false;
    generatedProviderConfigPath;
    generatedProviderId;
    currentRoute;
    currentProviderId;
    accountConfigRevision;
    constructor(config, log = () => { }) {
        this.config = config;
        this.log = log;
    }
    async *generate(options, route, workspacePath) {
        const resolvedWorkspacePath = workspacePath?.trim() || this.workspacePath(options);
        const providerId = this.providerId(route);
        this.currentRoute = route;
        this.currentProviderId = providerId;
        await this.ensureAccountProviderConfig(providerId, route, options.signal);
        // Start Plan is risk-controlled to agent main turns (x-zcode-session-type
        // "main"); bare workspace/generateText is classified as a utility call and
        // rejected with "unusual activity". Route it through a real engine session
        // instead, where the official agent context is applied by the engine.
        if (route.access?.mode === 'start-plan') {
            yield* this.generateViaSession(options, providerId, resolvedWorkspacePath);
            return;
        }
        const operationId = `dsh-${randomUUID()}`;
        const messages = toWorkspaceMessages(options);
        const prompt = messages.length > 0 ? undefined : messageText(options.messages.at(-1)?.content);
        if (!prompt && messages.length === 0)
            throw new LlmError('app-server request has no user message', 'INVALID_REQUEST');
        const params = {
            workspace: { workspacePath: resolvedWorkspacePath, workspaceKey: resolvedWorkspacePath },
            selection: {
                providerId,
                modelId: options.model,
                options: { reasoningLevel: String(options.reasoningEffort ?? 'max') },
            },
            ...(prompt ? { prompt } : { messages }),
            ...(toWorkspaceTools(options) ? { tools: toWorkspaceTools(options) } : {}),
            querySource: 'openzcode-app-server',
            maxOutputTokens: appServerMaxOutputTokens(options, route),
            operationId,
        };
        let response;
        // workspace/generateText buffers the whole model response; a black-holed
        // upstream would otherwise hang the DSH turn forever. Hard cap the wait
        // (large contexts legitimately take minutes; ten is the ceiling).
        const timeoutSignal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(GENERATE_TIMEOUT_MS)]);
        for (let attempt = 0;; attempt += 1) {
            try {
                response = await this.request('workspace/generateText', params, operationId, timeoutSignal);
                break;
            }
            catch (error) {
                if (error?.name === 'TimeoutError') {
                    throw new LlmError(`app-server generateText timed out after ${GENERATE_TIMEOUT_MS / 1000}s`, 'SERVER');
                }
                // The official CLI acknowledges provider/updateAccountConfig before a
                // registry rebuild can be observed by the next request. Retry only that
                // deterministic race; all model/provider errors still surface unchanged.
                if (!isProviderRegistryNotReady(error) || attempt >= 4)
                    throw error;
                const delayMs = Math.min(1000, 150 * (2 ** attempt));
                this.log(`openzcode-app-server waiting for Provider Registry refresh (${delayMs}ms)`);
                await waitForProviderRegistry(delayMs, options.signal);
            }
        }
        yield* appServerResultToStreamChunks(response);
    }
    dispose() {
        this.disposed = true;
        for (const [id, pending] of this.pending) {
            pending.cleanup?.();
            pending.reject(new LlmError('openzcode-app-server transport disposed', 'SERVER'));
            this.pending.delete(id);
        }
        this.child?.kill();
        this.child = undefined;
        this.startPromise = undefined;
        this.currentRoute = undefined;
        this.currentProviderId = undefined;
        this.accountConfigRevision = undefined;
        if (this.generatedProviderConfigPath) {
            try {
                rmSync(dirname(this.generatedProviderConfigPath), { recursive: true, force: true });
            }
            catch { /* best effort */ }
            this.generatedProviderConfigPath = undefined;
        }
    }
    /**
     * Start-Plan turn delegation: run the request through a real engine agent
     * session (create → setModel → send → collect → close). The engine applies
     * its own official system prompt and tool set; assistant text is polled and
     * re-emitted incrementally so DSH sees progress while the turn runs.
     * Transient concurrency rejections (429/3008) surface as SERVER errors.
     */
    async *generateViaSession(options, providerId, workspacePath) {
        const workspace = { workspacePath, workspaceKey: workspacePath };
        const created = await this.request('session/create', { workspace }, undefined, options.signal);
        const sessionId = created?.session?.sessionId?.trim();
        if (!sessionId)
            throw new LlmError('app-server session/create returned no sessionId', 'SERVER');
        try {
            await this.request('session/setModel', {
                sessionId,
                model: {
                    providerId,
                    modelId: options.model,
                    options: { reasoningLevel: String(options.reasoningEffort ?? 'max') },
                },
            }, undefined, options.signal);
            const accepted = await this.request('session/send', {
                sessionId,
                content: sessionPromptFrom(options),
            }, undefined, options.signal);
            if (accepted?.accepted !== true) {
                throw new LlmError('app-server session/send was not accepted', 'SERVER');
            }
            const deadline = Date.now() + SESSION_TURN_TIMEOUT_MS;
            let emitted = 0;
            let blockOpen = false;
            for (;;) {
                options.signal?.throwIfAborted();
                if (Date.now() > deadline) {
                    throw new LlmError('app-server session turn timed out', 'SERVER');
                }
                await waitForProviderRegistry(SESSION_POLL_MS, options.signal);
                const snapshot = await this.sessionProgress(sessionId, options.signal);
                if (snapshot.text.length > emitted) {
                    if (!blockOpen) {
                        blockOpen = true;
                        yield { type: 'block-start', index: 0, blockType: 'text' };
                    }
                    yield { type: 'text-delta', index: 0, text: snapshot.text.slice(emitted) };
                    emitted = snapshot.text.length;
                }
                if (snapshot.done) {
                    if (blockOpen) {
                        yield { type: 'block-end', index: 0, block: { type: 'text', text: snapshot.text } };
                    }
                    const usage = usageChunk(snapshot.usage);
                    if (usage)
                        yield usage;
                    yield { type: 'finish', reason: { kind: 'stop' } };
                    return;
                }
            }
        }
        finally {
            void this.request('session/close', { sessionId }).catch(() => { });
        }
    }
    /** One poll: accumulated assistant text so far, usage on completion. */
    async sessionProgress(sessionId, signal) {
        const response = await this.request('session/messages', { sessionId, limit: 80 }, undefined, signal);
        const messages = Array.isArray(response?.messages) ? response.messages : [];
        let text = '';
        for (let i = 0; i < messages.length; i += 1) {
            const entry = messages[i];
            const info = entry.info;
            if (!info || info.role !== 'assistant')
                continue;
            const kind = info.semantics?.kind;
            if (typeof kind === 'string' && kind !== 'assistant_response')
                continue;
            const error = info.error;
            if (error && info.finish === undefined) {
                const providerCode = error.data?.providerErrorCode ? ` (provider ${String(error.data.providerErrorCode)})` : '';
                throw new LlmError(`app-server session turn failed: ${String(error.message ?? 'unknown error')}${providerCode}`, 'SERVER');
            }
            if (info.finish === undefined)
                continue;
            for (const part of entry.parts ?? []) {
                if (part.type === 'text' && part.text)
                    text += part.text;
            }
            // Terminal marker: the engine sets info.finish once the assistant
            // response completes (info.time.completed carries the timestamp).
            if (i === messages.length - 1) {
                const tokens = (info.tokens ?? {});
                const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
                const cache = tokens.cache;
                return {
                    text,
                    done: true,
                    usage: {
                        inputTokens: num(tokens.input),
                        outputTokens: num(tokens.output),
                        reasoningTokens: num(tokens.reasoning),
                        cacheReadTokens: num(cache?.read),
                        cacheWriteTokens: num(cache?.write),
                    },
                };
            }
        }
        return { text, done: false };
    }
    providerId(route) {
        const family = route.family?.trim();
        const mode = route.access?.mode?.trim();
        if (family && mode) {
            const officialMode = mode === 'off-peak' ? 'offpeak-idle-plan' : mode;
            return `account:${family}-${officialMode}`;
        }
        if (this.generatedProviderId === undefined && route.baseURL && route.apiKey && route.models?.length) {
            this.generatedProviderId = appServerProviderId(route);
            this.generatedProviderConfigPath = materializePersonalProviderConfig(route, this.generatedProviderId);
        }
        if (this.generatedProviderId !== undefined)
            return this.generatedProviderId;
        if (route.family && route.access?.mode)
            return `account:${route.family}-${route.access.mode}`;
        throw new LlmError('openzcode-app-server requires an account provider route', 'UNSUPPORTED_MODEL');
    }
    workspacePath(options) {
        const value = options.workspacePath;
        if (typeof value === 'string' && value.trim())
            return value;
        return this.config.cwd?.trim() || process.cwd();
    }
    async ensureStarted() {
        if (this.disposed)
            throw new LlmError('openzcode-app-server transport is disposed', 'SERVER');
        if (this.child && !this.child.killed)
            return;
        if (this.startPromise)
            return await this.startPromise;
        const nodePath = this.config.nodePath?.trim() || DEFAULT_NODE_PATH;
        const cliPath = this.config.cliPath?.trim() || DEFAULT_CLI_PATH;
        if (!cliPath)
            throw new LlmError('app-server cliPath is not configured', 'CONFIGURATION');
        if (nodePath !== 'node' && !existsSync(nodePath)) {
            throw new LlmError(`app-server nodePath does not exist: ${nodePath}`, 'CONFIGURATION');
        }
        if (!existsSync(cliPath))
            throw new LlmError(`app-server cliPath does not exist: ${cliPath}`, 'CONFIGURATION');
        this.startPromise = new Promise((resolve, reject) => {
            const env = {
                ...process.env,
                ...(this.config.storageDir?.trim() ? { ZCODE_STORAGE_DIR: this.config.storageDir.trim() } : {}),
                ...(dataBaseDirFromStorageDir(this.config.storageDir) ? {
                    ZCODE_DATA_BASE_DIR: dataBaseDirFromStorageDir(this.config.storageDir),
                } : {}),
                ...(this.config.builtinProviderConfigPath?.trim()
                    ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: this.config.builtinProviderConfigPath.trim() }
                    : {}),
            };
            // Older persisted profiles may predate personalProviderConfigPath. The
            // standalone CLI still needs the paired Personal catalog to merge the
            // account overlay into Provider Registry, so derive the official path
            // from storageDir when the profile omitted the newer field. Generated
            // route catalogs take precedence because they are transport-owned.
            const personalProviderConfigPath = this.config.personalProviderConfigPath?.trim()
                || this.generatedProviderConfigPath
                || (this.config.storageDir?.trim() ? join(this.config.storageDir.trim(), 'provider_config.json') : '');
            if (personalProviderConfigPath) {
                env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalProviderConfigPath;
            }
            const toolchainBin = dirname(nodePath);
            const toolchainRoot = toolchainBin.replace(/[\\/]\w+64[\\/]bin$/i, '');
            const pathParts = [
                toolchainBin,
                join(toolchainRoot, 'mingw64', 'bin'),
                join(toolchainRoot, 'usr', 'bin'),
                env.PATH,
            ].filter((value) => typeof value === 'string' && value.length > 0);
            env.PATH = pathParts.join(process.platform === 'win32' ? ';' : ':');
            const child = spawn(nodePath, [cliPath, 'app-server', '--stdio'], {
                cwd: this.config.cwd?.trim() || process.cwd(),
                env,
                stdio: 'pipe',
                windowsHide: true,
            });
            this.child = child;
            let settled = false;
            const settleStart = (error) => {
                if (settled)
                    return;
                settled = true;
                if (error)
                    reject(error);
                else
                    resolve();
            };
            child.once('spawn', () => {
                this.log(`openzcode-app-server started pid=${child.pid ?? 'unknown'}`);
                settleStart();
            });
            child.once('error', (error) => {
                this.child = undefined;
                settleStart(new LlmError(`openzcode-app-server failed to start: ${error.message}`, 'SERVER'));
            });
            child.once('close', (code, signal) => {
                this.child = undefined;
                this.startPromise = undefined;
                const failure = new LlmError(`openzcode-app-server exited (${code ?? 'null'}${signal ? `/${signal}` : ''})`, 'SERVER');
                for (const [id, pending] of this.pending) {
                    pending.cleanup?.();
                    pending.reject(failure);
                    this.pending.delete(id);
                }
                settleStart(new LlmError(failure.message, 'SERVER'));
            });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => this.onStdout(chunk));
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                const line = String(chunk).trim();
                if (line)
                    this.log(`openzcode-app-server stderr: ${line}`);
            });
        });
        try {
            await this.startPromise;
        }
        catch (error) {
            this.startPromise = undefined;
            throw error;
        }
    }
    onStdout(chunk) {
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline).replace(/\r$/, '').trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line)
                this.onLine(line);
            newline = this.buffer.indexOf('\n');
        }
    }
    onLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            this.log(`openzcode-app-server ignored non-NDJSON output: ${line.slice(0, 240)}`);
            return;
        }
        if (!('id' in message)) {
            if (typeof message.method === 'string' && message.method !== 'startup/storageState') {
                this.log(`openzcode-app-server notification ${message.method}`);
            }
            return;
        }
        if (typeof message.method === 'string') {
            void this.handleServerRequest(message);
            return;
        }
        const id = message.id;
        const pending = this.pending.get(id);
        if (!pending)
            return;
        this.pending.delete(id);
        pending.cleanup?.();
        if (message.error && typeof message.error === 'object') {
            const error = message.error;
            pending.reject(new LlmError(String(error.message ?? 'app-server request failed'), 'SERVER'));
        }
        else {
            pending.resolve(message.result);
        }
    }
    async handleServerRequest(message) {
        const id = message.id;
        const method = String(message.method ?? '');
        if (method === 'interaction/requestProviderRuntimeHeaders') {
            const params = typeof message.params === 'object' && message.params !== null
                ? message.params
                : {};
            const selection = typeof params.modelSelection === 'object' && params.modelSelection !== null
                ? params.modelSelection
                : {};
            const providerId = String(params.providerId ?? selection.providerId ?? '').trim();
            const route = this.currentRoute;
            const activeProviderId = this.currentProviderId;
            const apiKey = route?.apiKey?.trim() ?? '';
            const matches = providerId === activeProviderId
                || (route !== undefined && providerId === this.providerId(route));
            const result = matches && apiKey
                ? { headersApplied: true, requestAuth: { apiKey } }
                : {
                    headersApplied: false,
                    errorMessage: `openzcode-app-server has no credentials for provider ${providerId || 'unknown'}`,
                };
            this.writeResponse({ id, result });
            return;
        }
        if (method === 'session/requestRuntimePreferences') {
            // Minimal host preferences; the engine asks per session create with a
            // 15s zod-validated timeout and fails session/create when unanswered.
            this.writeResponse({
                id,
                result: {
                    nativeSearchEnhancementsEnabled: true,
                    memoryEnabled: false,
                    askUserQuestionAutoResolutionEnabled: true,
                },
            });
            return;
        }
        if (method === 'interaction/requestPermission') {
            // Session mode runs the official engine's own agent in this workspace;
            // its tool executions are approved here because DSH's approval gates do
            // not reach inside the engine session.
            const toolName = String(message.params?.toolName ?? 'unknown');
            this.log(`openzcode-app-server allowing engine permission request (${toolName})`);
            this.writeResponse({ id, result: { decision: 'allow' } });
            return;
        }
        if (method === 'interaction/requestOfficialMcpAuthHeaders') {
            this.writeResponse({ id, result: {} });
            return;
        }
        this.writeResponse({ id, error: { code: -32601, message: `unsupported app-server request: ${method}` } });
    }
    writeResponse(value) {
        const child = this.child;
        if (!child?.stdin.writable)
            return;
        try {
            child.stdin.write(`${JSON.stringify(value)}\n`);
        }
        catch { /* child shutdown is handled by close */ }
    }
    async ensureAccountProviderConfig(providerId, route, signal) {
        const family = route.family?.trim();
        const mode = route.access?.mode?.trim();
        if (!family || !mode || !providerId.startsWith('account:'))
            return;
        const accountType = route.access?.accountType?.trim() || family;
        if (accountType !== 'zai' && accountType !== 'bigmodel')
            return;
        const officialMode = (mode === 'off-peak' ? 'off-peak' : mode);
        if (!['start-plan', 'individual-coding-plan', 'team-coding-plan', 'off-peak'].includes(officialMode))
            return;
        const apiKey = route.apiKey?.trim() ?? '';
        const builtinConfigRevision = builtinRevision(this.config.builtinProviderConfigPath);
        const models = (route.models ?? []).map((model) => model.id).filter(Boolean);
        const entitled = apiKey !== '';
        const states = {
            [providerId]: {
                availability: entitled ? 'available' : 'unavailable',
                entitled,
                current: entitled,
            },
        };
        // Keep the revision byte-for-byte compatible with the official
        // ProviderConfigMap.toJSON() shape. accountType/mode are builtin catalog
        // facts and are intentionally not included in the account overlay.
        const providersRevision = [{
                providerId,
                config: {
                    access: { type: 'zhipu-account', entitled },
                    builtinModelIds: models,
                },
            }];
        const revision = `account:${JSON.stringify([
            builtinConfigRevision,
            providersRevision,
            states,
        ])}`;
        if (this.accountConfigRevision === revision)
            return;
        const snapshot = {
            revision,
            basedOnZCodeBuiltinRevision: builtinConfigRevision,
            providers: {
                [providerId]: {
                    builtinModelIds: models,
                    access: {
                        type: 'zhipu-account',
                        entitled,
                    },
                },
            },
            states,
        };
        const response = await this.request('provider/updateAccountConfig', snapshot, undefined, signal);
        this.log(`openzcode-app-server account config response: ${JSON.stringify(response)}`);
        this.accountConfigRevision = revision;
    }
    async request(method, params, operationId, signal) {
        await this.ensureStarted();
        signal?.throwIfAborted();
        const id = ++this.sequence;
        const child = this.child;
        if (!child?.stdin.writable)
            throw new LlmError('app-server stdin is closed', 'STREAM_CLOSED');
        const request = JSON.stringify({ id, method, params });
        return await new Promise((resolve, reject) => {
            const onAbort = () => {
                this.pending.delete(id);
                cleanup();
                if (operationId) {
                    void this.request('workspace/cancelGenerateText', { operationId }).catch(() => { });
                }
                reject(signal?.reason ?? new LlmError('app-server request aborted', 'ABORTED'));
            };
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            this.pending.set(id, { resolve, reject, signal, operationId, onAbort, cleanup });
            signal?.addEventListener('abort', onAbort, { once: true });
            try {
                child.stdin.write(`${request}\n`);
            }
            catch (error) {
                this.pending.delete(id);
                cleanup();
                reject(new LlmError(`app-server stdin write failed: ${String(error)}`, 'STREAM_CLOSED'));
            }
        });
    }
}
export function defaultAppServerPaths() {
    const repo = process.env.DSH_ZCODE_REPO?.trim() || '';
    const zcodeRoot = repo ? join(repo, 're-zcode', 'zcode-unpacked', 'resources') : '';
    const storageDir = process.env.ZCODE_STORAGE_DIR?.trim() || join(homedir(), '.zcode', 'v2');
    return {
        nodePath: process.env.DSH_NODE_PATH?.trim() || 'node',
        cliPath: process.env.DSH_ZCODE_CLI_PATH?.trim() || (zcodeRoot ? join(zcodeRoot, 'glm', 'zcode.cjs') : ''),
        storageDir,
        builtinProviderConfigPath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim()
            || (zcodeRoot ? join(zcodeRoot, 'config', 'provider', 'zcode-builtin.json') : ''),
        personalProviderConfigPath: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
            || join(storageDir, 'provider_config.json'),
    };
}
