/** Persistent selection for the ZCode authentication transport. */
export declare const AUTH_BACKEND_REMOTE_NAMESPACE = "zcodeAuthBackend";
export declare const AUTH_BACKENDS: readonly ["openzcode-app-server", "closezcode-app-server"];
export type AuthBackend = typeof AUTH_BACKENDS[number];
export interface AuthBackendSnapshot {
    revision: number;
    backend: AuthBackend;
}
export interface AuthBackendMutationRequest {
    backend: AuthBackend;
}
export declare function defaultAuthBackendPath(storageRoot?: string): string;
export declare function normalizeAuthBackend(value: unknown): AuthBackend;
export declare function readAuthBackend(path: string): AuthBackend;
export declare function writeAuthBackend(path: string, backend: unknown): void;
interface RemoteContext {
    provide(name: string, value: unknown): unknown;
}
interface AuthBackendStore {
    read(): AuthBackend;
    write(backend: AuthBackend): void | Promise<void>;
    revision(): number;
}
export interface AuthBackendRemoteService {
    snapshot(signal?: AbortSignal): Promise<AuthBackendSnapshot>;
    mutate(request: AuthBackendMutationRequest, signal?: AbortSignal): Promise<AuthBackendSnapshot>;
    typertRemote: unknown;
}
export declare function createAuthBackendRemoteService(ctx: RemoteContext, store: AuthBackendStore): AuthBackendRemoteService;
export {};
