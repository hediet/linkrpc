import { jcsCanonicalize } from '@vscode/hubrpc';
import { observableValue, type IObservable, type ISettableObservable } from '@vscode/observables';
import type {
    ApprovalSnapshot,
    ApprovalSubscription,
    ApprovalDecisionOutcome,
    PendingApprovalRequest,
    PreparedApproval,
} from '../commands/approval';

export type ApprovalUiMode = 'browse' | 'approve' | 'deny' | 'help';
export type ApprovalUiMessageKind = 'info' | 'success' | 'error';

export interface ApprovalUiMessage {
    readonly kind: ApprovalUiMessageKind;
    readonly text: string;
}

export interface ApprovalUiClient {
    readonly principalId: string;
    watch(listener: (snapshot: ApprovalSnapshot) => void): ApprovalSubscription;
    refresh(): Promise<void>;
    prepareApproval(requestId: string): Promise<PreparedApproval>;
    approvePrepared(prepared: PreparedApproval): Promise<ApprovalDecisionOutcome>;
    deny(
        requestId: string,
        reason?: string,
        expected?: PendingApprovalRequest,
    ): Promise<ApprovalDecisionOutcome>;
}

export class ApprovalUiModel {
    private readonly _requests: ISettableObservable<readonly PendingApprovalRequest[]>;
    public readonly requests: IObservable<readonly PendingApprovalRequest[]>;
    private readonly _connectionState: ISettableObservable<ApprovalSnapshot['state']>;
    public readonly connectionState: IObservable<ApprovalSnapshot['state']>;
    private readonly _selectedRequestId: ISettableObservable<string | undefined>;
    public readonly selectedRequestId: IObservable<string | undefined>;
    private readonly _mode: ISettableObservable<ApprovalUiMode>;
    public readonly mode: IObservable<ApprovalUiMode>;
    private readonly _busy: ISettableObservable<boolean>;
    public readonly busy: IObservable<boolean>;
    private readonly _message: ISettableObservable<ApprovalUiMessage | undefined>;
    public readonly message: IObservable<ApprovalUiMessage | undefined>;
    private readonly _denialReason: ISettableObservable<string>;
    public readonly denialReason: IObservable<string>;
    private readonly _detailOffset: ISettableObservable<number>;
    public readonly detailOffset: IObservable<number>;
    private readonly _preparedApproval: ISettableObservable<PreparedApproval | undefined>;
    public readonly preparedApproval: IObservable<PreparedApproval | undefined>;

    private readonly _client: ApprovalUiClient;
    private readonly _subscription: ApprovalSubscription;
    private _disposed = false;

    constructor(client: ApprovalUiClient) {
        this._client = client;
        this._requests = observableValue(this, []);
        this.requests = this._requests;
        this._connectionState = observableValue(this, 'connecting');
        this.connectionState = this._connectionState;
        this._selectedRequestId = observableValue(this, undefined);
        this.selectedRequestId = this._selectedRequestId;
        this._mode = observableValue(this, 'browse');
        this.mode = this._mode;
        this._busy = observableValue(this, false);
        this.busy = this._busy;
        this._message = observableValue(this, undefined);
        this.message = this._message;
        this._denialReason = observableValue(this, '');
        this.denialReason = this._denialReason;
        this._detailOffset = observableValue(this, 0);
        this.detailOffset = this._detailOffset;
        this._preparedApproval = observableValue(this, undefined);
        this.preparedApproval = this._preparedApproval;
        this._subscription = client.watch((snapshot) => this._applySnapshot(snapshot));
    }

    public get principalId(): string {
        return this._client.principalId;
    }

    public get selectedRequest(): PendingApprovalRequest | undefined {
        const selectedId = this._selectedRequestId.get();
        return this._requests.get().find((item) => item.id === selectedId);
    }

    public selectBy(delta: number): void {
        if (this._busy.get() || this._mode.get() !== 'browse') return;
        const requests = this._requests.get();
        if (requests.length === 0) return;
        const currentIndex = Math.max(
            0,
            requests.findIndex((item) => item.id === this._selectedRequestId.get()),
        );
        const nextIndex = Math.max(0, Math.min(requests.length - 1, currentIndex + delta));
        if (nextIndex === currentIndex) return;
        this._selectedRequestId.set(requests[nextIndex].id, undefined);
        this._detailOffset.set(0, undefined);
    }

    public showHelp(): void {
        if (this._busy.get()) return;
        this._mode.set('help', undefined);
    }

    public async beginApprove(): Promise<void> {
        if (!this._canDecide()) return;
        const selected = this.selectedRequest;
        if (selected === undefined) return;
        this._busy.set(true, undefined);
        this._message.set({ kind: 'info', text: 'Resolving exact authority...' }, undefined);
        try {
            const prepared = await this._client.prepareApproval(selected.id);
            if (
                this.selectedRequest?.id !== selected.id
                || jcsCanonicalize(this.selectedRequest.request)
                    !== jcsCanonicalize(prepared.pending.request)
            ) {
                this._message.set({
                    kind: 'info',
                    text: 'The request changed while its authority was being resolved. Review it again.',
                }, undefined);
                return;
            }
            this._preparedApproval.set(prepared, undefined);
            this._detailOffset.set(0, undefined);
            this._mode.set('approve', undefined);
            this._message.set(undefined, undefined);
        } catch (error) {
            this._message.set({
                kind: 'error',
                text: error instanceof Error ? error.message : String(error),
            }, undefined);
        } finally {
            this._busy.set(false, undefined);
        }
    }

