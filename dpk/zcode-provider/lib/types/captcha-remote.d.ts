/**
 * Host-side bridge for rendering Aliyun Captcha inside an already connected
 * DSH Web UI.  The browser polls for a challenge, receives only its public
 * SDK configuration, and returns one verification param to the request that
 * created it.  Credentials and model request data never cross this boundary.
 */
import type { CaptchaConfig, CaptchaSolveResult } from './captcha.js';
/** The Remote namespace mounted by the Web UI client. */
export declare const CAPTCHA_REMOTE_NAMESPACE = "zcodeCaptcha";
/** Explicit alias for call sites that use the provider prefix. */
export declare const ZCODE_CAPTCHA_REMOTE_NAMESPACE = "zcodeCaptcha";
export interface CaptchaChallengeConfig {
    region: string;
    prefix: string;
    sceneId: string;
}
export interface WebCaptchaBrokerOptions {
    /** End-to-end lifetime of an issued challenge. */
    timeoutMs?: number;
    /** How long a model request waits for a Web UI to claim its challenge. */
    availabilityWaitMs?: number;
    /** Injectable clock for deterministic expiration checks. */
    now?: () => number;
}
export interface CaptchaClaimRequest {
    /** Per-tab, runtime-only Web UI identifier. */
    clientId: string;
    /** Optional bounded compatibility wait; the Web UI passes zero and polls. */
    waitMs?: number;
}
export interface CaptchaChallenge {
    id: string;
    config: CaptchaChallengeConfig;
    expiresAt: number;
}
export type CaptchaClaimResponse = {
    state: 'challenge';
    challenge: CaptchaChallenge;
} | {
    state: 'empty';
    retryAfterMs?: number;
};
/** States accepted from the browser's Aliyun SDK callbacks. */
export type CaptchaCompletionState = 'success' | 'fail' | 'error' | 'timeout';
export interface CaptchaCompletionResult {
    state: CaptchaCompletionState;
    param?: string;
    verifyCode?: string;
    reason?: string;
}
export interface CaptchaCompleteRequest {
    id: string;
    clientId: string;
    result: CaptchaCompletionResult;
}
export interface CaptchaCompleteResponse {
    accepted: boolean;
    /** Present only when the Host has conclusively rejected a completion. */
    status?: 'expired' | 'rejected' | 'unavailable';
}
/** Release challenge ownership for a departing Web UI. */
export interface CaptchaReleaseRequest {
    /** Per-tab, runtime-only Web UI identifier. */
    clientId: string;
    /** Restrict release to this owned challenge; omitted releases all work for the client. */
    id?: string;
}
export interface CaptchaReleaseResponse {
    released: boolean;
}
interface RemoteContext {
    provide(name: string, value: unknown): unknown;
}
/**
 * In-memory, one-time captcha challenge broker.
 *
 * A challenge belongs to the first Web UI client that claims it.  The broker
 * never reveals a challenge to a second client and accepts exactly one valid
 * completion from its owner.
 */
export declare class WebCaptchaBroker {
    private readonly now;
    private readonly timeoutMs;
    private readonly availabilityWaitMs;
    private readonly challenges;
    private disposed;
    constructor(options?: WebCaptchaBrokerOptions);
    /**
     * Wait for an existing DSH Web UI to claim and solve one captcha challenge.
     * This result is structurally compatible with captcha.ts's solver port.
     */
    request(config: CaptchaConfig | CaptchaChallengeConfig, signal?: AbortSignal): Promise<CaptchaSolveResult>;
    /**
     * Return one unclaimed challenge immediately. Idle callers get a bounded
     * retry hint rather than holding an HTTP connection open. A client can own
     * at most one challenge at a time, matching the single visible SDK overlay.
     */
    claim(request: CaptchaClaimRequest, signal?: AbortSignal): Promise<CaptchaClaimResponse>;
    /** Accept a single completion from the Web UI client that claimed it. */
    complete(request: CaptchaCompleteRequest): CaptchaCompleteResponse;
    /**
     * Release browser-owned work when a Web UI overlay unmounts. Released
     * challenges remain valid and can be claimed by a
     * replacement Web UI; they are not exposed to another client until this
     * owner explicitly leaves.
     */
    release(request: CaptchaReleaseRequest): CaptchaReleaseResponse;
    /** Resolve outstanding model and browser calls when the plugin unloads. */
    dispose(): void;
    private result;
    private expireChallenges;
    private clientOwnsChallenge;
    /** A claimed challenge proves that one Web UI is present and may drain the queue serially. */
    private hasActiveClient;
    /** Start the short no-Web-UI deadline only while no client is already busy. */
    private armAvailabilityTimer;
    /** A connected client processes one visible SDK overlay at a time, so pause queued deadlines. */
    private pauseAvailabilityTimers;
    /** Once every client has released/completed, pending work again gets the short availability bound. */
    private resumeAvailabilityTimers;
    private claimNext;
    private finish;
}
export interface CaptchaRemoteService {
    claim(request: CaptchaClaimRequest, signal?: AbortSignal): Promise<CaptchaClaimResponse>;
    complete(request: CaptchaCompleteRequest): CaptchaCompleteResponse;
    release(request: CaptchaReleaseRequest): CaptchaReleaseResponse;
    typertRemote: unknown;
}
/** Register the browser-facing Typert service around an existing broker. */
export declare function createCaptchaRemoteService(ctx: RemoteContext, broker: WebCaptchaBroker): CaptchaRemoteService;
export {};
