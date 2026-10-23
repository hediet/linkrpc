import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LinkRpcConnection, TransportPair, createSeededMemoryPrincipal, issueCapability, directoryInterface, directoryWatchNever } from '@hediet/linkrpc';
import { connectViaTransport } from '@hediet/linkrpc-client-internal';
import { withForwardedCallGate } from '@hediet/linkrpc-hub/hub/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
    CallToolRequestSchema, JSONRPCMessageSchema, ListToolsRequestSchema,
    ToolListChangedNotificationSchema, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpForwardInterface } from '../mcpForward.interface';
import { mcpCommand } from './mcp';

const tool = (name: string): Tool => ({ name, inputSchema: { type: 'object' } });

describe('linkrpc hub mcp', () => {
    it('fails explicitly when the root directory is inaccessible', async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.register(directoryInterface, {
            list: () => { throw new Error('Discovery denied'); },
            watch: directoryWatchNever,
        });
        const local = connectViaTransport(pair.b);
        try {
            await expect(mcpCommand(local.channel, {
                input: new PassThrough(), output: new PassThrough(), log: () => {},
            })).rejects.toThrow('Hub directory inaccessible: Discovery denied');
        } finally { local.close(); hub.close(); }
    });

    it('cancels an initializing producer when agent stdin closes', async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        let started = false;
        let cancelled = false;
        hub.register(mcpForwardInterface, {
            connect: async (_params, _ctx, stream) => {
                started = true;
                await new Promise<void>(resolve => stream.signal.addEventListener('abort', () => {
                    cancelled = true;
                    resolve();
                }, { once: true }));
                return {};
            },
        }, { serviceId: 'slow' });
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        try {
            await vi.waitFor(() => expect(started).toBe(true));
            await f.close();
            await vi.waitFor(() => expect(cancelled).toBe(true));
        } finally { await f.close(); local.close(); hub.close(); }
    });

    it('aggregates paginated tools, routes images, watches changes, and closes only client sessions', async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        const first = forwarded(hub, 'machine/very-long-service-path/' + 'a'.repeat(100), [tool('screenshot'), tool('other')]);
        const second = forwarded(hub, 'machine/second', [tool('screenshot')]);
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        const changed = vi.fn();
        f.client.setNotificationHandler(ToolListChangedNotificationSchema, changed);
        try {
            const initial = await f.client.listTools();
            expect(initial.tools).toHaveLength(3);
            expect(new Set(initial.tools.map(t => t.name)).size).toBe(3);
            for (const t of initial.tools) {
                expect(t.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
            }
            const screenshot = initial.tools.find(t => t.description?.startsWith('[machine/second]'))!;
            expect(await f.client.callTool({ name: screenshot.name, arguments: { example: 42 } })).toEqual({
                content: [
                    { type: 'text', text: 'machine/second:{"example":42}' },
                    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
                ],
            });
            second.tools = [tool('replacement')];
            await second.servers[0].sendToolListChanged();
            await vi.waitFor(async () => {
                expect((await f.client.listTools()).tools.some(t => t.name.startsWith('replacement__'))).toBe(true);
            });
            expect(changed).toHaveBeenCalled();
            first.registration.dispose();
            await vi.waitFor(async () => { expect((await f.client.listTools()).tools).toHaveLength(1); });
            const third = forwarded(hub, 'machine/new-dynamic-id', [tool('screenshot')]);
            await vi.waitFor(async () => { expect((await f.client.listTools()).tools).toHaveLength(2); });
            await f.close();
            await vi.waitFor(() => {
                expect([first.active, second.active, third.active]).toEqual([0, 0, 0]);
            });
            const next = await consumer(local.channel);
            try {
                expect((await next.client.listTools()).tools).toHaveLength(2);
            } finally { await next.close(); }
        } finally {
            await f.close();
            local.close();
            hub.close();
        }
    });

    it('reports failed services without hiding healthy ones', async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        forwarded(hub, 'healthy', [tool('ok')]);
        hub.register(mcpForwardInterface, { connect: () => { throw new Error('Producer unavailable'); } }, { serviceId: 'broken' });
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        try {
            expect((await f.client.listTools()).tools.map(t => t.description)).toEqual(['[healthy] ok']);
            expect(f.logs.join('\n')).toContain('Producer unavailable');
        } finally {
            await f.close(); local.close(); hub.close();
        }
    });

    it('uses the selected signed channel and its capabilities for forwarded sessions', async () => {
        const root = await createSeededMemoryPrincipal({ seed: 801 });
        const principal = await createSeededMemoryPrincipal({ seed: 802 });
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(withForwardedCallGate(pair.a, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
        }));
        hub.enableReflection();
        forwarded(hub, 'private', [tool('signed')]);
        const local = connectViaTransport(pair.b);
        local.signing.principal = principal;
        await principal.capBag.add(await issueCapability(root.identity, {
            audience: principal.identity.publicSigningIdentity,
            expiresAtMs: Date.now() + 60_000,
            permissions: [{
                target: {
                    serviceId: { exact: 'private' },
                    interfaceId: { exact: mcpForwardInterface.info.id },
                    members: [{ exact: 'connect' }],
                },
                canInvoke: true,
            }],
        }));
        const f = await consumer(local.channel);
        try {
            const tools = (await f.client.listTools()).tools;
            expect(tools.map(t => t.description)).toEqual(['[private] signed']);
            expect((await f.client.callTool({ name: tools[0].name })).isError).not.toBe(true);
        } finally {
            await f.close(); local.close(); hub.close();
        }
    });

    it('reconnects a stopped MCP session while the producer remains advertised', async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        const producer = forwarded(hub, 'stable-producer', [tool('before')]);
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        try {
            await f.client.listTools();
            await producer.servers[0].close();
            await vi.waitFor(async () => { expect((await f.client.listTools()).tools).toHaveLength(0); });
            producer.tools = [tool('after')];
            await vi.waitFor(async () => {
                expect((await f.client.listTools()).tools.map(t => t.description)).toEqual(['[stable-producer] after']);
            }, { timeout: 8_000 });
            expect(producer.servers).toHaveLength(2);
        } finally {
            await f.close(); local.close(); hub.close();
        }
    }, 10_000);

    it('does not expose unauthorized forwarded tools', async () => {
        const root = await createSeededMemoryPrincipal({ seed: 803 });
        const principal = await createSeededMemoryPrincipal({ seed: 804 });
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(withForwardedCallGate(pair.a, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
        }));
        hub.enableReflection();
        const producer = forwarded(hub, 'private', [tool('secret')]);
        const local = connectViaTransport(pair.b);
        local.signing.principal = principal;
        const f = await consumer(local.channel);
        try {
            expect(await f.client.listTools()).toEqual({ tools: [] });
            expect(producer.active).toBe(0);
            expect(f.logs.join('\n')).toContain('Cannot connect to private');
        } finally {
            await f.close(); local.close(); hub.close();
        }
    });
});

