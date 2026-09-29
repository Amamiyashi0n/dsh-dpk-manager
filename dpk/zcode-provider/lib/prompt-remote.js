/** Web UI bridge for prompt overrides persisted by zcode-provider itself. */
import { OFFICIAL_SYSTEM_AGENT_PROMPT, OFFICIAL_SYSTEM_IDENTITY, OFFICIAL_SYSTEM_RUNTIME_PROMPT, } from './official-prompt.js';
export const PROMPT_REMOTE_NAMESPACE = 'zcodePrompts';
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
function markRemote(prototype, methodName) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value;
    const marker = Object.freeze({ method: methodName, invocation: Object.freeze({ kind: 'direct' }) });
    Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
        configurable: true,
        value: Object.freeze({
            version: 1,
            methods: Object.freeze([...(descriptor?.methods ?? []), marker]),
        }),
    });
}
export function createPromptRemoteService(ctx, store) {
    const defaults = Object.freeze({
        identity: OFFICIAL_SYSTEM_IDENTITY,
        agent: OFFICIAL_SYSTEM_AGENT_PROMPT,
        runtime: OFFICIAL_SYSTEM_RUNTIME_PROMPT,
    });
    class ZcodePromptRemoteService {
        typertRemote;
        constructor() {
            this.typertRemote = undefined;
        }
        async snapshot(signal) {
            signal?.throwIfAborted();
            const value = store.read();
            signal?.throwIfAborted();
            return { revision: store.revision(), value: { ...value }, defaults };
        }
        async mutate(request, signal) {
            signal?.throwIfAborted();
            if (request?.value === null || typeof request?.value !== 'object') {
                throw new Error('prompt overrides must be an object');
            }
            await store.write(request.value);
            signal?.throwIfAborted();
            return await this.snapshot(signal);
        }
    }
    markRemote(ZcodePromptRemoteService.prototype, 'snapshot');
    markRemote(ZcodePromptRemoteService.prototype, 'mutate');
    const service = new ZcodePromptRemoteService();
    service.typertRemote = Object.freeze({
        service,
        serviceKey: PROMPT_REMOTE_NAMESPACE,
        namespace: PROMPT_REMOTE_NAMESPACE,
    });
    ctx.provide(PROMPT_REMOTE_NAMESPACE, service);
    return service;
}
