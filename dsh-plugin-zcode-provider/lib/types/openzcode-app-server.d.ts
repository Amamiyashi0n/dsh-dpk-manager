import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
export interface AppServerConfig {
    /** Enable the comparison transport. The direct provider wire remains the default. */
    enabled?: boolean;
    /** Node executable used to launch the CLI app-server. */
    nodePath?: string;
    /** ZCode CLI bundle passed to `node`. */
    cliPath?: string;
    /** ZCode storage root (`.../.zcode/v2`), including credentials and session databases. */
    storageDir?: string;
    /** Built-in provider catalog consumed by the standalone app-server. */
    builtinProviderConfigPath?: string;
    /** ZCode Personal provider catalog paired with the Built-in catalog. */
    personalProviderConfigPath?: string;
    /** Optional working directory for the app-server process. */
    cwd?: string;
}
export interface AppServerRoute {
    route?: string;
    display?: string;
    kind?: string;
    baseURL?: string;
    apiKey?: string;
    models?: readonly {
        id: string;
        contextWindow?: number;
        maxTokens?: number;
        efforts?: readonly string[];
    }[];
    family?: string;
    access?: {
        type?: string;
        mode?: string;
        accountType?: string;
    };
}
interface WorkspaceModelMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: Array<{
        id: string;
        name: string;
        input: unknown;
    }>;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
}
interface WorkspaceGenerateResult {
    text?: unknown;
    finishReason?: unknown;
    selection?: unknown;
    usage?: Record<string, unknown>;
    toolCalls?: Array<{
        id?: unknown;
        name?: unknown;
        input?: unknown;
    }>;
}
export declare function toWorkspaceMessages(options: GenerateOptions): WorkspaceModelMessage[];
export declare function appServerResultToStreamChunks(result: WorkspaceGenerateResult): StreamChunk[];
/** A long-lived NDJSON client for the white-box openzcode-app-server boundary. */
export declare class OpenZCodeAppServerTransport {
    private readonly config;
    private readonly log;
    private child?;
    private startPromise?;
    private readonly pending;
    private buffer;
    private sequence;
    private disposed;
    private generatedProviderConfigPath?;
    private generatedProviderId?;
    private currentRoute?;
    private currentProviderId?;
    private accountConfigRevision?;
    constructor(config: AppServerConfig, log?: (message: string) => void);
    generate(options: GenerateOptions, route: AppServerRoute, workspacePath?: string): AsyncGenerator<StreamChunk>;
    dispose(): void;
    /**
     * Start-Plan turn delegation: run the request through a real engine agent
     * session (create → setModel → send → collect → close). The engine applies
     * its own official system prompt and tool set; assistant text is polled and
     * re-emitted incrementally so DSH sees progress while the turn runs.
     * Transient concurrency rejections (429/3008) surface as SERVER errors.
     */
    private generateViaSession;
    /** One poll: accumulated assistant text so far, usage on completion. */
    private sessionProgress;
    private providerId;
    private workspacePath;
    private ensureStarted;
    private onStdout;
    private onLine;
    private handleServerRequest;
    private writeResponse;
    private ensureAccountProviderConfig;
    private request;
}
export declare function defaultAppServerPaths(): {
    nodePath: string;
    cliPath: string;
    storageDir: string;
    builtinProviderConfigPath: string;
    personalProviderConfigPath: string;
};
export {};
