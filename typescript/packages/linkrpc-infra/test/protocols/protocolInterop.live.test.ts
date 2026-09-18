import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
    LinkRpcConnection,
    JsonRpcChannel,
    traceMessageTransport,
    type JsonRpcMessage,
} from '@hediet/linkrpc';
import { createCdpWebSocketTransport, type CdpWebSocketLike } from './cdp';
import {
    importCdpProtocol,
    importLspProtocol,
} from './contracts/index';
import {
    createGeneratedProtocolBareTarget,
    createGeneratedProtocolInterfaceDefinition,
} from './contracts/generated';
import { createLspChildProcessTransport } from './lsp';
import { startInspector, startLanguageServer } from './protocolInteropTestUtils';
import type { CloseAwareMessageTransport } from '../../src/json-rpc/messageTransport';

type Contract = ReturnType<typeof importCdpProtocol>;
type Direction = 'clientToServer' | 'serverToClient';

const corpusRoot = new URL('../../../../../conformance/protocols/', import.meta.url);
const cdp = importCdpProtocol(
    readJson('cdp-0.0.1677763/browser_protocol.json'),
    readJson('cdp-0.0.1677763/js_protocol.json'),
);
const lsp = importLspProtocol(readJson('lsp-3.17.5/metaModel.json'));

describe('live external protocol interoperability', () => {
    it('calls an unmodified Node inspector using schema-derived clients and events', async () => {
        const inspector = await startInspector();
        let connection: LinkRpcConnection | undefined;
        let transport: ReturnType<typeof createCdpWebSocketTransport> | undefined;
        try {
            const socket = await openSocket(inspector.url);
            const sent: unknown[] = [];
            const observedSocket: CdpWebSocketLike = {
                get readyState() { return socket.readyState; },
                send(text) {
                    sent.push(JSON.parse(text));
                    socket.send(text);
                },
                close: () => socket.close(),
                addEventListener: socket.addEventListener.bind(socket),
                removeEventListener: socket.removeEventListener.bind(socket),
            };
            transport = createCdpWebSocketTransport(observedSocket);
            connection = protocolConnection(transport.root);
            const runtimeBinding = selectMember(cdp, 'Runtime.evaluate', 'clientToServer');
            const cdpRuntime = createGeneratedProtocolBareTarget(
                runtimeBinding.definition.toSchema(),
                runtimeBinding.prefix,
            );
            const runtime = connection.get(cdpRuntime);
            const consoleEvent = receiveNotification(connection, cdp, 'Runtime.consoleAPICalled');
            await within(Promise.resolve(runtime.enable({})), 'Runtime.enable');
            const result = await within(Promise.resolve(runtime.evaluate({
                expression: 'console.log("linkrpc-interop"); 6 * 7',
                returnByValue: true,
            })), 'Runtime.evaluate');
            expect(result).toMatchObject({ result: { type: 'number', value: 42 } });
            expect(await within(consoleEvent, 'Runtime.consoleAPICalled')).toMatchObject({
                type: 'log',
                args: [expect.objectContaining({ value: 'linkrpc-interop' })],
            });
            expect(sent).toEqual(expect.arrayContaining([
                expect.objectContaining({ method: 'Runtime.enable' }),
                expect.objectContaining({ method: 'Runtime.evaluate' }),
            ]));
            for (const frame of sent) {
                expect(frame).not.toHaveProperty('jsonrpc');
                expect(JSON.stringify(frame)).not.toMatch(/"\$(?:hubrpc|stream)/);
            }
        } finally {
            connection?.close();
            transport?.close();
            await inspector.stop();
        }
    }, 30_000);

    it('initializes a real LSP server, reads symbols and diagnostics, and shuts down', async () => {
        const server = await startLanguageServer();
        const sent: JsonRpcMessage[] = [];
        const transport = createLspChildProcessTransport(server.child);
        const connection = protocolConnection(transport,
            (direction, frame) => {
                if (direction === 'send') sent.push(frame);
            },
        );
        try {
            const initialized = await within(call(connection, lsp, 'initialize', {
                processId: process.pid,
                rootUri: null,
                capabilities: {
                    textDocument: {
                        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    },
                },
                workspaceFolders: null,
            }), 'initialize');
            expect(initialized).toHaveProperty('capabilities.documentSymbolProvider');
            await call(connection, lsp, 'initialized', {});
            const uri = 'file:///linkrpc-interop.json';
            await call(connection, lsp, 'textDocument/didOpen', {
                textDocument: {
                    uri,
                    languageId: 'json',
                    version: 1,
                    text: '{"answer": 42}',
                },
            });
            const symbols = await within(call(connection, lsp, 'textDocument/documentSymbol', {
                textDocument: { uri },
            }), 'textDocument/documentSymbol');
            expect(symbols).toEqual(expect.arrayContaining([
                expect.objectContaining({ name: 'answer' }),
            ]));

            const diagnostics = receiveNotification(
                connection,
                lsp,
                'textDocument/publishDiagnostics',
                (value) => isRecord(value) && Array.isArray(value.diagnostics)
                    && value.diagnostics.length > 0,
            );
            await call(connection, lsp, 'textDocument/didChange', {
                textDocument: { uri, version: 2 },
                contentChanges: [{ text: '{"answer": }' }],
            });
            expect(await within(diagnostics, 'publishDiagnostics')).toMatchObject({
                uri,
                diagnostics: expect.arrayContaining([expect.objectContaining({ severity: 1 })]),
            });
            expect(await within(call(connection, lsp, 'shutdown', undefined), 'shutdown')).toBeNull();
            const exited = once(server.child, 'exit');
            await call(connection, lsp, 'exit', undefined);
            const [code, signal] = await within(exited, `LSP exit (${server.stderr()})`);
            expect({ code, signal }).toEqual({ code: 0, signal: null });
            for (const frame of sent) {
                expect(frame.jsonrpc).toBe('2.0');
                expect(JSON.stringify(frame)).not.toMatch(/"\$(?:hubrpc|stream)/);
            }
        } finally {
            connection.close();
            await server.stop();
        }
    }, 30_000);
});

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(new URL(path, corpusRoot), 'utf8'));
}

