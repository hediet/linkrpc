import { hostname, userInfo } from 'node:os';
import { hubGrantedServiceIdInterface, hubServiceIdRegistryInterface } from '@hediet/linkrpc/hub/common';
import type { CliConnection } from '@hediet/linkrpc-client-internal';

const GET_METHOD = `${hubGrantedServiceIdInterface.info.id}::get`;
const CLAIM_METHOD = `${hubGrantedServiceIdInterface.info.id}::register`;
const GET_HUB_SERVICE_ID_METHOD = `${hubGrantedServiceIdInterface.info.id}::getHubServiceId`;

/** A service id to claim, resolved against the connection's granted namespace. */
export interface ResolvedServiceId {
    readonly serviceId: string;
    /** The part after `./` for relative ids, e.g. `notes` for `./notes`. */
    readonly relative?: string;
}

/**
 * Resolve a service id to claim. `./<path>` is relative: it is placed under
 * the connection's granted namespace, or, without one, under a namespace made
 * up from the local user and host (claimed through the hub's consent flow).
 * `undefined` means the granted namespace itself.
 */
export async function resolveServiceIdToClaim(
    local: CliConnection,
    requested: string | undefined,
): Promise<ResolvedServiceId> {
    const granted = await grantedNamespace(local);
    if (requested === undefined) {
        if (granted.length === 0) {
            throw new Error(
                'this connection has no granted serviceId namespace to claim; pass --serviceId '
                + '(e.g. `./my-server` for a service under a namespace of your own).',
            );
        }
        return { serviceId: granted };
    }
    if (!requested.startsWith('./')) return { serviceId: requested };
    const relative = requested.slice(2);
    if (relative.length === 0 || relative.split('/').some((segment) => segment.length === 0)) {
        throw new Error(`invalid relative serviceId: ${requested}`);
    }
    const namespace = granted.length > 0 ? granted : localNamespace();
    return { serviceId: `${namespace}/${relative}`, relative };
}

/**
 * Claim `serviceId`: for free within the connection's granted namespace,
 * otherwise through the admin-gated `hubServiceIdRegistry::registerServiceId`
 * (which the CLI's capability negotiation turns into a consent request).
 */
export async function claimServiceId(local: CliConnection, serviceId: string): Promise<void> {
    if (isServiceIdUnder(serviceId, await grantedNamespace(local))) {
        await local.channel.sendRequest(CLAIM_METHOD, { serviceId });
        return;
    }
    const result = await local.channel.sendRequest(GET_HUB_SERVICE_ID_METHOD, {}) as { hubServiceId?: unknown } | null;
    const hubServiceId = typeof result?.hubServiceId === 'string' ? result.hubServiceId : undefined;
    if (!hubServiceId) throw new Error(`cannot claim '${serviceId}': the hub reports no service id`);
    await local.channel.sendRequest(
        `${hubServiceId}::${hubServiceIdRegistryInterface.info.id}::registerServiceId`,
        { requestedPrefix: serviceId },
    );
}

/** `<user>@<host>`, restricted to characters valid in a service id segment. */
export function localNamespace(): string {
    const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
    let user = 'user';
    try {
        user = userInfo().username;
    } catch {
        // No user database entry, e.g. in containers with arbitrary uids.
    }
    return `${sanitize(user)}@${sanitize(hostname())}`;
}

async function grantedNamespace(local: CliConnection): Promise<string> {
    const info = await local.channel.sendRequest(GET_METHOD, {}) as { grantedServiceIdNamespace?: unknown } | null;
    return typeof info?.grantedServiceIdNamespace === 'string' ? info.grantedServiceIdNamespace : '';
}

function isServiceIdUnder(serviceId: string, namespace: string): boolean {
    if (namespace === '') return false;
    return serviceId === namespace || serviceId.startsWith(`${namespace}/`);
}
