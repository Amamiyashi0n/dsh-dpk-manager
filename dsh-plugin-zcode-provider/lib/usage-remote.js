/**
 * Read-only bridge from the Web client to the existing zcode entitlement
 * collectors. The browser never receives credentials: it reads the small,
 * range-independent entitlement snapshot first, then requests optional usage
 * data for its selected range.
 */
export const USAGE_REMOTE_NAMESPACE = 'zcodeEntitlements';
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const TRACE_REMOTE = process.env.DSH_ZCODE_TRACE === '1';
function traceRemote(method, phase, startedAt) {
    if (TRACE_REMOTE)
        console.error(`[zcode-provider:trace] ${method} ${phase} ${Date.now() - startedAt}ms`);
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
/** Register one source-mode Typert service for the ZCode entitlement panel. */
export function createUsageRemoteService(ctx, collectEntitlements, collectSupplement, collectDefaultProvider) {
    class ZcodeEntitlementsRemoteService {
        typertRemote;
        constructor() {
            this.typertRemote = undefined;
        }
        /** Small first response: account routes, subscriptions, and quota windows. */
        async snapshot(request, signal) {
            const startedAt = Date.now();
            traceRemote('snapshot', 'start', startedAt);
            signal?.throwIfAborted();
            const defaultProvider = collectDefaultProvider?.();
            const core = await collectEntitlements(request?.force === true, signal);
            signal?.throwIfAborted();
            traceRemote('snapshot', 'done', startedAt);
            return {
                fetchedAt: new Date().toISOString(),
                ...(defaultProvider === undefined ? {} : { defaultProvider }),
                core,
            };
        }
        /** Optional range-bound response: model history and MCP usage only. */
        async usage(request, signal) {
            const startedAt = Date.now();
            traceRemote('usage', 'start', startedAt);
            signal?.throwIfAborted();
            const range = request?.range === '7d' || request?.range === '30d' ? request.range : undefined;
            const supplement = await collectSupplement(range, request?.force === true, signal);
            signal?.throwIfAborted();
            traceRemote('usage', 'done', startedAt);
            return {
                fetchedAt: new Date().toISOString(),
                supplement,
            };
        }
    }
    markRemote(ZcodeEntitlementsRemoteService.prototype, 'snapshot');
    markRemote(ZcodeEntitlementsRemoteService.prototype, 'usage');
    const service = new ZcodeEntitlementsRemoteService();
    service.typertRemote = Object.freeze({
        service,
        serviceKey: USAGE_REMOTE_NAMESPACE,
        namespace: USAGE_REMOTE_NAMESPACE,
    });
    ctx.provide(USAGE_REMOTE_NAMESPACE, service);
    return service;
}
