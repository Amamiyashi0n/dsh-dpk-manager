/** Web UI bridge for prompt overrides persisted by zcode-provider itself. */
import { type PromptOverrides } from './official-prompt.js';
export declare const PROMPT_REMOTE_NAMESPACE = "zcodePrompts";
export interface PromptOverridesSnapshot {
    revision: number;
    value: PromptOverrides;
    defaults: {
        identity: string;
        agent: string;
        runtime: string;
    };
}
export interface PromptOverridesMutationRequest {
    value: PromptOverrides;
}
interface RemoteContext {
    provide(name: string, value: unknown): unknown;
}
interface PromptStore {
    read(): PromptOverrides;
    write(value: PromptOverrides): void | Promise<void>;
    revision(): number;
}
export interface PromptRemoteService {
    snapshot(signal?: AbortSignal): Promise<PromptOverridesSnapshot>;
    mutate(request: PromptOverridesMutationRequest, signal?: AbortSignal): Promise<PromptOverridesSnapshot>;
    typertRemote: unknown;
}
export declare function createPromptRemoteService(ctx: RemoteContext, store: PromptStore): PromptRemoteService;
export {};
