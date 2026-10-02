/** Small, local-only diagnostic log exposed to the Web UI through a Remote. */
export const DIAGNOSTICS_REMOTE_NAMESPACE = 'zcodeDiagnostics';
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const MAX_ENTRIES = 200;
const SENSITIVE_KEY = /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|jwt|secret|password|cookie|credential|private[-_]?key/i;
const SAFE_CREDENTIAL_SOURCES = new Set(['credential-store', 'zcode-jwt', 'config', 'none']);
function sanitizeText(value) {
    return value
        .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
        .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
        .replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization)=)[^&#\s]+/gi, '$1[redacted]')
        .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|authorization)\s*[:=]\s*["']?)[^,;\s}"']+/gi, '$1[redacted]')
        .slice(0, 1000);
}
function sanitizeValue(key, value) {
    // Presence flags must remain visible so missing and redacted credentials are
    // distinguishable during remote troubleshooting.
    if (/credential/i.test(key) && typeof value === 'string' && SAFE_CREDENTIAL_SOURCES.has(value))
        return value;
    // Keep absent optional fields as null. Turning a missing credential into
    // "[redacted]" makes an unavailable route look like a present secret.
    if (SENSITIVE_KEY.test(key))
        return typeof value === 'boolean' || value === null ? value : '[redacted]';
    return typeof value === 'string' ? sanitizeText(value) : value;
}
function sanitizeDetails(details) {
    if (details === undefined)
        return undefined;
    const output = {};
    for (const [key, value] of Object.entries(details))
        output[key] = sanitizeValue(key, value);
    return output;
}
/** Keep only the origin of a configured URL. This also removes URL credentials. */
export function safeOrigin(value) {
    if (value === undefined || value.trim() === '')
        return undefined;
    try {
        return new URL(value).origin;
    }
    catch {
        return undefined;
    }
}
export class DiagnosticLog {
    maxEntries;
    entries = [];
    nextId = 1;
    context = {};
    constructor(maxEntries = MAX_ENTRIES) {
        this.maxEntries = maxEntries;
    }
    updateContext(values) {
        for (const [key, value] of Object.entries(values))
            this.context[key] = sanitizeValue(key, value);
    }
    record(event) {
        const details = sanitizeDetails(event.details);
        const entry = {
            id: this.nextId++,
            at: new Date().toISOString(),
            level: event.level,
            phase: sanitizeText(event.phase),
            message: sanitizeText(event.message),
            ...(details === undefined ? {} : { details }),
        };
        this.entries.push(entry);
        if (this.entries.length > this.maxEntries)
            this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    snapshot(limit = this.maxEntries) {
        const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(this.maxEntries, Math.floor(limit))) : this.maxEntries;
        return {
            generatedAt: new Date().toISOString(),
            context: { ...this.context },
            entries: this.entries.slice(-bounded).map((entry) => ({
                ...entry,
                ...(entry.details === undefined ? {} : { details: { ...entry.details } }),
            })),
        };
    }
    clear() {
        this.entries = [];
    }
}
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
export function createDiagnosticsRemoteService(ctx, log) {
    class ZcodeDiagnosticsRemoteService {
        typertRemote;
        constructor() {
            this.typertRemote = undefined;
        }
        async snapshot(request, signal) {
            signal?.throwIfAborted();
            const snapshot = log.snapshot(request?.limit);
            signal?.throwIfAborted();
            return snapshot;
        }
        async clear(signal) {
            signal?.throwIfAborted();
            log.clear();
            return await this.snapshot(undefined, signal);
        }
    }
    markRemote(ZcodeDiagnosticsRemoteService.prototype, 'snapshot');
    markRemote(ZcodeDiagnosticsRemoteService.prototype, 'clear');
    const service = new ZcodeDiagnosticsRemoteService();
    service.typertRemote = Object.freeze({
        service,
        serviceKey: DIAGNOSTICS_REMOTE_NAMESPACE,
        namespace: DIAGNOSTICS_REMOTE_NAMESPACE,
    });
    ctx.provide(DIAGNOSTICS_REMOTE_NAMESPACE, service);
    return service;
}
