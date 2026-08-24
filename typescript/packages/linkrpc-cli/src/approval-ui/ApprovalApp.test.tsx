import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { render, type Instance } from 'ink';
import type { HubAccessManifestRequest } from '@hediet/linkrpc/hub/common';
import type { ApprovalSnapshot, PendingApprovalRequest } from '../commands/approval';
import { ApprovalApp, approvalDetailLines, safeTerminalText } from './ApprovalApp';
import { ApprovalUiModel, type ApprovalUiClient } from './ApprovalUiModel';

describe('ApprovalApp', () => {
    const mounted: Instance[] = [];

    afterEach(() => {
        for (const instance of mounted.splice(0)) instance.unmount();
    });

    it.each([
        { columns: 120, rows: 24, expected: 'Request details' },
        { columns: 72, rows: 12, expected: 'Hub approvals' },
    ])('renders a bounded approval view at $columns x $rows', async ({ columns, rows, expected }) => {
        const client = new RenderClient([pending('request-1', 'Calendar agent')]);
        const model = new ApprovalUiModel(client);
        const terminal = createTerminal(columns, rows);
        const instance = render(<ApprovalApp model={model} />, {
            stdout: terminal.stdout,
            stdin: terminal.stdin,
            stderr: terminal.stderr,
            debug: true,
            exitOnCtrlC: false,
            patchConsole: false,
        });
        mounted.push(instance);

        await new Promise((resolve) => setTimeout(resolve, 50));
        const frame = terminal.output.join('');
        expect(frame).toContain(expected);
        expect(frame).toContain('Calendar agent');
        expect(frame).toContain('1 pending');
        expect(frame).not.toContain('ERROR');
        model.dispose();
    });

    it('shows the exact signed authority before enabling confirmation', async () => {
        const client = new RenderClient([pending('request-1', 'Calendar agent')]);
        const model = new ApprovalUiModel(client);
        const terminal = createTerminal(120, 24);
        const instance = render(<ApprovalApp model={model} />, {
            stdout: terminal.stdout,
            stdin: terminal.stdin,
            stderr: terminal.stderr,
            debug: true,
            exitOnCtrlC: false,
            patchConsole: false,
        });
        mounted.push(instance);

        terminal.stdin.push('a');
        await new Promise((resolve) => setTimeout(resolve, 75));

        const frame = terminal.output.join('');
        expect(client.prepareCalls).toBe(1);
        expect(frame).toContain('Exact authority to be signed');
        expect(frame).toContain('Actions 1: invoke');
        expect(frame).toContain('Parameters: any');
        expect(frame).toContain('Enter confirm');
        model.dispose();
    });

    it('does not permit blind decisions in a short terminal', async () => {
        const client = new RenderClient([pending('request-1', 'Calendar agent')]);
        const model = new ApprovalUiModel(client);
        const terminal = createTerminal(72, 8);
        const instance = render(<ApprovalApp model={model} />, {
            stdout: terminal.stdout,
            stdin: terminal.stdin,
            stderr: terminal.stderr,
            debug: true,
            exitOnCtrlC: false,
            patchConsole: false,
        });
        mounted.push(instance);

        terminal.stdin.push('a');
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(client.prepareCalls).toBe(0);
        expect(terminal.output.join('')).toContain('Enlarge to at least 13 rows');
        model.dispose();
    });

    it('requires reviewing overflowed authority before confirmation', async () => {
        const client = new RenderClient([pending('request-1', 'Calendar agent')]);
        const model = new ApprovalUiModel(client);
        const terminal = createTerminal(120, 13);
        const instance = render(<ApprovalApp model={model} />, {
            stdout: terminal.stdout,
            stdin: terminal.stdin,
            stderr: terminal.stderr,
            debug: true,
            exitOnCtrlC: false,
            patchConsole: false,
        });
        mounted.push(instance);

        terminal.stdin.push('a');
        await new Promise((resolve) => setTimeout(resolve, 50));
        terminal.stdin.push('\r');
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(client.approveCalls).toBe(0);
        expect(terminal.output.join('')).toContain('review all authority before confirming');

        terminal.stdin.push('\u001b[6~');
        await new Promise((resolve) => setTimeout(resolve, 25));
        terminal.stdin.push('\r');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(client.approveCalls).toBe(1);
        model.dispose();
    });

    it('escapes terminal controls from untrusted manifest text', () => {
        expect(safeTerminalText('Agent\u001b[2J\u202espoof')).toBe(
            'Agent\\u{001b}[2J\\u{202e}spoof',
        );
    });

    it('renders pattern kinds and one-shot call details unambiguously', () => {
        const base = pending('request-1', 'Calendar agent');
        if (base.request.kind !== 'direct') throw new Error('expected direct request');
        const reviewed: PendingApprovalRequest = {
            ...base,
            request: {
                ...base.request,
                duration: 'once',
                permissions: [
                    {
                        target: {
                            serviceId: { exact: 'calendar*' },
                            interfaceId: { exact: 'events' },
                            members: [{ exact: 'remove' }],
                        },
                        canInvoke: true,
                        callIntent: {
                            method: 'calendar::events::remove',
                            params: { eventId: '42' },
                            nonce: 'nonce',
                            signedAtMs: 1,
                            summary: 'Delete event 42',
                        },
                    },
                    {
                        target: {
                            serviceId: { prefix: 'calendar' },
                            interfaceId: { exact: 'events' },
                            members: [{ exact: 'list' }],
                        },
                        canDelegate: true,
                    },
                ],
            },
        };
        const lines = approvalDetailLines(reviewed, {
            pending: reviewed,
            permissions: reviewed.request.permissions.map(({ callIntent: _callIntent, ...permission }) => permission),
        });
        const text = lines.map((line) => `${line.label ?? ''} ${line.text}`).join('\n');

        expect(text).toContain('exact("calendar*")');
        expect(text).toContain('prefix("calendar")');
        expect(text).toContain('Call summary Delete event 42');
        expect(text).toContain('Call method calendar::events::remove');
        expect(text).toContain('Call parameters {"eventId":"42"}');
    });

    it('renders discover member patterns and the manifest source', () => {
        const item: PendingApprovalRequest = {
            id: 'request-1',
            revision: 1,
            sourceServiceId: 'de.hediet/cloud/ext/personal-bot-services/auth',
            request: {
                kind: 'discover',
                consumer: { name: 'telegram-service', principal: 'id:key:telegram' },
                interfaces: [{ id: 'secret-store' }],
                members: [
                    { interfaceId: 'secret-store', member: { exact: 'seal' } },
                    { interfaceId: 'secret-store', member: { prefix: 'read' }, required: false },
                ],
                duration: 'persistent',
            },
        };
        const text = approvalDetailLines(item)
            .map((line) => `${line.label ?? ''} ${line.text}`)
            .join('\n');

        expect(text).toContain(
            'Manifest source de.hediet/cloud/ext/personal-bot-services/auth',
        );
        expect(text).toContain('secret-store::exact("seal")');
        expect(text).toContain('secret-store::prefix("read") (optional)');
        expect(text).not.toContain('[object Object]');
    });
});

