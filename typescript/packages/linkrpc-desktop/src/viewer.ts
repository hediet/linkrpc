import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
    LinkRpcConnection, createSchemaToZod, directoryInterface, schemasInterface,
    type JsonValue, type RawStreamingCall, type LinkRpcInterfaceSchema,
} from '@hediet/linkrpc';
import { WebSocketTransport } from '@hediet/linkrpc/node';
import {
    desktopInterface, desktopInstances, desktopInfoSchema, desktopAttachResultSchema,
    desktopServerMessageSchema, maintainDesktopLease,
} from '@hediet/linkrpc-infra/desktop';
import type { SigningCallCtx } from '@hediet/linkrpc';
import { viewerHtml, viewerScript } from './viewerPage';
import { patchNoVnc } from './viewerPatches';

/** Loopback viewer proxy: credentials stay in Node; desktop bytes never traverse this proxy. */
export async function startDesktopViewer(options: {
    connect(): Promise<{ connection: LinkRpcConnection<undefined, SigningCallCtx>; close(): void }>;
    serviceId: string;
    params: JsonValue;
    interfaceId?: string;
    instance?: string;
}) {
    const discovery = await options.connect();
    let selected: { interfaceId: string; info: string; attach: string } | undefined;
    try {
        let cursor: string | undefined;
        do {
            const page = await discovery.connection.get(directoryInterface, { serviceId: options.serviceId }).list({
                serviceId: options.serviceId, ...(cursor ? { cursor } : {}),
            });
            for (const entry of page.items) {
                if (options.interfaceId && entry.interfaceId !== options.interfaceId) continue;
                if (!entry.tags?.includes('linkrpc.desktop')) continue;
                const { schema } = await discovery.connection.get(schemasInterface, { serviceId: options.serviceId })
                    .get({ interfaceId: entry.interfaceId });
                for (const instance of desktopInstances(schema as LinkRpcInterfaceSchema)) {
                    if (options.instance && options.instance !== instance.name) continue;
                    if (selected) throw new Error('Several desktop instances match; select --interface and --instance');
                    const parsed = createSchemaToZod(instance.params.components?.schemas ?? {}).toZod(instance.params.schema).safeParse(options.params);
                    if (!parsed.success) throw new Error(`Invalid desktop params: ${parsed.error.message}`);
                    selected = { interfaceId: entry.interfaceId, info: instance.info, attach: instance.attach };
                }
            }
            cursor = page.nextCursor;
            if (page.truncated) throw new Error('Desktop discovery was truncated');
        } while (cursor);
        if (!selected) throw new Error(`No supported desktop template at ${options.serviceId}`);
    } finally {
        discovery.close();
    }
    const target = selected;
    const token = randomBytes(24).toString('hex');
    const require = createRequire(import.meta.url);
    const noVncRoot = dirname(dirname(require.resolve('@novnc/novnc')));
    for (const path of ['core/rfb.js', 'core/display.js']) {
        patchNoVnc(path, await readFile(resolve(noVncRoot, path), 'utf8'));
    }
    const clients = new Set<{ close(): void }>();
    let disposed = false;
    const server = createServer((request, response) => {
        void (async () => {
            // A capability URL isolates this powerful local bridge from unrelated web origins.
            const url = new URL(request.url ?? '/', 'http://localhost');
            if (!url.pathname.startsWith(`/${token}/`)) { response.writeHead(404).end(); return; }
            const path = decodeURIComponent(url.pathname.slice(token.length + 2));
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('Referrer-Policy', 'no-referrer');
            if (path === '') { response.setHeader('Content-Type', 'text/html'); response.end(viewerHtml); return; }
            if (path === 'viewer.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(viewerScript); return; }
            if (path === 'browser.js') {
                response.setHeader('Content-Type', 'text/javascript');
                response.end(await readFile(new URL('../dist/browser.js', import.meta.url)));
                return;
            }
            if (path.startsWith('novnc/')) {
                const relative = path.slice('novnc/'.length);
                const file = resolve(noVncRoot, relative);
                if (!file.startsWith(noVncRoot + sep) || !file.endsWith('.js')) { response.writeHead(404).end(); return; }
                response.setHeader('Content-Type', 'text/javascript');
                response.end(patchNoVnc(relative, await readFile(file, 'utf8')));
                return;
            }
            response.writeHead(404).end();
        })().catch(error => {
            console.error('Desktop viewer request failed:', error);
            if (!response.headersSent) response.writeHead(500);
            response.end('Desktop viewer request failed');
        });
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
    let origin = '';
    server.on('upgrade', (request, socket, head) => {
        if (request.url !== `/${token}/control`
            || request.headers.origin !== origin) {
            socket.destroy();
            return;
        }
        sockets.handleUpgrade(request, socket, head, websocket => {
            void (async () => {
                const hub = await options.connect();
                if (disposed || websocket.readyState !== WebSocket.OPEN) { hub.close(); websocket.close(); return; }
                const transport = new WebSocketTransport(websocket);
                const local = LinkRpcConnection.fromTransport(transport);
                const entry = { close: () => { local.close(); hub.close(); websocket.close(); } };
                clients.add(entry);
                websocket.once('close', () => { entry.close(); clients.delete(entry); });
                local.register(desktopInterface, {
                    desktop: {
                        info: async () => desktopInfoSchema.parse(await hub.connection.channel.sendRequest(
                            `${options.serviceId}::${target.interfaceId}::${target.info}`, { params: options.params },
                        )),
                        attach: async ({ offer, viewport }, _context, stream) => {
                            let remote: RawStreamingCall | undefined;
                            let cancelled = false;
                            const cancel = () => {
                                if (cancelled) return;
                                cancelled = true;
                                if (remote) void Promise.resolve(remote.cancel('viewerDisconnected'))
                                    .catch(error => console.error('Desktop cancellation failed:', error));
                                remote?.dispose?.('viewerDisconnected');
                            };
                            stream.signal.addEventListener('abort', cancel, { once: true });
                            const browserLease = maintainDesktopLease(() => stream.ping(), cancel);
                            try {
                                stream.signal.throwIfAborted();
                                remote = hub.connection.channel.sendRequestWithStream(
                                    `${options.serviceId}::${target.interfaceId}::${target.attach}`,
                                    { params: options.params, offer, viewport },
                                    { onStreamMessage: payload => {
                                        const parsed = desktopServerMessageSchema.safeParse(payload);
                                        if (!parsed.success) {
                                            remote?.dispose?.(`Invalid desktop control message: ${parsed.error.message}`);
                                            cancel();
                                            return;
                                        }
                                        void stream.send(parsed.data).catch(cancel);
                                    } },
                                );
                                const upstream = remote;
                                stream.onMessage(message => { void Promise.resolve(upstream.send(message)).catch(cancel); });
                                const hubLease = maintainDesktopLease(() => upstream.ping(), cancel);
                                try {
                                    const result = await upstream.result;
                                    remote = undefined;
                                    return desktopAttachResultSchema.parse(result);
                                }
                                finally { hubLease.dispose(); }
                            } finally {
                                browserLease.dispose();
                                stream.signal.removeEventListener('abort', cancel);
                                cancel();
                            }
                        },
                    },
                });
                // Do not let the browser send calls before the asynchronous hub setup and handlers are ready.
                websocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'desktop.viewer.ready' }));
            })().catch(error => {
                console.error('Desktop control connection failed:', error);
                websocket.close(1011, 'Desktop control connection failed');
            });
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Viewer has no TCP address');
    origin = `http://127.0.0.1:${address.port}`;
    return {
        url: `http://127.0.0.1:${address.port}/${token}/`,
        async dispose() {
            if (disposed) return;
            disposed = true;
            for (const client of clients) client.close();
            for (const socket of sockets.clients) socket.terminate();
            sockets.close();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}
