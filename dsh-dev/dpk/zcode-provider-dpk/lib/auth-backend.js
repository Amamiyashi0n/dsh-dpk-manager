/** Persistent selection for the ZCode authentication transport. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultStorageRoot } from './storage.js';
export const AUTH_BACKEND_REMOTE_NAMESPACE = 'zcodeAuthBackend';
export const AUTH_BACKENDS = ['openzcode-app-server', 'closezcode-app-server'];
export function defaultAuthBackendPath(storageRoot) {
    return join(storageRoot?.trim() || defaultStorageRoot(), 'state', 'auth-backend.json');
}
export function normalizeAuthBackend(value) {
    return value === 'closezcode-app-server' ? 'closezcode-app-server' : 'openzcode-app-server';
}
export function readAuthBackend(path) {
    if (!existsSync(path))
        return 'openzcode-app-server';
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return normalizeAuthBackend(parsed?.backend);
    }
    catch {
        return 'openzcode-app-server';
    }
}
export function writeAuthBackend(path, backend) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ backend: normalizeAuthBackend(backend) }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
}
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
export function createAuthBackendRemoteService(ctx, store) {
    class ZcodeAuthBackendRemoteService {
        typertRemote;
        constructor() {
            this.typertRemote = undefined;
        }
        async snapshot(signal) {
            signal?.throwIfAborted();
            const backend = normalizeAuthBackend(store.read());
            signal?.throwIfAborted();
            return { revision: store.revision(), backend };
        }
        async mutate(request, signal) {
            signal?.throwIfAborted();
            if (request?.backend !== 'openzcode-app-server' && request?.backend !== 'closezcode-app-server') {
                throw new Error('unknown zcode authentication backend');
            }
            await store.write(request.backend);
            signal?.throwIfAborted();
            return await this.snapshot(signal);
        }
    }
    markRemote(ZcodeAuthBackendRemoteService.prototype, 'snapshot');
    markRemote(ZcodeAuthBackendRemoteService.prototype, 'mutate');
    const service = new ZcodeAuthBackendRemoteService();
    service.typertRemote = Object.freeze({
        service,
        serviceKey: AUTH_BACKEND_REMOTE_NAMESPACE,
        namespace: AUTH_BACKEND_REMOTE_NAMESPACE,
    });
    ctx.provide(AUTH_BACKEND_REMOTE_NAMESPACE, service);
    return service;
}
