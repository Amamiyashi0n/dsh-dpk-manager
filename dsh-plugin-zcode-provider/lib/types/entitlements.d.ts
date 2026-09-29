/**
 * Standalone ZCode entitlement domain.
 *
 * This module intentionally owns the account state and entitlement wire shapes
 * used by the plugin. It has no dependency on the ZCode application, its host
 * runtime, or any @zcode package.
 */
import type { UsageReport } from './usage.js';
export type ProviderFamily = 'zai' | 'bigmodel';
export type AccountProviderMode = 'start-plan' | 'individual-coding-plan' | 'team-coding-plan' | 'off-peak';
export type AccountProviderUnavailableReason = 'not-authenticated' | 'not-connected' | 'credential-failed' | 'not-entitled';
export interface AccountProviderAccess {
    type: 'zhipu-account';
    accountType: ProviderFamily;
    mode: AccountProviderMode;
    entitled: boolean;
}
export interface AccountProviderState {
    availability: 'available' | 'pending' | 'unavailable' | 'unknown';
    entitled: boolean;
    unavailableReason?: AccountProviderUnavailableReason;
    current?: boolean;
    connectionKey?: string;
    effectiveAt?: number;
}
export interface AccountProviderSnapshot {
    access: AccountProviderAccess;
    state: AccountProviderState;
    models?: string[];
}
export interface UsageQuotaUsageDetail {
    modelCode: string;
    displayName?: string;
    usage: number;
}
export interface UsageQuotaLimit {
    type: string;
    bucketId?: string;
    userPlanId?: string;
    periodStart?: number;
    periodEnd?: number;
    period?: string;
    meter?: string;
    unitType?: string;
    planId?: string;
    unit?: number;
    number?: number;
    usage?: number;
    currentValue?: number;
    remaining?: number;
    percentage?: number;
    nextResetTime?: number;
    usageDetails: UsageQuotaUsageDetail[];
}
export interface UsageQuotaSnapshot {
    level: string | null;
    limits: UsageQuotaLimit[];
}
export interface UsageEntitlementRemaining {
    count: number;
    isShow: boolean;
    percentage?: number;
    nextResetTime?: number | null;
}
export interface UsageEntitlementProviderInfo {
    id: string;
    name: string;
}
export interface UsageEntitlementSubscriptionDetail {
    productId: string;
    productName: string;
    purchaseTime: string | null;
    beginTime: string | null;
    billingCycle?: string | null;
    renewTime?: string | null;
    expireTime: string | null;
    entitlements?: Array<{
        entitlementId: string;
        showName?: string | null;
        effectiveTime: string | null;
    }>;
}
export interface UsageEntitlementSubscription {
    identityType: 'email' | 'phoneNumber' | 'unknown';
    identityMasked: string | null;
    details: UsageEntitlementSubscriptionDetail[];
}
export interface UsageEntitlementContext {
    scope: 'personal' | 'team';
    organizationId?: string | null;
    projectId?: string | null;
    displayName?: string | null;
    productId?: string | null;
}
export type UsageMcpQuotaScope = {
    providerFamily: ProviderFamily;
    targetType: 'PERSONAL';
} | {
    providerFamily: ProviderFamily;
    targetType: 'TEAM';
    organizationId: string;
    projectId: string;
};
export interface UsageMcpQuotaSnapshot {
    serverTime: number;
    level: string | null;
    scope: UsageMcpQuotaScope;
    aggregate: UsageQuotaLimit;
}
export interface UsageEntitlementSnapshot {
    generatedAt: number;
    serverTime?: number;
    authenticated: boolean;
    unavailableReason?: 'not_authenticated' | 'not_configured' | 'no_plan' | 'unavailable';
    startPlanExpired?: boolean;
    teamPlanUnavailableReason?: 'expired' | 'unassigned';
    context?: UsageEntitlementContext | null;
    provider: UsageEntitlementProviderInfo | null;
    remaining: UsageEntitlementRemaining | null;
    subscription: UsageEntitlementSubscription | null;
    quota: UsageQuotaSnapshot | null;
    mcpQuota?: UsageMcpQuotaSnapshot | null;
}
export type CodingPlanEntitlement = {
    kind: 'available';
    subscription: UsageEntitlementSubscription;
} | {
    kind: 'unavailable';
} | {
    kind: 'unknown';
};
export interface StartPlanResolution {
    snapshot: UsageEntitlementSnapshot;
    status: 'available' | 'pending' | 'unavailable';
    effectiveAt?: number;
    models: string[];
}
/** Subscription list is the authoritative Coding Plan entitlement source. */
export declare function parseCodingPlanEntitlement(payload: unknown): CodingPlanEntitlement;
/** Normalize the official quota envelope without dropping level or usageDetails. */
export declare function normalizeQuota(payload: unknown): UsageQuotaSnapshot;
export declare function pickPrimaryLimit(limits: UsageQuotaLimit[]): UsageQuotaLimit | undefined;
export declare function resolveStartPlanBalance(payload: unknown, provider: UsageEntitlementProviderInfo, generatedAt?: number): StartPlanResolution;
export declare function buildMcpQuotaSnapshot(payload: unknown, scope: UsageMcpQuotaScope): UsageMcpQuotaSnapshot | null;
export declare function buildCodingPlanSnapshot(input: {
    authenticated: boolean;
    provider: UsageEntitlementProviderInfo | null;
    entitlement: CodingPlanEntitlement;
    quota: UsageQuotaSnapshot | null;
    mcpQuota?: UsageMcpQuotaSnapshot | null;
    configured: boolean;
    context?: UsageEntitlementContext;
    generatedAt?: number;
}): UsageEntitlementSnapshot;
export declare function accountProviderSnapshot(input: {
    accountType: ProviderFamily;
    mode: AccountProviderMode;
    status: AccountProviderState['availability'];
    current: boolean;
    connectionKey?: string;
    unavailableReason?: AccountProviderUnavailableReason;
    effectiveAt?: number;
    models?: string[];
}): AccountProviderSnapshot;
/**
 * Preserve the last resolved provider facts when the latest network round is
 * inconclusive. A definite `unavailable` result still revokes entitlement, and
 * a changed connection key never inherits state from the previous account.
 */
export declare function reconcileAccountProviderSnapshot(current: AccountProviderSnapshot, previous: AccountProviderSnapshot | undefined): AccountProviderSnapshot;
/**
 * Apply the standalone account service's last-known-good rule to a fresh usage
 * report. This mirrors the account Registry lifecycle while keeping the whole
 * state machine inside the DPK.
 */
export declare function reconcileUsageReport(current: UsageReport, previous: UsageReport | undefined): UsageReport;
