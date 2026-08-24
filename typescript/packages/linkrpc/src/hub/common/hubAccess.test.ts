import type { SignedCapability } from '../../protocol';
import { describe, expect, it } from 'vitest';
import { findCoveringCapabilities, type HubAccessPermission } from './hubAccess';

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
        $linkrpcSignature: {},
    };
}