class RenderClient implements ApprovalUiClient {
    public readonly principalId = 'id:key:approver';
    public prepareCalls = 0;
    public approveCalls = 0;

    constructor(private readonly requests: readonly PendingApprovalRequest[]) { }

    public watch(listener: (snapshot: ApprovalSnapshot) => void) {
        listener({ state: 'live', requests: this.requests });
        return { dispose: () => { } };
    }

    public async refresh(): Promise<void> { }
    public async prepareApproval(requestId: string) {
        this.prepareCalls++;
        const pendingRequest = this.requests.find((item) => item.id === requestId);
        if (pendingRequest === undefined) throw new Error('request not found');
        return {
            pending: pendingRequest,
            permissions: pendingRequest.request.kind === 'direct' ? pendingRequest.request.permissions : [],
        };
    }
    public async approvePrepared() {
        this.approveCalls++;
        return 'applied' as const;
    }
    public async deny(_requestId: string, _reason?: string) {
        return 'applied' as const;
    }
}

function createTerminal(columns: number, rows: number): {
    stdout: NodeJS.WriteStream;
    stdin: NodeJS.ReadStream;
    stderr: NodeJS.WriteStream;
    output: string[];
} {
    const output: string[] = [];
    const stdout = Object.assign(new PassThrough(), { columns, rows, isTTY: true });
    const stderr = Object.assign(new PassThrough(), { columns, rows, isTTY: true });
    const stdin = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: () => stdin,
        ref: () => stdin,
        unref: () => stdin,
    });
    stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    return {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        output,
    };
}

function pending(id: string, name: string): PendingApprovalRequest {
    const request: HubAccessManifestRequest = {
        kind: 'direct',
        consumer: {
            name,
            principal: 'id:key:calendar-agent',
            purpose: 'Create calendar events requested by the operator.',
        },
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
