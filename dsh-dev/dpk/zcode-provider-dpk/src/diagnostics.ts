/** Small, local-only diagnostic log exposed to the Web UI through a Remote. */

export const DIAGNOSTICS_REMOTE_NAMESPACE = 'zcodeDiagnostics'

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'
export type DiagnosticValue = string | number | boolean | null

export interface DiagnosticEvent {
  level: DiagnosticLevel
  phase: string
  message: string
  details?: Record<string, DiagnosticValue>
}

export interface DiagnosticEntry extends DiagnosticEvent {
  id: number
  at: string
}

export interface DiagnosticsSnapshot {
  generatedAt: string
  context: Record<string, DiagnosticValue>
  entries: DiagnosticEntry[]
}

export interface DiagnosticsSnapshotRequest {
  limit?: number
}

export interface DiagnosticSink {
  record(event: DiagnosticEvent): void
}

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const MAX_ENTRIES = 200
const SENSITIVE_KEY = /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|jwt|secret|password|cookie|credential|private[-_]?key/i
const SAFE_CREDENTIAL_SOURCES = new Set(['credential-store', 'zcode-jwt', 'config', 'none'])

function sanitizeText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|authorization)\s*[:=]\s*["']?)[^,;\s}"']+/gi, '$1[redacted]')
    .slice(0, 1000)
}

function sanitizeValue(key: string, value: DiagnosticValue): DiagnosticValue {
  // Presence flags must remain visible so missing and redacted credentials are
  // distinguishable during remote troubleshooting.
  if (/credential/i.test(key) && typeof value === 'string' && SAFE_CREDENTIAL_SOURCES.has(value)) return value
  // Keep absent optional fields as null. Turning a missing credential into
  // "[redacted]" makes an unavailable route look like a present secret.
  if (SENSITIVE_KEY.test(key)) return typeof value === 'boolean' || value === null ? value : '[redacted]'
  return typeof value === 'string' ? sanitizeText(value) : value
}

function sanitizeDetails(details: Record<string, DiagnosticValue> | undefined): Record<string, DiagnosticValue> | undefined {
  if (details === undefined) return undefined
  const output: Record<string, DiagnosticValue> = {}
  for (const [key, value] of Object.entries(details)) output[key] = sanitizeValue(key, value)
  return output
}

/** Keep only the origin of a configured URL. This also removes URL credentials. */
export function safeOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  try { return new URL(value).origin } catch { return undefined }
}

export class DiagnosticLog implements DiagnosticSink {
  private entries: DiagnosticEntry[] = []
  private nextId = 1
  private context: Record<string, DiagnosticValue> = {}

  constructor(private readonly maxEntries = MAX_ENTRIES) {}

  updateContext(values: Record<string, DiagnosticValue>): void {
    for (const [key, value] of Object.entries(values)) this.context[key] = sanitizeValue(key, value)
  }

  record(event: DiagnosticEvent): void {
    const details = sanitizeDetails(event.details)
    const entry: DiagnosticEntry = {
      id: this.nextId++,
      at: new Date().toISOString(),
      level: event.level,
      phase: sanitizeText(event.phase),
      message: sanitizeText(event.message),
      ...(details === undefined ? {} : { details }),
    }
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)
  }

  snapshot(limit = this.maxEntries): DiagnosticsSnapshot {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(this.maxEntries, Math.floor(limit))) : this.maxEntries
    return {
      generatedAt: new Date().toISOString(),
      context: { ...this.context },
      entries: this.entries.slice(-bounded).map((entry) => ({
        ...entry,
        ...(entry.details === undefined ? {} : { details: { ...entry.details } }),
      })),
    }
  }

  clear(): void {
    this.entries = []
  }
}

interface RemoteContext {
  provide(name: string, value: unknown): unknown
}

function markRemote(prototype: object, methodName: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value as
    | { methods?: readonly unknown[] }
    | undefined
  const marker = Object.freeze({ method: methodName, invocation: Object.freeze({ kind: 'direct' }) })
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([...(descriptor?.methods ?? []), marker]),
    }),
  })
}

export interface DiagnosticsRemoteService {
  snapshot(request?: DiagnosticsSnapshotRequest, signal?: AbortSignal): Promise<DiagnosticsSnapshot>
  clear(signal?: AbortSignal): Promise<DiagnosticsSnapshot>
  typertRemote: unknown
}

export function createDiagnosticsRemoteService(ctx: RemoteContext, log: DiagnosticLog): DiagnosticsRemoteService {
  class ZcodeDiagnosticsRemoteService implements DiagnosticsRemoteService {
    typertRemote: unknown

    constructor() {
      this.typertRemote = undefined
    }

    async snapshot(request: DiagnosticsSnapshotRequest | undefined, signal?: AbortSignal): Promise<DiagnosticsSnapshot> {
      signal?.throwIfAborted()
      const snapshot = log.snapshot(request?.limit)
      signal?.throwIfAborted()
      return snapshot
    }

    async clear(signal?: AbortSignal): Promise<DiagnosticsSnapshot> {
      signal?.throwIfAborted()
      log.clear()
      return await this.snapshot(undefined, signal)
    }
  }

  markRemote(ZcodeDiagnosticsRemoteService.prototype, 'snapshot')
  markRemote(ZcodeDiagnosticsRemoteService.prototype, 'clear')
  const service = new ZcodeDiagnosticsRemoteService()
  service.typertRemote = Object.freeze({
    service,
    serviceKey: DIAGNOSTICS_REMOTE_NAMESPACE,
    namespace: DIAGNOSTICS_REMOTE_NAMESPACE,
  })
  ctx.provide(DIAGNOSTICS_REMOTE_NAMESPACE, service)
  return service
}
