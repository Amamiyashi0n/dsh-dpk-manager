/**
 * Standalone ZCode entitlement domain.
 *
 * This module intentionally owns the account state and entitlement wire shapes
 * used by the plugin. It has no dependency on the ZCode application, its host
 * runtime, or any @zcode package.
 */
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function text(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized || undefined;
}
function numberValue(value) {
    const normalized = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
    return Number.isFinite(normalized) ? normalized : undefined;
}
function epochSeconds(value) {
    const normalized = numberValue(value);
    return normalized !== undefined && normalized > 0 ? normalized : undefined;
}
function isoFromSeconds(value) {
    const normalized = epochSeconds(value);
    return normalized === undefined ? null : new Date(normalized * 1000).toISOString();
}
function isoFromLocal(value) {
    const normalized = text(value);
    if (!normalized)
        return null;
    const parsed = new Date(normalized.includes('T') || !normalized.includes(' ')
        ? normalized
        : normalized.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function envelopeData(payload) {
    const envelope = record(payload);
    if (!envelope)
        return undefined;
    if (envelope.success === false)
        return undefined;
    if (envelope.code !== undefined && envelope.code !== 0 && envelope.code !== 200)
        return undefined;
    return envelope.data;
}
function isCodingPlanProduct(value) {
    const item = record(value);
    return item !== undefined && [item.productId, item.productName].some((field) => (typeof field === 'string' && field.toLowerCase().includes('coding')));
}
function isActiveCodingPlan(value) {
    const item = record(value);
    return item !== undefined
        && isCodingPlanProduct(item)
        && item.status === 'VALID'
        && item.inCurrentPeriod === true;
}
function validPeriodEnd(value) {
    const matches = text(value)?.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/g);
    return isoFromLocal(matches?.at(-1));
}
/** Subscription list is the authoritative Coding Plan entitlement source. */
export function parseCodingPlanEntitlement(payload) {
    const data = envelopeData(payload);
    if (!Array.isArray(data))
        return { kind: 'unknown' };
    let malformedCodingEntry = false;
    for (const raw of data) {
        const item = record(raw);
        if (!item)
            continue;
        if (!isActiveCodingPlan(item)) {
            if (isCodingPlanProduct(item) && (typeof item.status !== 'string' || typeof item.inCurrentPeriod !== 'boolean'))
                malformedCodingEntry = true;
            continue;
        }
        const productId = text(item.productId);
        if (!productId) {
            malformedCodingEntry = true;
            continue;
        }
        const autoRenew = item.autoRenew === true || item.autoRenew === 1;
        const nextRenew = isoFromLocal(item.nextRenewTime);
        return {
            kind: 'available',
            subscription: {
                identityType: 'unknown',
                identityMasked: null,
                details: [{
                        productId,
                        productName: text(item.productName) ?? productId,
                        purchaseTime: isoFromLocal(item.purchaseTime),
                        beginTime: isoFromLocal(item.currentRenewTime),
                        billingCycle: text(item.billingCycle) ?? null,
                        renewTime: autoRenew ? nextRenew : null,
                        expireTime: autoRenew ? validPeriodEnd(item.valid) : (nextRenew ?? validPeriodEnd(item.valid)),
                    }],
            },
        };
    }
    return { kind: malformedCodingEntry ? 'unknown' : 'unavailable' };
}
function normalizeUsageDetails(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((raw) => {
        const item = record(raw);
        const modelCode = text(item?.modelCode);
        if (!item || !modelCode)
            return [];
        const displayName = text(item.displayName);
        return [{
                modelCode,
                ...(displayName === undefined ? {} : { displayName }),
                usage: numberValue(item.usage) ?? 0,
            }];
    });
}
/** Normalize the official quota envelope without dropping level or usageDetails. */
export function normalizeQuota(payload) {
    const data = record(envelopeData(payload));
    if (!data)
        throw new Error('quota response is not a successful envelope');
    const limits = Array.isArray(data.limits) ? data.limits : [];
    return {
        level: text(data.level) ?? null,
        limits: limits.flatMap((raw) => {
            const item = record(raw);
            const type = text(item?.type);
            if (!item || !type)
                return [];
            const result = { type, usageDetails: normalizeUsageDetails(item.usageDetails) };
            for (const key of ['unit', 'number', 'usage', 'currentValue', 'remaining', 'percentage', 'nextResetTime']) {
                const value = numberValue(item[key]);
                if (value !== undefined)
                    result[key] = value;
            }
            return [result];
        }),
    };
}
export function pickPrimaryLimit(limits) {
    return limits.find((limit) => limit.type === 'TIME_LIMIT')
        ?? limits.find((limit) => typeof limit.remaining === 'number')
        ?? limits[0];
}
function startPlanIdentity(value) {
    const normalized = text(value)?.toLowerCase();
    return normalized?.includes('start-plan') === true || normalized?.includes('start plan') === true;
}
function activeStartPlans(value) {
    return Array.isArray(value)
        ? value.flatMap((raw) => {
            const item = record(raw);
            if (!item || text(item.status)?.toLowerCase() !== 'active')
                return [];
            if (!startPlanIdentity(item.plan_id) && !startPlanIdentity(item.name))
                return [];
            return [item];
        })
        : [];
}
function balanceOwnerIsActive(balance, plans) {
    const userPlanId = text(balance.user_plan_id);
    const planId = text(balance.plan_id);
    return plans.some((plan) => (userPlanId && text(plan.user_plan_id)
        ? text(plan.user_plan_id) === userPlanId
        : planId !== undefined && text(plan.plan_id) === planId));
}
function capabilityModels(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((raw) => {
        const normalized = text(raw);
        if (!normalized)
            return [];
        return [normalized.toLowerCase().startsWith('model:') ? normalized.slice(6).trim() : normalized];
    }).filter(Boolean);
}
function startPlanLimits(balances, plans) {
    if (!Array.isArray(balances))
        return [];
    return balances.flatMap((raw) => {
        const item = record(raw);
        if (!item || !balanceOwnerIsActive(item, plans))
            return [];
        const total = numberValue(item.total_units);
        const used = numberValue(item.used_units);
        const remaining = numberValue(item.remaining_units);
        if (total === undefined && used === undefined && remaining === undefined)
            return [];
        const models = capabilityModels(item.capabilities);
        const displayName = text(item.show_name);
        const userPlanId = text(item.user_plan_id);
        const planId = text(item.plan_id);
        const plan = plans.find((candidate) => (userPlanId && text(candidate.user_plan_id)
            ? text(candidate.user_plan_id) === userPlanId
            : text(candidate.plan_id) === planId));
        const entitlementId = text(item.entitlement_id);
        const entitlement = Array.isArray(plan?.entitlements)
            ? plan.entitlements.map(record).find((entry) => text(entry?.entitlement_id) === entitlementId)
            : undefined;
        const periodStart = epochSeconds(item.period_start);
        const periodEnd = epochSeconds(item.period_end);
        const expiresAt = epochSeconds(item.expires_at);
        const limitType = entitlementId ?? (models.join(', ') || text(item.meter) || 'model_usage');
        return [{
                type: limitType,
                ...(text(item.bucket_id) === undefined ? {} : { bucketId: text(item.bucket_id) }),
                ...(userPlanId === undefined ? {} : { userPlanId }),
                ...(periodStart === undefined ? {} : { periodStart: periodStart * 1000 }),
                ...(periodEnd === undefined ? {} : { periodEnd: periodEnd * 1000 }),
                ...(text(entitlement?.period) === undefined ? {} : { period: text(entitlement?.period) }),
                ...(text(item.meter) === undefined ? {} : { meter: text(item.meter) }),
                ...(text(item.unit_type) === undefined ? {} : { unitType: text(item.unit_type) }),
                ...(planId === undefined ? {} : { planId }),
                ...(total === undefined ? {} : { unit: total, number: total }),
                ...(used === undefined ? {} : { usage: used, currentValue: used }),
                ...(remaining === undefined ? {} : { remaining }),
                ...(total !== undefined && remaining !== undefined && total > 0
                    ? { percentage: remaining / total }
                    : {}),
                ...(expiresAt === undefined ? {} : { nextResetTime: expiresAt * 1000 }),
                usageDetails: models.map((modelCode) => ({
                    modelCode,
                    ...(displayName === undefined ? {} : { displayName }),
                    usage: used ?? 0,
                })),
            }];
    });
}
function startPlanSubscription(plans) {
    return {
        identityType: 'unknown',
        identityMasked: null,
        details: plans.map((plan) => ({
            productId: text(plan.plan_id) ?? '',
            productName: text(plan.name) ?? '编程套餐',
            purchaseTime: null,
            beginTime: isoFromSeconds(plan.starts_at),
            billingCycle: Array.isArray(plan.entitlements)
                ? plan.entitlements.map(record).map((entry) => text(entry?.period)).find(Boolean) ?? null
                : null,
            renewTime: null,
            expireTime: isoFromSeconds(plan.ends_at),
            entitlements: Array.isArray(plan.entitlements)
                ? plan.entitlements.flatMap((raw) => {
                    const item = record(raw);
                    const entitlementId = text(item?.entitlement_id);
                    if (!item || !entitlementId)
                        return [];
                    return [{
                            entitlementId,
                            showName: text(item.show_name) ?? null,
                            effectiveTime: isoFromSeconds(item.effective_at),
                        }];
                })
                : [],
        })),
    };
}
export function resolveStartPlanBalance(payload, provider, generatedAt = Date.now()) {
    const envelope = record(payload);
    if (!envelope || envelope.success === false || envelope.code !== 0) {
        throw new Error(`Start Plan balance failed: ${String(envelope?.code ?? 'invalid')}`);
    }
    const data = record(envelope.data);
    const allPlans = Array.isArray(data?.plans) ? data.plans.map(record).filter((v) => v !== undefined) : [];
    const plans = activeStartPlans(data?.plans);
    if (plans.length === 0) {
        return {
            status: 'unavailable',
            models: [],
            snapshot: {
                generatedAt,
                authenticated: true,
                unavailableReason: 'no_plan',
                startPlanExpired: allPlans.some((plan) => text(plan.status)?.toLowerCase() === 'expired'),
                context: { scope: 'personal' },
                provider,
                remaining: null,
                subscription: null,
                quota: null,
            },
        };
    }
    const limits = startPlanLimits(data?.balances, plans);
    const models = [...new Set(limits.flatMap((limit) => limit.usageDetails.map((detail) => detail.modelCode)))];
    const serverTime = numberValue(data?.server_time);
    const effectiveTimes = plans.flatMap((plan) => (Array.isArray(plan.entitlements) && plan.entitlements.length > 0
        ? plan.entitlements.map(record).map((entry) => epochSeconds(entry?.effective_at))
        : [epochSeconds(plan.starts_at)])).filter((value) => value !== undefined);
    const nowSeconds = serverTime ?? generatedAt / 1000;
    const pending = models.length === 0
        && effectiveTimes.length > 0
        && effectiveTimes.every((value) => value > nowSeconds);
    const total = limits.reduce((sum, limit) => sum + (limit.number ?? 0), 0);
    const remaining = limits.reduce((sum, limit) => sum + (limit.remaining ?? 0), 0);
    const reset = limits.map((limit) => limit.nextResetTime).filter((value) => value !== undefined).sort((a, b) => a - b)[0];
    return {
        status: pending ? 'pending' : 'available',
        models,
        ...(pending ? { effectiveAt: Math.min(...effectiveTimes) } : {}),
        snapshot: {
            generatedAt,
            ...(serverTime === undefined ? {} : { serverTime: serverTime * 1000 }),
            authenticated: true,
            context: { scope: 'personal' },
            provider,
            remaining: limits.length === 0 ? null : {
                count: remaining,
                isShow: true,
                ...(total > 0 ? { percentage: remaining / total } : {}),
                nextResetTime: reset ?? null,
            },
            subscription: startPlanSubscription(plans),
            quota: limits.length === 0 ? null : { level: 'Start', limits },
        },
    };
}
export function buildMcpQuotaSnapshot(payload, scope) {
    const envelope = record(payload);
    const data = record(envelopeData(payload));
    const total = record(data?.total_usage);
    if (!envelope || envelope.code !== 0 || !data || !total)
        return null;
    const cap = Math.max(0, numberValue(total.limit) ?? 0);
    if (cap <= 0)
        return null;
    const remaining = Math.min(Math.max(0, numberValue(total.remaining) ?? 0), cap);
    const used = Math.max(0, numberValue(total.used) ?? 0);
    const nextRefresh = epochSeconds(data.next_refresh_at);
    return {
        serverTime: (numberValue(data.server_time) ?? 0) * 1000,
        level: text(data.level) ?? null,
        scope,
        aggregate: {
            type: 'MCP_USAGE_LIMIT',
            number: cap,
            currentValue: used,
            usage: used,
            remaining,
            percentage: Math.max(0, Math.min(100, 100 - (remaining / cap) * 100)),
            ...(nextRefresh === undefined ? {} : { nextResetTime: nextRefresh * 1000 }),
            usageDetails: [],
        },
    };
}
export function buildCodingPlanSnapshot(input) {
    const primary = pickPrimaryLimit(input.quota?.limits ?? []);
    return {
        generatedAt: input.generatedAt ?? Date.now(),
        authenticated: input.authenticated,
        ...(!input.authenticated
            ? { unavailableReason: 'not_authenticated' }
            : !input.configured
                ? { unavailableReason: 'not_configured' }
                : input.entitlement.kind === 'unavailable'
                    ? { unavailableReason: 'no_plan' }
                    : input.entitlement.kind === 'unknown'
                        ? { unavailableReason: 'unavailable' }
                        : {}),
        context: input.context ?? { scope: 'personal' },
        provider: input.provider,
        remaining: primary === undefined ? null : {
            count: primary.remaining ?? 0,
            isShow: true,
            ...(primary.percentage === undefined ? {} : { percentage: primary.percentage }),
            nextResetTime: primary.nextResetTime ?? null,
        },
        subscription: input.entitlement.kind === 'available' ? input.entitlement.subscription : null,
        quota: input.quota,
        mcpQuota: input.mcpQuota ?? null,
    };
}
export function accountProviderSnapshot(input) {
    const entitled = input.status === 'available';
    return {
        access: { type: 'zhipu-account', accountType: input.accountType, mode: input.mode, entitled },
        state: {
            availability: input.status,
            entitled,
            ...(input.unavailableReason === undefined ? {} : { unavailableReason: input.unavailableReason }),
            current: input.current,
            ...(input.connectionKey === undefined ? {} : { connectionKey: input.connectionKey }),
            ...(input.effectiveAt === undefined ? {} : { effectiveAt: input.effectiveAt }),
        },
        ...(input.models === undefined ? {} : { models: input.models }),
    };
}
function sameAccountConnection(current, previous) {
    if (current.access.accountType !== previous.access.accountType
        || current.access.mode !== previous.access.mode)
        return false;
    const currentKey = current.state.connectionKey;
    const previousKey = previous.state.connectionKey;
    return currentKey === undefined || previousKey === undefined || currentKey === previousKey;
}
/**
 * Preserve the last resolved provider facts when the latest network round is
 * inconclusive. A definite `unavailable` result still revokes entitlement, and
 * a changed connection key never inherits state from the previous account.
 */
export function reconcileAccountProviderSnapshot(current, previous) {
    if (current.state.availability !== 'unknown'
        || previous === undefined
        || !sameAccountConnection(current, previous))
        return current;
    return {
        access: previous.access,
        state: {
            ...previous.state,
            current: current.state.current,
            connectionKey: current.state.connectionKey,
        },
        ...((current.models ?? previous.models) === undefined
            ? {}
            : { models: [...(current.models ?? previous.models ?? [])] }),
    };
}
function reconcileEntitlementSnapshot(current, previous) {
    return {
        ...previous,
        generatedAt: current.generatedAt,
        authenticated: current.authenticated,
        ...(current.context === undefined ? {} : { context: current.context }),
        provider: current.provider ?? previous.provider,
        remaining: current.remaining ?? previous.remaining,
        subscription: previous.subscription,
        quota: current.quota ?? previous.quota,
        ...((current.mcpQuota ?? previous.mcpQuota) === undefined
            ? {}
            : { mcpQuota: current.mcpQuota ?? previous.mcpQuota ?? null }),
    };
}
/**
 * Apply the standalone account service's last-known-good rule to a fresh usage
 * report. This mirrors the account Registry lifecycle while keeping the whole
 * state machine inside the DPK.
 */
export function reconcileUsageReport(current, previous) {
    if (previous === undefined)
        return current;
    const accountProviders = {};
    let retainCodingPlan = false;
    let retainStartPlan = false;
    for (const [providerId, provider] of Object.entries(current.accountProviders)) {
        const reconciled = reconcileAccountProviderSnapshot(provider, previous.accountProviders[providerId]);
        accountProviders[providerId] = reconciled;
        if (reconciled === provider)
            continue;
        if (provider.access.mode === 'start-plan')
            retainStartPlan = true;
        if (provider.access.mode === 'individual-coding-plan'
            || provider.access.mode === 'team-coding-plan')
            retainCodingPlan = true;
    }
    return {
        ...current,
        accountProviders,
        entitlements: {
            codingPlan: retainCodingPlan
                ? reconcileEntitlementSnapshot(current.entitlements.codingPlan, previous.entitlements.codingPlan)
                : current.entitlements.codingPlan,
            startPlan: retainStartPlan
                ? reconcileEntitlementSnapshot(current.entitlements.startPlan, previous.entitlements.startPlan)
                : current.entitlements.startPlan,
        },
    };
}
