/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    type ParamMatcher,
    type Pattern,
    type Permission,
    type SignedCapability,
} from '../../protocol';
import { capabilityFreshAt } from '../../identity/capability';
import { signedHash } from '../../identity/signedObject';

/**
 * The client-facing wire shapes of the hub's capability-negotiation protocol
 * (`hubAccess::requestAccess`, see {@link hubAccessInterface}). Any hub client —
 * the CLI, the MCP server, or an embedder — speaks these shapes to ask a hub
 * for authority in a single consent prompt.
 */

/** How long a granted capability should live. */
export type HubAccessDuration = 'once' | 'shortLived' | 'longLived' | 'persistent';

/** A `serviceId` / `interfaceId` / member matcher (wire shape of `TargetPattern`). */
export type HubAccessPattern = { readonly exact: string; } | { readonly prefix: string; };

/** One authority the consumer wants — the wire shape of a `requestAccess` permission. */
export interface HubAccessPermission {
    readonly target: {
        readonly serviceId: HubAccessPattern;
        readonly interfaceId: HubAccessPattern;
        readonly interfaceHash?: string;
        readonly members: readonly HubAccessPattern[];
    };
    /** Default false (fail closed). Set true to actually call the members. */
    readonly canInvoke?: boolean;
    /** Default false. Set true to let the consumer re-delegate this authority. */
    readonly canDelegate?: boolean;
    readonly params?: Record<string, unknown>;
}

/** A batched, explicit access request — possibly many permissions in one prompt. */
export interface HubAccessRequest {
    readonly consumer: { readonly name: string; readonly origin?: string; readonly purpose?: string; };
    /** One or more authorities to request together (single consent prompt). */
    readonly permissions: readonly HubAccessPermission[];
    /** `once` (short-lived), `session` (this connection), or `persistent` (saved). */
    readonly duration?: HubAccessDuration;
}

/**
 * Outcome of a `requestAccess` call. `granted` carries every capability the hub
 * minted plus how many of them were durable and added to the connection's cap
 * bag (a client-side augmentation over the pure wire result).
 */
export type HubAccessResult =
    | {
        readonly status: 'granted';
        /** Every capability the hub minted for this request. */
        readonly capabilities: readonly SignedCapability[];
        /** How many of them were durable and added to the connection's cap bag. */
        readonly addedDurable: number;
    }
    | { readonly status: 'denied'; readonly reason?: string; }
    | { readonly status: string; readonly reason?: string; };

/**
 * Return fresh durable capabilities that collectively cover an explicit access
 * request, or `undefined` when the caller must ask the hub for more authority.
 *
 * This is the broad-request counterpart to checking whether a cap bag covers
 * one concrete call. Clients use it before opening consent so persisted grants
 * are reused without weakening any service/interface/member pattern.
 * Returns complete chains, not just matching leaves. This synchronous cache
 * hint checks scope/topology, not signatures or recipient trust; `permits` is
 * still the authorization check.
 */
export function findCoveringCapabilities(
    capabilities: readonly SignedCapability[],
    requested: readonly HubAccessPermission[],
    options: {
        readonly nowMs?: number;
        readonly freshnessMarginMs?: number;
        /** Restrict reusable leaves to this caller; ancestors may name others. */
        readonly audience?: string;
    } = {},
): readonly SignedCapability[] | undefined {
    if (requested.length === 0) return undefined;
    const nowMs = options.nowMs ?? Date.now();
    const freshnessMarginMs = options.freshnessMarginMs ?? 0;
    const reusable = capabilities.filter((capability) =>
        capabilityFreshAt(capability, nowMs, freshnessMarginMs)
        && capability.permissions.every((permission) => permission.callBind === undefined),
    );
    const matching = new Set<SignedCapability>();
    const byHash = new Map<string, SignedCapability>(reusable.map(cap => [signedHash("capability", cap), cap]));

    for (const request of requested) {
        let found = false;
        for (const candidate of reusable) {
            if (options.audience !== undefined && candidate.audience !== options.audience) continue;
            const chain: SignedCapability[] = [];
            let link: SignedCapability | undefined = candidate;
            while (link && chain.length < 16 && !chain.includes(link)) {
                const required = chain.length === 0 ? request : { ...request, canInvoke: false, canDelegate: true };
                if (!link.permissions.some(granted => permissionCovers(granted, required))) break;
                chain.push(link);
                if (link.parentHash === undefined) {
                    chain.forEach(cap => matching.add(cap));
                    found = true;
                    break;
                }
                const parent = byHash.get(link.parentHash);
                if (parent?.audience !== link.issuer) break;
                link = parent;
            }
            if (found) break;
        }
        if (!found) return undefined;
    }

    return [...matching];
}

function permissionCovers(
    granted: Permission,
    requested: HubAccessPermission,
): boolean {
    if (requested.canInvoke && !granted.canInvoke) return false;
    if (requested.canDelegate && !granted.canDelegate) return false;
    if (!patternCovers(granted.target.serviceId, requested.target.serviceId, '/')) return false;
    if (!patternCovers(granted.target.interfaceId, requested.target.interfaceId, '.')) return false;
    if (
        granted.target.interfaceHash !== undefined
        && granted.target.interfaceHash !== requested.target.interfaceHash
    ) {
        return false;
    }
    if (!requested.target.members.every((requestedMember) =>
        granted.target.members.some((grantedMember) =>
            patternCovers(grantedMember, requestedMember, ''),
        ),
    )) {
        return false;
    }

    if (requested.params === undefined) return granted.params === undefined;
    if (granted.params === undefined) return true;
    return paramsEqual(granted.params, requested.params);
}

function patternCovers(granted: Pattern, requested: HubAccessPattern, delimiter: string): boolean {
    if ('exact' in granted) {
        return 'exact' in requested && granted.exact === requested.exact;
    }
    if (granted.prefix === '') return true;
    if ('exact' in requested) {
        return requested.exact === granted.prefix
            || requested.exact.startsWith(granted.prefix + delimiter);
    }
    if (requested.prefix === granted.prefix) return true;
    return delimiter === ''
        ? requested.prefix.startsWith(granted.prefix)
        : requested.prefix.startsWith(granted.prefix + delimiter);
}

function paramsEqual(
    granted: Record<string, ParamMatcher>,
    requested: Record<string, unknown>,
): boolean {
    // HubAccessPermission keeps this field dependency-light as `unknown`, but
    // broad explicit requests carry the same ParamMatcher wire shapes as a
    // Permission. Exact equality is the only safe coverage claim here.
    return JSON.stringify(granted) === JSON.stringify(requested);
}
