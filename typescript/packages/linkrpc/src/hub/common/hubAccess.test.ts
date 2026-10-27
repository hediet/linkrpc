import type { SignedCapability } from '../../protocol';
import { describe, expect, it } from 'vitest';
import { findCoveringCapabilities, type HubAccessPermission } from './hubAccess';
import { signedHash } from '../../identity/signedObject';

const NOW = 1_000_000;

describe('findCoveringCapabilities', () => {
    const requested: HubAccessPermission[] = [{
        target: {
            serviceId: { prefix: 'embedded/parent/child' },
            interfaceId: { exact: 'sample.secure-issue-modal' },
            interfaceHash: 'sha256:interface',
            members: [{ exact: 'createDraftIssue' }],
        },
        canInvoke: true,
    }];

    it('does not treat an empty request as an already-granted request', () => {
        expect(findCoveringCapabilities([], [], { nowMs: NOW })).toBeUndefined();
    });

    it('reuses a persistent hash-pinned relationship-prefix grant', () => {
        const capability = cap({
            serviceId: { prefix: 'embedded/parent/child' },
            interfaceId: { exact: 'sample.secure-issue-modal' },
            interfaceHash: 'sha256:interface',
            members: [{ exact: 'createDraftIssue' }],
        });

        expect(findCoveringCapabilities([capability], requested, {
            nowMs: NOW,
            freshnessMarginMs: 2000,
        })).toEqual([capability]);
    });

    it('accepts broader cached patterns', () => {
        const capability = cap({
            serviceId: { prefix: 'embedded/parent' },
            interfaceId: { prefix: 'sample' },
            members: [{ prefix: 'create' }],
        });

        expect(findCoveringCapabilities([capability], requested, {
            nowMs: NOW,
        })).toEqual([capability]);
    });

    it('reuses broader parameter scopes independent of key and enum order', () => {
        const capability = cap({ ...requested[0].target, members: [...requested[0].target.members] });
        capability.permissions[0].params = {
            path: { prefix: '/docs/' }, mode: { enum: ['json', 'text'] },
            tags: { subsetOf: ['a', 'b'] }, value: { any: true },
        };
        const permission: HubAccessPermission = {
            ...requested[0],
            params: {
                value: { exact: 42 }, mode: { enum: ['text', 'json'] },
                path: { prefix: '/docs/public/' }, tags: { subsetOf: ['a'] },
            },
        };
        expect(findCoveringCapabilities([capability], [permission], { nowMs: NOW })).toEqual([capability]);
        expect(findCoveringCapabilities([capability], [{
            ...permission, params: { ...permission.params, path: { prefix: '/' } },
        }], { nowMs: NOW })).toBeUndefined();
        expect(findCoveringCapabilities([capability], [{
            ...permission, params: { ...permission.params, mode: { enum: ['xml'] } },
        }], { nowMs: NOW })).toBeUndefined();
        expect(findCoveringCapabilities([capability], [{
            ...permission, params: { ...permission.params, extra: { any: true } },
        }], { nowMs: NOW })).toBeUndefined();
    });

    it('reuses a range grant for values and narrower ranges inside it', () => {
        const capability = cap({ ...requested[0].target, members: [...requested[0].target.members] });
        capability.permissions[0].params = { port: { range: { min: 3000, max: 3999 } } };
        const covers = (port: HubAccessPermission['params'] & object) =>
            findCoveringCapabilities([capability], [{ ...requested[0], params: port }], { nowMs: NOW }) !== undefined;
        expect({
            exact: covers({ port: { exact: 3000 } }),
            enum: covers({ port: { enum: [3001, 3999] } }),
            narrowerRange: covers({ port: { range: { min: 3100, max: 3200 } } }),
            outsideExact: covers({ port: { exact: 4000 } }),
            overlappingRange: covers({ port: { range: { min: 3500, max: 4500 } } }),
            nonNumber: covers({ port: { exact: '3000' } }),
        }).toEqual({
            exact: true, enum: true, narrowerRange: true,
            outsideExact: false, overlappingRange: false, nonNumber: false,
        });
    });

    it('rejects sibling, stale, narrower, and one-shot grants', () => {
        const target = {
            serviceId: { prefix: 'embedded/parent/child' } as const,
            interfaceId: { exact: 'sample.secure-issue-modal' } as const,
            interfaceHash: 'sha256:interface',
            members: [{ exact: 'createDraftIssue' } as const],
        };
        const cases: SignedCapability[] = [
            cap({ ...target, serviceId: { prefix: 'embedded/parent/sibling' } }),
            cap({ ...target, interfaceHash: 'sha256:old-interface' }),
            cap({ ...target, members: [{ exact: 'otherMethod' }] }),
            cap(target, { expiresAtMs: NOW + 1000 }),
            cap(target, { callBind: { alg: 'sha256', payloadHash: 'hash' } }),
        ];

        for (const capability of cases) {
            expect(findCoveringCapabilities([capability], requested, {
                nowMs: NOW,
                freshnessMarginMs: 2000,
            })).toBeUndefined();
        }
    });

    it('returns all ancestors and rejects incomplete, stale or overbroad chains', () => {
        const target = {
            serviceId: { prefix: 'embedded/parent' } as const,
            interfaceId: { prefix: 'sample' } as const,
            members: [{ prefix: 'create' } as const],
        };
        const parent = cap(target);
        parent.permissions[0].canDelegate = true;
        parent.audience = 'delegate';
        const leaf = { ...cap(target), issuer: 'delegate', parentHash: signedHash('capability', parent) };
        const options = { nowMs: NOW, audience: 'audience' };
        expect(findCoveringCapabilities([leaf, parent], requested, options)).toEqual([leaf, parent]);
        expect(findCoveringCapabilities([leaf], requested, options)).toBeUndefined();
        expect(findCoveringCapabilities([parent], requested, options)).toBeUndefined();
        for (const changed of [
            { ...parent, expiresAtMs: NOW - 1 },
            { ...parent, audience: 'someone-else' },
            { ...parent, permissions: [{ ...parent.permissions[0], canDelegate: false }] },
            { ...parent, permissions: [{ ...parent.permissions[0], target: { ...target, members: [{ exact: 'other' }] } }] },
        ]) {
            const chained = { ...leaf, parentHash: signedHash('capability', changed) };
            expect(findCoveringCapabilities([chained, changed], requested, options)).toBeUndefined();
        }
    });
});

function cap(
    target: SignedCapability['permissions'][number]['target'],
    options: {
        readonly expiresAtMs?: number;
        readonly callBind?: SignedCapability['permissions'][number]['callBind'];
    } = {},
): SignedCapability {
    return {
        issuer: 'issuer',
        audience: 'audience',
        nonce: 'nonce',
        ...(options.expiresAtMs !== undefined ? { expiresAtMs: options.expiresAtMs } : {}),
        permissions: [{
            target,
            canInvoke: true,
            ...(options.callBind !== undefined ? { callBind: options.callBind } : {}),
        }],
        $hubrpcSignature: {},
    };
}