async function consumer(channel: Parameters<typeof mcpCommand>[0]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];
    const running = mcpCommand(channel, { input, output, log: line => logs.push(line) });
    const client = new Client({ name: 'agent-test', version: '1' });
    await client.connect(new StdioServerTransport(output, input));
    return {
        client, logs,
        close: async () => {
            input.end();
            await running;
            await client.close();
        },
    };
}

function forwarded(hub: LinkRpcConnection, serviceId: string, tools: Tool[]) {
    const state = { tools, servers: [] as Server[], active: 0 };
    const registration = hub.register(mcpForwardInterface, {
        connect: async (_params, _ctx, stream) => {
            state.active++;
            const server = new Server({ name: serviceId, version: '1' }, { capabilities: { tools: { listChanged: true } } });
            state.servers.push(server);
            server.setRequestHandler(ListToolsRequestSchema, request => {
                const index = Number(request.params?.cursor ?? 0);
                return {
                    tools: state.tools.slice(index, index + 1),
                    ...(index + 1 < state.tools.length ? { nextCursor: String(index + 1) } : {}),
                };
            });
            server.setRequestHandler(CallToolRequestSchema, request => ({
                content: [
                    { type: 'text', text: `${serviceId}:${JSON.stringify(request.params.arguments ?? {})}` },
                    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
                ],
            }));
            try {
                await new Promise<void>((resolve, reject) => {
                    const transport: Transport = {
                        start: async () => {},
                        send: async message => { stream.send({ frame: message }); },
                        close: async () => { transport.onclose?.(); resolve(); },
                    };
                    stream.onMessage(({ frame }) => transport.onmessage?.(JSONRPCMessageSchema.parse(frame)));
                    stream.signal.addEventListener('abort', () => { void server.close().catch(reject); }, { once: true });
                    void server.connect(transport).catch(reject);
                });
            } finally {
                state.active--;
            }
            return {};
        },
    }, { serviceId });
    return Object.assign(state, { registration });
}