    public beginDeny(): void {
        if (!this._canDecide()) return;
        this._denialReason.set('', undefined);
        this._mode.set('deny', undefined);
    }

    public setDenialReason(reason: string): void {
        this._denialReason.set(reason, undefined);
    }

    public cancelMode(): void {
        if (this._busy.get()) return;
        this._mode.set('browse', undefined);
        this._denialReason.set('', undefined);
        this._preparedApproval.set(undefined, undefined);
    }

    public async confirmCurrentMode(): Promise<void> {
        const mode = this._mode.get();
        const selected = this.selectedRequest;
        if (this._busy.get() || selected === undefined || (mode !== 'approve' && mode !== 'deny')) return;

        this._busy.set(true, undefined);
        this._message.set({
            kind: 'info',
            text: mode === 'approve' ? 'Approving request...' : 'Denying request...',
        }, undefined);
        try {
            let outcome: ApprovalDecisionOutcome;
            if (mode === 'approve') {
                const prepared = this._preparedApproval.get();
                if (prepared === undefined) {
                    throw new Error('approval details are no longer available; review the request again');
                }
                outcome = await this._client.approvePrepared(prepared);
            } else {
                const reason = this._denialReason.get().trim();
                outcome = await this._client.deny(
                    selected.id,
                    reason.length > 0 ? reason : undefined,
                    selected,
                );
            }
            this._message.set({
                kind: outcome === 'applied' ? 'success' : 'info',
                text: outcome === 'applied'
                    ? `${mode === 'approve' ? 'Approved' : 'Denied'} ${selected.request.consumer.name}.`
                    : `Decision accepted for ${selected.request.consumer.name}, `
                        + 'but a matching request is still pending. The consumer may have retried.',
            }, undefined);
        } catch (error) {
            this._message.set({
                kind: 'error',
                text: error instanceof Error ? error.message : String(error),
            }, undefined);
        } finally {
            this._busy.set(false, undefined);
            this._mode.set('browse', undefined);
            this._denialReason.set('', undefined);
            this._preparedApproval.set(undefined, undefined);
        }
    }

    public async refresh(): Promise<void> {
        if (this._busy.get()) return;
        this._message.set({ kind: 'info', text: 'Refreshing approval requests...' }, undefined);
        try {
            await this._client.refresh();
            if (this._connectionState.get() === 'live') {
                this._message.set({ kind: 'info', text: 'Approval requests are up to date.' }, undefined);
            }
        } catch (error) {
            this._message.set({
                kind: 'error',
                text: error instanceof Error ? error.message : String(error),
            }, undefined);
        }
    }

    public scrollDetails(delta: number, lineCount: number, viewportSize: number): void {
        const maxOffset = Math.max(0, lineCount - Math.max(1, viewportSize));
        const next = Math.max(0, Math.min(maxOffset, this._detailOffset.get() + delta));
        this._detailOffset.set(next, undefined);
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._subscription.dispose();
    }

    private _canDecide(): boolean {
        if (this._busy.get() || this.selectedRequest === undefined) return false;
        if (this._connectionState.get() !== 'live') {
            this._message.set({
                kind: 'error',
                text: 'Cannot decide requests while the approval connection is stale.',
            }, undefined);
            return false;
        }
        return true;
    }

    private _applySnapshot(snapshot: ApprovalSnapshot): void {
        const previous = this._requests.get();
        const selectedId = this._selectedRequestId.get();
        const previousSelected = previous.find((item) => item.id === selectedId);
        const previousIndex = Math.max(0, previous.findIndex((item) => item.id === selectedId));
        const selectedStillExists = snapshot.requests.some((item) => item.id === selectedId);
        const nextSelected = snapshot.requests.find((item) => item.id === selectedId);
        const selectedChanged = previousSelected !== undefined
            && nextSelected !== undefined
            && jcsCanonicalize(previousSelected.request) !== jcsCanonicalize(nextSelected.request);

        this._requests.set(snapshot.requests, undefined);
        this._connectionState.set(snapshot.state, undefined);

        if (snapshot.requests.length === 0) {
            this._selectedRequestId.set(undefined, undefined);
            this._detailOffset.set(0, undefined);
        } else if (!selectedStillExists) {
            const nextIndex = Math.min(previousIndex, snapshot.requests.length - 1);
            this._selectedRequestId.set(snapshot.requests[nextIndex].id, undefined);
            this._detailOffset.set(0, undefined);
            this._preparedApproval.set(undefined, undefined);
        }

        if (
            ((!selectedStillExists && selectedId !== undefined) || selectedChanged)
            && this._mode.get() !== 'browse'
        ) {
            this._mode.set('browse', undefined);
            this._denialReason.set('', undefined);
            this._preparedApproval.set(undefined, undefined);
            this._message.set({
                kind: 'info',
                text: selectedChanged
                    ? 'The selected request changed. Review it again before deciding.'
                    : 'The selected request is no longer pending.',
            }, undefined);
        }
        if (snapshot.state === 'stale' && snapshot.error !== undefined) {
            this._message.set({ kind: 'error', text: snapshot.error }, undefined);
        }
    }
}
