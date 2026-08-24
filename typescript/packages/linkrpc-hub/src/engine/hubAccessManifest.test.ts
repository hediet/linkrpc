import { describe, expect, it } from 'vitest';
import type { Permission, PrincipalId, SignedCapability } from '@hediet/linkrpc';
import { LinkRpcConnection, InMemoryManagedIdentity, TransportPair } from '@hediet/linkrpc';
import { hubAccessInterface, hubAccessManifestInterface } from '@hediet/linkrpc/hub/common';
import {
    CapabilityProposalIssuer,
    type AccessCallIntent,
} from '../hub/server';
import { computeCallBindHash } from './consent';
import { HubAccessManifestHost, registerHubAccessManifest } from './hubAccessManifest';
import { runManifestApprover } from './manifestApprover';

const PERMISSION: Permission = {
    target: {
        serviceId: { exact: 'hello' },
        interfaceId: { exact: 'greeter' },
        members: [{ exact: 'hello' }],
    },
    canInvoke: true,
};

const PRINCIPAL = 'id:key:consumer' as PrincipalId;

const quiet = () => { /* swallow host logs */ };

/** Wire a host (manifest + hubAccess registered directly) and a client connection. */
function wire(acceptableRootIds?: string[]) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    const host = new HubAccessManifestHost({ ...(acceptableRootIds ? { acceptableRootIds } : {}), log: quiet });
    registerHubAccessManifest(server, host, { serviceId: 'hub' });
    host.registerHubAccessAtRoot(server);
    return { host, client, dispose: () => { server.close(); client.close(); } };
}

/** Call `hubAccess::requestAccess` over the client (root form). */
function requestAccess(
    client: LinkRpcConnection,
    permissions: Permission[] = [PERMISSION],
    duration: 'once' | 'shortLived' | 'longLived' | 'persistent' = 'shortLived',
) {
    return client.get(hubAccessInterface).requestAccess({
        consumer: { name: 'tester', principal: PRINCIPAL },
        permissions,
        duration,
    });
}

async function waitForEntry(host: HubAccessManifestHost): Promise<string> {
    for (let i = 0; i < 200; i++) {
        const entries = host.getDesired().entries;
        if (entries.length > 0) return entries[0]!.requestId;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('no desired entry appeared');
}

describe('HubAccessManifestHost (hubAccess registered directly → manifest out)', () => {
    it('parks a requestAccess as a direct entry and relays the approved cap', async () => {
        const { host, client, dispose } = wire(['id:key:approver']);
        const call = requestAccess(client);

        const id = await waitForEntry(host);
        const entry = host.getDesired().entries[0]!;
        expect(entry.kind).toBe('direct');
        expect(host.getDesired().acceptableRootIds).toEqual(['id:key:approver']);

        const admin = await InMemoryManagedIdentity.generate();
        const cap = await new CapabilityProposalIssuer(admin).mint({ audience: PRINCIPAL, permissions: [PERMISSION] });
        expect(host.resolve(id, { grant: true, capabilities: [cap] })).toBe(true);

        const res = await call;
        expect(res).toMatchObject({ status: 'granted', capabilities: [cap] });
        expect(host.getDesired().entries).toHaveLength(0);
        dispose();
    });

    it('relays a denial (with reason) back to the caller', async () => {
        const { host, client, dispose } = wire();
        const call = requestAccess(client);
        const id = await waitForEntry(host);
        host.resolve(id, { grant: false, reason: 'nope' });
        expect(await call).toEqual({ status: 'denied', reason: 'nope' });
        dispose();
    });

    it('returns false resolving an unknown entry', () => {
        const host = new HubAccessManifestHost({ log: quiet });
        expect(host.resolve('nope', { grant: false })).toBe(false);
    });
});

describe('runManifestApprover (over a connection)', () => {
    it('lists, prompts (grant), mints, and writes setCurrent — the caller resolves with the cap', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const { host, client, dispose } = wire([admin.principal]);
        const approver = runManifestApprover({
            manifest: client.service('hub').get(hubAccessManifestInterface),
            issuer: new CapabilityProposalIssuer(admin),
            prompt: async () => ({ grant: true }),
            log: quiet,
        });

        const res = await requestAccess(client);
        expect(res.status).toBe('granted');
        const cap = grantedCaps(res)[0]!;
        expect(cap.issuer).toBe(admin.principal);  // approver minted with ITS key
        expect(cap.audience).toBe(PRINCIPAL);
        expect(host.getDesired().entries).toHaveLength(0);

        approver.dispose();
        dispose();
    });

    it('relays a deny decision back to the caller', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const { client, dispose } = wire([admin.principal]);
        const approver = runManifestApprover({
            manifest: client.service('hub').get(hubAccessManifestInterface),
            issuer: new CapabilityProposalIssuer(admin),
            prompt: async () => ({ grant: false, reason: 'operator declined' }),
            log: quiet,
        });

        expect(await requestAccess(client)).toEqual({ status: 'denied', reason: 'operator declined' });

        approver.dispose();
        dispose();
    });

    it('skips entries whose acceptableRootIds it cannot satisfy', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        // The host only accepts a DIFFERENT root, so this approver must not act.
        const { host, client, dispose } = wire(['id:key:someone-else']);
        let prompted = false;
        const approver = runManifestApprover({
            manifest: client.service('hub').get(hubAccessManifestInterface),
            issuer: new CapabilityProposalIssuer(admin),
            prompt: async () => { prompted = true; return { grant: true }; },
            log: quiet,
        });

        const call = requestAccess(client);
        const id = await waitForEntry(host);
        await new Promise((r) => setTimeout(r, 50));
        expect(prompted).toBe(false);
        expect(host.getDesired().entries).toHaveLength(1);

        host.resolve(id, { grant: false });   // unblock the call ourselves
        await call;
        approver.dispose();
        dispose();
    });

    it('mints an Allow-once callBind cap over the connection', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const { client, dispose } = wire([admin.principal]);
        const approver = runManifestApprover({
            manifest: client.service('hub').get(hubAccessManifestInterface),
            issuer: new CapabilityProposalIssuer(admin),
            prompt: async () => ({ grant: true }),
            log: quiet,
        });

        const intent: AccessCallIntent = {
            method: 'hello::greeter::hello',
            params: { name: 'world' },
            nonce: 'nonce-xyz',
            signedAtMs: 1_700_000_000_000,
        };
        const perm: Permission & { callIntent: AccessCallIntent } = { ...PERMISSION, callIntent: intent };
        const res = await requestAccess(client, [perm], 'once');

        const cap = grantedCaps(res)[0]!;
        const expected = await computeCallBindHash(intent, PRINCIPAL);
        expect((cap.permissions[0] as Permission).callBind).toEqual({ alg: 'sha256', payloadHash: expected });

        approver.dispose();
        dispose();
    });
});

/** Narrow a granted requestAccess response to its capabilities. */
function grantedCaps(res: { status: string }): readonly SignedCapability[] {
    if (res.status !== 'granted' || !('capabilities' in res)) throw new Error(`expected granted, got ${res.status}`);
    return (res as { capabilities: SignedCapability[] }).capabilities;
}
