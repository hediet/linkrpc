import {
    ApprovalClient,
    createHubApprovalClient,
    type ApprovalSnapshot,
    type ApprovalDecisionOutcome,
    type PendingApprovalRequest,
    type ConsentPrompt,
} from '@hediet/linkrpc-infra/approval';
import { createTerminalConsentPrompt } from '@hediet/linkrpc-hub';
import { autorun } from '@vscode/observables';
import { createApprovalPresentation } from '../approvalPresentation';
import { formatJson } from '../output';

export interface ApprovalSubscription {
    dispose(): void;
}

/** Terminal prompt and callback adapter for the CLI's approval UI. */
export class ApprovalCommandClient extends ApprovalClient {
    public watch(listener: (snapshot: ApprovalSnapshot) => void): ApprovalSubscription {
        return autorun((reader) => listener(this.snapshot.read(reader)));
    }

    public override runInteractive(
        signal: AbortSignal,
        prompt: ConsentPrompt = createTerminalConsentPrompt(),
    ): Promise<void> {
        return super.runInteractive(signal, prompt);
    }
}

export function createHubApprovalCommandClient(
    ...args: Parameters<typeof createHubApprovalClient>
): ApprovalCommandClient {
    const client = createHubApprovalClient(...args);
    const runInteractive = client.runInteractive.bind(client);
    return Object.assign(client, {
        watch: (listener: (snapshot: ApprovalSnapshot) => void): ApprovalSubscription =>
            autorun((reader) => listener(client.snapshot.read(reader))),
        runInteractive: (
            signal: AbortSignal,
            prompt: ConsentPrompt = createTerminalConsentPrompt(),
        ): Promise<void> => runInteractive(signal, prompt),
    });
}

export function formatApprovalRequests(
    requests: readonly PendingApprovalRequest[],
    principalId: string,
    json = false,
): string {
    if (json) {
        return formatJson({
            version: 1,
            principal: principalId,
            requests: requests.map(({ id, request }) => ({ id, request })),
        });
    }
    if (requests.length === 0) {
        return `No pending approval requests for ${principalId}.`;
    }
    const lines: string[] = [];
    for (const request of requests) {
        const presentation = createApprovalPresentation(request);
        lines.push(presentation.heading);
        for (const detail of presentation.details) {
            lines.push(`  ${detail.label === undefined ? '' : `${detail.label}: `}${detail.text}`);
        }
    }
    return lines.join('\n');
}

export function formatApprovalDecision(
    action: 'approved' | 'denied',
    id: string,
    principalId: string,
    json = false,
    outcome: ApprovalDecisionOutcome = 'applied',
): string {
    if (json) {
        return formatJson({
            version: 1,
            action,
            id,
            principal: principalId,
            ...(outcome === 'still-pending' ? { requestStillPending: true } : {}),
        });
    }
    return outcome === 'applied'
        ? `${action === 'approved' ? 'Approved' : 'Denied'} ${id}.`
        : `${action === 'approved' ? 'Approval' : 'Denial'} decision accepted for ${id}, `
            + 'but a matching request is still pending; the consumer may have retried.';
}
