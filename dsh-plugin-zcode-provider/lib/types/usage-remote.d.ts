/**
 * Read-only bridge from the Web client to the existing zcode entitlement
 * collectors. The browser never receives credentials: it reads the small,
 * range-independent entitlement snapshot first, then requests optional usage
 * data for its selected range.
 */
import type { EntitlementReport, MonitorRange, UsageSupplement } from './usage.js';
export declare const USAGE_REMOTE_NAMESPACE = "zcodeEntitlements";
interface RemoteContext {
    provide(name: string, value: unknown): unknown;
}
export interface EntitlementSnapshotRequest {
    /** Bypass the short server-side cache for an explicit user refresh. */
    force?: boolean;
}
export interface UsageSupplementRequest {
    range?: MonitorRange;
    /** Bypass the short server-side cache for an explicit user refresh. */
    force?: boolean;
}
export interface EntitlementSnapshot {
    fetchedAt: string;
    defaultProvider?: string;
    core: EntitlementReport;
}
export interface UsageSupplementSnapshot {
    fetchedAt: string;
    supplement: UsageSupplement;
}
export type EntitlementReportCollector = (force?: boolean, signal?: AbortSignal) => Promise<EntitlementReport>;
export type UsageSupplementCollector = (range?: MonitorRange, force?: boolean, signal?: AbortSignal) => Promise<UsageSupplement>;
export type DefaultProviderCollector = () => string | undefined;
/** Register one source-mode Typert service for the ZCode entitlement panel. */
export declare function createUsageRemoteService(ctx: RemoteContext, collectEntitlements: EntitlementReportCollector, collectSupplement: UsageSupplementCollector, collectDefaultProvider?: DefaultProviderCollector): {
    snapshot(request?: EntitlementSnapshotRequest, signal?: AbortSignal): Promise<EntitlementSnapshot>;
    usage(request?: UsageSupplementRequest, signal?: AbortSignal): Promise<UsageSupplementSnapshot>;
    typertRemote: unknown;
};
export {};
