import {
    capabilityFreshAt,
    issueCapability,
    SigningSender,
    type IRequestSender,
    type JsonValue,
    type Principal,
} from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface, hubServiceIdRegistryInterface } from '@hediet/linkrpc/hub/common';
import { createSelfManagedPrincipal, createSelfManagedPrincipalFromFile } from '@hediet/linkrpc/node';

/** Sends one request to the far end of an outbound connection. */
export type RemoteRequest = (method: string, params: JsonValue) => Promise<JsonValue | undefined>;

/** How long before expiry a stored capability is considered stale (transit + clock skew). */
const CAP_FRESHNESS_MARGIN_MS = 2000;

/**
 * Claim `serviceId` on the far hub for this connection, outside the namespace
 * its token grants, through the admin-gated
 * `<hubServiceId>::hubServiceIdRegistry::registerServiceId`.
 *
 * The call is signed as `principal`. It presents the principal's stored
 * capabilities and a self-issued one scoped to exactly this claim, which the
 * far hub honors when `principal` is one of its root principals.
 */
export async function registerServiceIdAs(
    request: RemoteRequest,
    serviceId: string,
    principal: Principal,
): Promise<void> {
    const { hubServiceId } = await request(
        `${hubGrantedServiceIdInterface.info.id}::getHubServiceId`,
        {},
    ) as { hubServiceId: string };
    const interfaceId = hubServiceIdRegistryInterface.info.id;
    const member = 'registerServiceId';
    const selfIssued = await issueCapability(principal.identity, {
        audience: principal.identity.publicSigningIdentity,
        permissions: [{
            target: {
                serviceId: { exact: hubServiceId },
                interfaceId: { exact: interfaceId },
                members: [{ exact: member }],
            },
            canInvoke: true,
            params: { requestedPrefix: { exact: serviceId } },
        }],
    });
    const signing = new SigningSender(_rawSender(request), {
        principal,
        capProvider: async ({ signedAtMs }) => ({
            capabilities: [
                ...principal.capBag.capabilities.filter((c) =>
                    capabilityFreshAt(c, signedAtMs, CAP_FRESHNESS_MARGIN_MS)),
                selfIssued,
            ],
        }),
    });
    await signing.sendRequest(`${hubServiceId}::${interfaceId}::${member}`, { requestedPrefix: serviceId });
}

/**
 * Load the identity a claim is signed as. Uses the CLI's `--principal`
 * syntax: `user:<id>` (per-user data dir; `user:hubrpc-cli` is the CLI's own
 * identity) or `file:<path>`.
 */
export function loadClaimPrincipal(spec: string): Promise<Principal> {
    if (spec.startsWith('user:') && spec.length > 'user:'.length) {
        return createSelfManagedPrincipal(spec.slice('user:'.length));
    }
    if (spec.startsWith('file:') && spec.length > 'file:'.length) {
        return createSelfManagedPrincipalFromFile(spec.slice('file:'.length));
    }
    return Promise.reject(new Error(`invalid claim identity "${spec}" (expected "user:<id>" or "file:<path>")`));
}

function _rawSender(request: RemoteRequest): IRequestSender<unknown> {
    return {
        sendRequest: async (method, params) => (await request(method, params ?? {})) ?? null,
        sendNotification: () => Promise.reject(new Error('remote claims send no notifications')),
        sendRequestWithStream: () => { throw new Error('remote claims do not stream'); },
        close: () => { },
    };
}
