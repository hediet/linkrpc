import { describe, expect, it, vi } from 'vitest';
import type { HubAccessManifestRequest } from '@hediet/linkrpc/hub/common';
import type { ApprovalSnapshot, PendingApprovalRequest } from '../commands/approval';
import { ApprovalUiModel, type ApprovalUiClient } from './ApprovalUiModel';

describe('ApprovalUiModel', () => {
    it('preserves selection across live updates and selects the nearest request when it disappears', () => {
        const client = new FakeApprovalUiClient();
        const model = new ApprovalUiModel(client);
        try {
            client.emit(snapshot([pending('a', 'Alpha'), pending('b', 'Beta'), pending('c', 'Gamma')]));
            model.selectBy(1);
            expect(model.selectedRequest?.id).toBe('b');

            client.emit(snapshot([pending('x', 'New'), pending('b', 'Beta'), pending('c', 'Gamma')]));
            expect(model.selectedRequest?.id).toBe('b');

            client.emit(snapshot([pending('x', 'New'), pending('c', 'Gamma')]));
            expect(model.selectedRequest?.id).toBe('c');
        } finally {
            model.dispose();
        }
    });

    it('requires a live snapshot and explicit confirmation before approving', async () => {
        const client = new FakeApprovalUiClient();
        const model = new ApprovalUiModel(client);
        try {
            client.emit(snapshot([pending('a', 'Alpha')], 'stale', 'connection lost'));
            await model.beginApprove();
            expect(model.mode.get()).toBe('browse');
            expect(model.message.get()?.kind).toBe('error');

            client.emit(snapshot([pending('a', 'Alpha')]));
            await model.beginApprove();
            expect(model.mode.get()).toBe('approve');
            expect(client.approvePrepared).not.toHaveBeenCalled();

            await model.confirmCurrentMode();
            expect(client.approvePrepared).toHaveBeenCalledWith(
                expect.objectContaining({ pending: expect.objectContaining({ id: 'a' }) }),
            );
            expect(model.mode.get()).toBe('browse');
            expect(model.message.get()).toEqual({ kind: 'success', text: 'Approved Alpha.' });
        } finally {
            model.dispose();
        }
    });

    it('trims optional denial reasons and surfaces decision failures', async () => {
        const client = new FakeApprovalUiClient();
        const model = new ApprovalUiModel(client);
        try {
            client.emit(snapshot([pending('a', 'Alpha')]));
            model.beginDeny();
            model.setDenialReason('  not expected  ');
            await model.confirmCurrentMode();
            expect(client.deny).toHaveBeenCalledWith(
                'a',
                'not expected',
                expect.objectContaining({ id: 'a', revision: 1 }),
            );

            client.deny.mockRejectedValueOnce(new Error('manifest rejected the decision'));
            client.emit(snapshot([pending('b', 'Beta')]));
            model.beginDeny();
            await model.confirmCurrentMode();
            expect(client.deny).toHaveBeenLastCalledWith(
                'b',
                undefined,
                expect.objectContaining({ id: 'b', revision: 1 }),
            );
            expect(model.message.get()).toEqual({
                kind: 'error',
                text: 'manifest rejected the decision',
            });
        } finally {
            model.dispose();
        }
    });

    it('cancels confirmation if another approver removes the selected request', async () => {
        const client = new FakeApprovalUiClient();
        const model = new ApprovalUiModel(client);
        try {
            client.emit(snapshot([pending('a', 'Alpha'), pending('b', 'Beta')]));
            await model.beginApprove();
            client.emit(snapshot([pending('b', 'Beta')]));

            expect(model.mode.get()).toBe('browse');
            expect(model.selectedRequest?.id).toBe('b');
            expect(model.message.get()?.text).toBe('The selected request is no longer pending.');
        } finally {
            model.dispose();
        }
    });
});

class FakeApprovalUiClient implements ApprovalUiClient {
    public readonly principalId = 'id:key:approver';
    public readonly refresh = vi.fn(async () => { });
    public readonly prepareApproval = vi.fn(async (requestId: string) => {
        const pendingRequest = this.currentRequests.find((item) => item.id === requestId);
        if (pendingRequest === undefined) throw new Error('request not found');
        return {
            pending: pendingRequest,
            permissions: pendingRequest.request.kind === 'direct' ? pendingRequest.request.permissions : [],
        };
    });
    public readonly approvePrepared = vi.fn(async () => 'applied' as const);
    public readonly deny = vi.fn(async (
        _requestId: string,
        _reason?: string,
        _expected?: PendingApprovalRequest,
    ) => 'applied' as const);
    private listener: ((snapshot: ApprovalSnapshot) => void) | undefined;
    private currentRequests: readonly PendingApprovalRequest[] = [];

    public watch(listener: (snapshot: ApprovalSnapshot) => void) {
        this.listener = listener;
        listener(snapshot([], 'connecting'));
        return {
            dispose: () => {
                if (this.listener === listener) this.listener = undefined;
            },
        };
    }

    public emit(value: ApprovalSnapshot): void {
        this.currentRequests = value.requests;
        this.listener?.(value);
    }
}

function snapshot(
    requests: readonly PendingApprovalRequest[],
    state: ApprovalSnapshot['state'] = 'live',
    error?: string,
): ApprovalSnapshot {
    return { state, requests, ...(error === undefined ? {} : { error }) };
}

function pending(id: string, name: string): PendingApprovalRequest {
    const request: HubAccessManifestRequest = {
        kind: 'direct',
        consumer: { name, principal: `id:key:${name.toLowerCase()}` },
        permissions: [{
            target: {
                serviceId: { exact: 'calendar' },
                interfaceId: { exact: 'events' },
                members: [{ exact: 'create' }],
            },
            canInvoke: true,
        }],
        duration: 'session',
    };
    return { id, request, revision: 1 };
}