function selectMember(contract: Contract, wireMethod: string, direction: Direction) {
    const binding = contract.bindings.find((entry) =>
        entry.wireMethod === wireMethod && entry.direction === direction);
    if (!binding) throw new Error(`Missing imported binding for ${direction} ${wireMethod}`);
    const schema = contract.interfaces[binding.interfaceId];
    const method = schema?.methods[binding.member];
    if (!method || !wireMethod.endsWith(binding.member)) {
        throw new Error(`Invalid imported binding for ${wireMethod}`);
    }
    return {
        binding,
        definition: createGeneratedProtocolInterfaceDefinition(schema),
        prefix: wireMethod.slice(0, wireMethod.length - binding.member.length),
    };
}

async function call(
    connection: LinkRpcConnection,
    contract: Contract,
    wireMethod: string,
    params: unknown,
): Promise<unknown> {
    const { definition, binding, prefix } = selectMember(contract, wireMethod, 'clientToServer');
    const target = createGeneratedProtocolBareTarget(definition.toSchema(), prefix);
    return connection.get(target)[binding.member](params);
}

function receiveNotification(
    connection: LinkRpcConnection,
    contract: Contract,
    wireMethod: string,
    accept: (params: unknown) => boolean = () => true,
): Promise<unknown> {
    const { definition, binding, prefix } = selectMember(contract, wireMethod, 'serverToClient');
    return new Promise((resolve) => {
        connection.register(definition, {
            [binding.member]: (params: unknown) => {
                if (accept(params)) resolve(params);
            },
        });
        connection.bindBare(definition, { prefix });
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolConnection(
    transport: CloseAwareMessageTransport,
    trace?: Parameters<typeof traceMessageTransport>[1],
): LinkRpcConnection {
    const lifecycle = JsonRpcChannel.createWithClose(
        trace ? traceMessageTransport(transport, trace) : transport,
    );
    transport.onClose(() => lifecycle.close());
    return new LinkRpcConnection(lifecycle.channel);
}

async function within<T>(promise: Promise<T>, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${operation} timed out`)), 10_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function openSocket(url: string): Promise<WebSocket> {
    const socket = new WebSocket(url);
    try {
        await within(new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => resolve(), { once: true });
            socket.addEventListener('error', () => reject(new Error('Inspector WebSocket failed')), {
                once: true,
            });
        }), 'Inspector WebSocket');
        return socket;
    } catch (error) {
        socket.close();
        throw error;
    }
}
