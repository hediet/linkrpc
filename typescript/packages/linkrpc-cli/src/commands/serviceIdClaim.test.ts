import { describe, expect, it } from 'vitest';
import type { CliConnection } from '@hediet/linkrpc-client-internal';
import { claimServiceId, localNamespace, resolveServiceIdToClaim } from './serviceIdClaim';

function fakeHub(grantedServiceIdNamespace: string) {
    const calls: Array<{ method: string; params: unknown }> = [];
    const local = {
        channel: {
            sendRequest: async (method: string, params: unknown) => {
                calls.push({ method, params });
                if (method === 'hubGrantedServiceId::get') return { grantedServiceIdNamespace };
                if (method === 'hubGrantedServiceId::getHubServiceId') return { hubServiceId: 'hub' };
                return {};
            },
        },
    } as unknown as CliConnection;
    return { local, calls };
}

describe('service ids to claim', () => {
    it('resolves ./<name> under the granted namespace', async () => {
        const { local } = fakeHub('me/agent');
        expect(await resolveServiceIdToClaim(local, './notes')).toEqual({ serviceId: 'me/agent/notes', relative: 'notes' });
        expect(await resolveServiceIdToClaim(local, 'other/notes')).toEqual({ serviceId: 'other/notes' });
        expect(await resolveServiceIdToClaim(local, undefined)).toEqual({ serviceId: 'me/agent' });
        await expect(resolveServiceIdToClaim(local, './')).rejects.toThrow('invalid relative serviceId: ./');
    });

    it('makes up a namespace for this user and host without a granted one', async () => {
        const { local } = fakeHub('');
        expect(localNamespace()).toMatch(/^[A-Za-z0-9_-]+@[A-Za-z0-9_-]+$/);
        expect(await resolveServiceIdToClaim(local, './notes'))
            .toEqual({ serviceId: `${localNamespace()}/notes`, relative: 'notes' });
        await expect(resolveServiceIdToClaim(local, undefined)).rejects.toThrow('no granted serviceId namespace');
    });

    it('claims within the granted namespace directly and elsewhere through the hub registry', async () => {
        const inside = fakeHub('me');
        await claimServiceId(inside.local, 'me/notes');
        expect(inside.calls.at(-1)).toEqual({ method: 'hubGrantedServiceId::register', params: { serviceId: 'me/notes' } });

        const outside = fakeHub('');
        await claimServiceId(outside.local, 'someone@host/notes');
        expect(outside.calls.at(-1)).toEqual({
            method: 'hub::hubServiceIdRegistry::registerServiceId',
            params: { requestedPrefix: 'someone@host/notes' },
        });
    });
});
