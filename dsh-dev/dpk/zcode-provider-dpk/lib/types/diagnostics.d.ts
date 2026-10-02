/** Small, local-only diagnostic log exposed to the Web UI through a Remote. */
export declare const DIAGNOSTICS_REMOTE_NAMESPACE = "zcodeDiagnostics";
export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';
export type DiagnosticValue = string | number | boolean | null;
export interface DiagnosticEvent {
    level: DiagnosticLevel;
    phase: string;
    message: string;
    details?: Record<string, DiagnosticValue>;
}
export interface DiagnosticEntry extends DiagnosticEvent {
    id: number;
    at: string;
}
export interface DiagnosticsSnapshot {
    generatedAt: string;
    context: Record<string, DiagnosticValue>;
    entries: DiagnosticEntry[];
}
export interface DiagnosticsSnapshotRequest {
    limit?: number;
}
export interface DiagnosticSink {
    record(event: DiagnosticEvent): void;
}
/** Keep only the origin of a configured URL. This also removes URL credentials. */
export declare function safeOrigin(value: string | undefined): string | undefined;
export declare class DiagnosticLog implements DiagnosticSink {
    private readonly maxEntries;
    private entries;
    private nextId;
    private context;
    constructor(maxEntries?: number);
    updateContext(values: Record<string, DiagnosticValue>): void;
    record(event: DiagnosticEvent): void;
    snapshot(limit?: number): DiagnosticsSnapshot;
    clear(): void;
}
interface RemoteContext {
    provide(name: string, value: unknown): unknown;
}
export interface DiagnosticsRemoteService {
    snapshot(request?: DiagnosticsSnapshotRequest, signal?: AbortSignal): Promise<DiagnosticsSnapshot>;
    clear(signal?: AbortSignal): Promise<DiagnosticsSnapshot>;
    typertRemote: unknown;
}
export declare function createDiagnosticsRemoteService(ctx: RemoteContext, log: DiagnosticLog): DiagnosticsRemoteService;
export {};
