import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { LinkRpcConnection, isRequest, type JsonRpcMessage } from '@hediet/linkrpc';
import { Hub } from '@hediet/linkrpc-hub/hub/server';
import { DesktopHost, desktopHandlers, desktopInterface, desktopHubInterface, desktopHubHandlers } from '@hediet/linkrpc-infra/desktop';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VncBackend } from '../src/vncBackend';
import { startDesktopViewer } from '../src/viewer';

let browser: Browser;
beforeAll(async () => {
    browser = await chromium.launch({
        ...(process.env.LINKRPC_TEST_BROWSER ? { executablePath: process.env.LINKRPC_TEST_BROWSER }
            : process.platform === 'win32' ? { channel: 'msedge' } : {}),
        headless: true,
    });
});
afterAll(async () => { await browser?.close(); });

/** An echoing RFB stand-in, reached over WebSocket (like websockify) or plain TCP (like a VNC server). */
async function startEchoSource(kind: 'ws' | 'tcp') {
    const peers = new Set<{ send(bytes: Buffer): void; close(): void; }>();
    const inputs: Buffer[] = [];
    let connections = 0;
    let closed = 0;
    const accept = (peer: { send(bytes: Buffer): void; close(): void; }, onClose: (listener: () => void) => void) => {
        connections++;
        peers.add(peer);
        onClose(() => { closed++; peers.delete(peer); });
        return (bytes: Buffer) => { inputs.push(bytes); peer.send(bytes); };
    };
    let url: string;
    let closeServer: () => Promise<void>;
    if (kind === 'ws') {
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await new Promise<void>(resolve => server.once('listening', resolve));
        server.on('connection', socket => {
            const receive = accept(
                { send: bytes => socket.send(bytes, { binary: true }), close: () => socket.terminate() },
                listener => socket.once('close', listener),
            );
            socket.on('message', data => receive(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
        });
        url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
        closeServer = () => new Promise<void>(resolve => server.close(() => resolve()));
    } else {
        const server = net.createServer(socket => {
            const receive = accept({ send: bytes => socket.write(bytes), close: () => socket.destroy() }, listener => socket.once('close', listener));
            socket.on('data', receive);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`;
        closeServer = () => new Promise<void>(resolve => server.close(() => resolve()));
    }
    return {
        url, inputs,
        get connections() { return connections; },
        get closed() { return closed; },
        send: (bytes: Buffer) => { for (const peer of peers) peer.send(bytes); },
        async close() { for (const peer of peers) peer.close(); await closeServer(); },
    };
}

async function fixture(sourceUrl?: string, dpiUrl?: string, transport: 'webrtc' | 'hub' = 'webrtc', sourceKind: 'ws' | 'tcp' = 'ws') {
    const hub = new Hub();
    const source = await startEchoSource(sourceKind);
    const inputs = source.inputs;
    const host = new DesktopHost(new VncBackend({
        title: 'E2E desktop',
        sourceUrl: sourceUrl ?? source.url,
        dpiUrl,
        peerConfig: { iceAdditionalHostAddresses: ['127.0.0.1'] },
    }));
    const provider = hub.attachOut();
    provider.addPrefixRoute('test/desktop');
    const providerConnection = LinkRpcConnection.fromTransport(provider.transport);
    providerConnection.register(desktopInterface, { desktop: desktopHandlers(() => host) }, { serviceId: 'test/desktop' });
    providerConnection.register(desktopHubInterface, { desktop: desktopHubHandlers(() => host) }, { serviceId: 'test/desktop' });
    providerConnection.enableReflection({ serviceId: 'test/desktop' });
    let blackhole = false;
    const links: ReturnType<Hub['attachOut']>[] = [];
    const callers: (() => void)[] = [];
    const messages: JsonRpcMessage[] = [];
    const viewer = await startDesktopViewer({
        serviceId: 'test/desktop', params: {}, transport,
        connect: async () => {
            const link = hub.attachOut();
            links.push(link);
            const transport = link.transport;
            const connection = LinkRpcConnection.fromTransport({
                send: message => { if (!blackhole) { messages.push(message); return transport.send(message); } },
                setListener: listener => transport.setListener(listener ? message => {
                    if (!blackhole) { messages.push(message); listener(message); }
                } : undefined),
                dispose: () => transport.dispose(),
            });
            callers.push(() => connection.close());
            // Reproduce a non-local hub handshake: browser calls must wait for bridge readiness.
            await new Promise(resolve => setTimeout(resolve, 30));
            return { connection, close: () => { connection.close(); link.dispose(); } };
        },
    });
    return {
        host, viewer, messages, inputs,
        get closed() { return source.closed; },
        get connections() { return source.connections; },
        disconnectCaller: () => { for (const close of callers) close(); for (const link of links) link.dispose(); },
        disconnectProvider: () => { providerConnection.close(); provider.dispose(); },
        blackhole: () => { blackhole = true; },
        restoreControl: () => { blackhole = false; },
        sendSource: (bytes: Buffer) => source.send(bytes),
        async dispose() {
            blackhole = false;
            host.dispose();
            await viewer.dispose();
            for (const link of links) link.dispose();
            providerConnection.close();
            provider.dispose();
            await source.close();
        },
    };
}

async function openControl(context: BrowserContext, url: string, transport: 'webrtc' | 'hub' = 'webrtc') {
    const page = await context.newPage();
    await page.route('**/viewer.js', route => route.abort());
    await page.goto(url);
    await page.addScriptTag({ type: 'module', content: "import * as api from './browser.js'; window.testDesktopApi = api;" });
    await page.waitForFunction(() => !!window.testDesktopApi);
    await page.evaluate(async transport => {
        const { connectDesktop, createViewerClient, connectHubDesktop, createHubViewerClient } = window.testDesktopApi;
        const controller = new AbortController();
        const url = new URL('control', location.href).href.replace('http:', 'ws:');
        const viewport = { width: 800, height: 600, devicePixelRatio: 1.25 };
        const desktop = transport === 'hub'
            ? connectHubDesktop(await createHubViewerClient(url, controller.signal), viewport, { signal: controller.signal })
            : await connectDesktop(await createViewerClient(url, controller.signal), {}, viewport, { signal: controller.signal });
        const received: number[][] = [];
        desktop.channel.addEventListener('message', event => {
            if (!(event instanceof MessageEvent)) { throw new Error('Expected binary message'); }
            received.push([...new Uint8Array(event.data)]);
        });
        Object.assign(globalThis, { testDesktop: { desktop, controller, received, ended: false, error: '' } });
        void desktop.done.then(
            () => { (globalThis as typeof globalThis & { testDesktop: { ended: boolean } }).testDesktop.ended = true; },
            (error: Error) => {
                Object.assign((globalThis as typeof globalThis & { testDesktop: object }).testDesktop, { ended: true, error: error.message });
            },
        );
        if (desktop.channel.readyState !== 'open' && desktop.channel.readyState !== 1) {
            await new Promise<void>((resolve, reject) => {
                desktop.channel.addEventListener('open', () => resolve(), { once: true });
                desktop.channel.addEventListener('close', () => reject(new Error('Data channel closed before open')), { once: true });
            });
        }
    }, transport);
    return page;
}

// Page-side state is intentionally declared rather than using untyped global casts.
declare global {
    interface Window {
        testDesktopApi: typeof import('../src/browser');
        testDesktop: {
            desktop: import('../src/browser').DesktopConnection | ReturnType<typeof import('../src/browser').connectHubDesktop>;
            controller: AbortController;
            received: number[][];
            ended: boolean;
            error: string;
        };
    }
}
const state = (page: Page) => page.evaluate(() => ({
    readyState: window.testDesktop.desktop.channel.readyState,
    ended: window.testDesktop.ended,
}));

describe('Hub-stream desktop fallback', () => {
    for (const sourceKind of ['ws', 'tcp'] as const)
    for (const ending of ['browser cancel', 'caller hub disconnect', 'provider disconnect', 'service shutdown'] as const) {
        it(`transfers binary RFB bytes from a ${sourceKind} source through the hub and closes it on ${ending}`, async () => {
            const f = await fixture(undefined, undefined, 'hub', sourceKind);
            const context = await browser.newContext();
            try {
                const page = await openControl(context, f.viewer.url, 'hub');
                await vi.waitFor(() => expect(f.connections).toBe(1));
                const payload = Array.from({ length: 65_536 }, (_, index) => index % 256);
                await page.evaluate(payload => window.testDesktop.desktop.channel.send(Uint8Array.from(payload)), payload);
                await vi.waitFor(async () => expect(await page.evaluate(() => window.testDesktop.received.flat())).toEqual(payload));
                expect(f.messages.some(message => JSON.stringify(message).includes('"t":"data"'))).toBe(true);
                // A single source frame exceeds both the credit window and individual stream frame size.
                f.sendSource(Buffer.alloc(1024 * 1024, 123));
                await vi.waitFor(async () => expect(await page.evaluate(
                    () => window.testDesktop.received.reduce((sum, bytes) => sum + bytes.length, 0),
                )).toBe(payload.length + 1024 * 1024));
                if (ending === 'browser cancel') await page.evaluate(() => window.testDesktop.controller.abort());
                else if (ending === 'caller hub disconnect') f.disconnectCaller();
                else if (ending === 'provider disconnect') f.disconnectProvider();
                else f.host.dispose();
                await vi.waitFor(() => expect(f.closed).toBe(1));
                await vi.waitFor(async () => expect(await state(page)).toEqual({ readyState: 3, ended: true }));
                expect(f.host.info().available).toBe(ending !== 'service shutdown');
            } finally { await context.close(); await f.dispose(); }
        }, 30_000);
    }
});

describe('Hub-controlled native-browser WebRTC desktop', () => {
    for (const sourceKind of ['ws', 'tcp'] as const)
    for (const ending of ['browser cancel', 'caller hub disconnect', 'provider disconnect', 'service shutdown'] as const) {
        it(`moves binary data from a ${sourceKind} source outside the hub and tears down on ${ending}`, async () => {
            const f = await fixture(undefined, undefined, 'webrtc', sourceKind);
            const context = await browser.newContext();
            try {
                const page = await openControl(context, f.viewer.url);
                await vi.waitFor(() => expect(f.connections).toBe(1));
                const payload = Array.from({ length: 65_536 }, (_, i) => (i * 37) % 256);
                const before = f.messages.length;
                await page.evaluate(payload => {
                    // RTC SCTP messages are bounded; ordered reassembly is RFB's byte-stream concern.
                    for (let offset = 0; offset < payload.length; offset += 16384) {
                        window.testDesktop.desktop.channel.send(Uint8Array.from(payload.slice(offset, offset + 16384)));
                    }
                }, payload);
                await expect.poll(() => page.evaluate(() => window.testDesktop.received.flat().length)).toBe(payload.length);
                expect(await page.evaluate(() => window.testDesktop.received.flat())).toEqual(payload);
                expect([...Buffer.concat(f.inputs)]).toEqual(payload);
                expect(f.messages.length).toBe(before);
                if (ending === 'browser cancel') await page.evaluate(() => window.testDesktop.controller.abort());
                if (ending === 'caller hub disconnect') f.disconnectCaller();
                if (ending === 'provider disconnect') f.disconnectProvider();
                if (ending === 'service shutdown') f.host.dispose();
                await expect.poll(() => state(page), { timeout: 10_000 }).toEqual({ readyState: 'closed', ended: true });
                await vi.waitFor(() => expect(f.closed).toBe(1));
                expect(f.host.info().available).toBe(ending !== 'service shutdown');
            } finally { await context.close(); await f.dispose(); }
        });
    }

    it('closes the peer and source rather than accumulating oversized source output', async () => {
        const f = await fixture();
        const context = await browser.newContext();
        try {
            const page = await openControl(context, f.viewer.url);
            await vi.waitFor(() => expect(f.connections).toBe(1));
            f.sendSource(Buffer.alloc(4 * 1024 * 1024 + 1));
            await expect.poll(() => state(page), { timeout: 10_000 }).toEqual({ readyState: 'closed', ended: true });
            await vi.waitFor(() => expect(f.closed).toBe(1));
            expect(f.host.info().available).toBe(true);
        } finally { await context.close(); await f.dispose(); }
    });

    it('expires a control-only blackhole while WebRTC remains usable, then allows a fresh attachment', async () => {
        const f = await fixture();
        const context = await browser.newContext();
        try {
            const page = await openControl(context, f.viewer.url);
            await vi.waitFor(() => expect(f.connections).toBe(1));
            f.blackhole();
            await page.evaluate(() => window.testDesktop.desktop.channel.send(Uint8Array.from([12, 34, 56])));
            await expect.poll(() => page.evaluate(() => window.testDesktop.received.flat())).toEqual([12, 34, 56]);
            await page.evaluate(() => {
                const interval = setInterval(() => {
                    if (window.testDesktop.desktop.channel.readyState === 'open') {
                        window.testDesktop.desktop.channel.send(Uint8Array.from([78, 90]));
                    } else clearInterval(interval);
                }, 250);
                void window.testDesktop.desktop.done.finally(() => clearInterval(interval)).catch(() => {});
            });
            // Real policy clocks: installing fake timers after attach would not advance existing leases.
            await expect.poll(() => state(page), { timeout: 70_000, interval: 500 }).toEqual({ readyState: 'closed', ended: true });
            await vi.waitFor(() => expect(f.closed).toBe(1));
            expect(f.host.info().available).toBe(true);
            f.restoreControl();
            const second = await openControl(context, f.viewer.url);
            await vi.waitFor(() => expect(f.connections).toBe(2));
            expect(await state(second)).toEqual({ readyState: 'open', ended: false });
            expect(await state(page)).toEqual({ readyState: 'closed', ended: true });
            const offers = f.messages.flatMap(message => {
                if (!isRequest(message) || !message.method.endsWith('::attach')) return [];
                const params = message.params;
                if (!params || Array.isArray(params) || typeof params !== 'object' || typeof params.offer !== 'string') return [];
                return [params.offer.match(/a=ice-ufrag:([^\r\n]+)/)?.[1]];
            });
            expect({ offers: offers.length, credentials: new Set(offers).size, receivedChunks: f.inputs.length > 100 }).toEqual({
                offers: 2, credentials: 2, receivedChunks: true,
            });
        } finally { vi.useRealTimers(); await context.close(); await f.dispose(); }
    }, 85_000);

    it.skipIf(!process.env.LINKRPC_TEST_VNC_URL)('preserves HiDPI pixels and live resizing on a real VNC desktop', async () => {
        const f = await fixture(process.env.LINKRPC_TEST_VNC_URL, process.env.LINKRPC_TEST_VNC_DPI_URL);
        const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1.25 });
        try {
            const page = await context.newPage();
            const errors: string[] = [];
            const serverStates: ReturnType<typeof readDockerState>[] = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(f.viewer.url);
            await expect.poll(() => page.locator('#status').textContent(), { timeout: 30_000 }).toBe('Connected · Lossless WebRTC');
            await page.locator('#desktop canvas').evaluate(canvas => { canvas.dataset.testMarker = 'same-canvas'; });
            const dimensions = async () => {
                await page.waitForFunction(() => {
                    const target = document.getElementById('desktop')!;
                    const canvas = target.querySelector('canvas');
                    return canvas?.width === Math.round(target.clientWidth * devicePixelRatio)
                        && canvas.height === Math.round(target.clientHeight * devicePixelRatio);
                });
                return page.locator('#desktop canvas').evaluate(canvas => {
                    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected desktop canvas');
                    const target = document.getElementById('desktop')!;
                    const bounds = canvas.getBoundingClientRect();
                    return {
                        css: [target.clientWidth, target.clientHeight],
                        framebuffer: [canvas.width, canvas.height],
                        rendered: [bounds.width, bounds.height],
                        dpr: devicePixelRatio,
                        smoothing: canvas.getContext('2d')!.imageSmoothingEnabled,
                        rendering: getComputedStyle(canvas).imageRendering,
                        marker: canvas.dataset.testMarker,
                    };
                });
            };
            const verify = async () => {
                const actual = await dimensions();
                expect(actual).toEqual({
                    css: actual.css,
                    framebuffer: actual.css.map(value => Math.round(value * actual.dpr)),
                    rendered: actual.rendered,
                    dpr: actual.dpr, smoothing: false, rendering: 'pixelated', marker: 'same-canvas',
                });
                for (let axis = 0; axis < 2; axis++) {
                    // Browser CSS layout quantizes fractional dimensions to 1/64 CSS pixels.
                    expect(Math.abs(actual.rendered[axis]! * actual.dpr - actual.framebuffer[axis]!)).toBeLessThan(1 / 32);
                }
                console.log('Live VNC viewport:', JSON.stringify(actual));
                if (process.env.LINKRPC_TEST_WSL_DISTRO && process.env.LINKRPC_TEST_DOCKER_CONTAINER) {
                    await vi.waitFor(() => {
                        const state = readDockerState();
                        expect(state).toMatchObject({
                            framebuffer: actual.framebuffer, dpi: Math.round(96 * actual.dpr),
                            apps: [{ pid: expect.any(Number), dpr: actual.dpr }],
                        });
                    }, { timeout: 30_000, interval: 300 });
                    const state = readDockerState();
                    serverStates.push(state);
                    console.log('Live VNC server:', JSON.stringify(state));
                }
                return actual;
            };
            await verify();
            await page.setViewportSize({ width: 900, height: 700 });
            await verify();
            await page.setViewportSize({ width: 1100, height: 760 });
            await verify();
            const cdp = await context.newCDPSession(page);
            for (const [width, dpr] of [[1104, 1], [1100, 1.25]] as const) {
                await cdp.send('Emulation.setDeviceMetricsOverride', {
                    width, height: 760, deviceScaleFactor: dpr, mobile: false,
                });
                expect((await verify()).dpr).toBe(dpr);
            }
            expect(errors).toEqual([]);
            if (serverStates.length) {
                expect(new Set(serverStates.map(state => state.vncPid)).size).toBe(1);
                expect(serverStates[0]!.apps[0]!.pid).toBe(serverStates[2]!.apps[0]!.pid);
                expect(serverStates[2]!.apps[0]!.pid).not.toBe(serverStates[3]!.apps[0]!.pid);
                expect(serverStates[3]!.apps[0]!.pid).not.toBe(serverStates[4]!.apps[0]!.pid);
            }
            await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
            await vi.waitFor(() => expect(f.host.info().available).toBe(true));
        } finally { await context.close(); await f.dispose(); }
    }, 90_000);
});

/** Optional machine-specific cross-check; the ordinary E2E suite needs no Docker or WSL. */
function readDockerState(): { framebuffer: number[]; dpi: number; vncPid: number; apps: { pid: number; dpr: number }[] } {
    return JSON.parse(execFileSync('wsl.exe', [
        '-d', process.env.LINKRPC_TEST_WSL_DISTRO!, '-u', 'root', '--exec',
        'docker', 'exec', process.env.LINKRPC_TEST_DOCKER_CONTAINER!, 'python3', '-c', `
import json, re, subprocess
from pathlib import Path
apps = []
for p in Path('/proc').iterdir():
    if not p.name.isdigit():
        continue
    try:
        args = (p / 'cmdline').read_bytes().split(b'\\0')
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if args and args[0].endswith(b'/code-insiders') and not any(a.startswith(b'--type=') or a.endswith(b'/out/cli.js') for a in args):
        scale = next(a.split(b'=')[1] for a in args if a.startswith(b'--force-device-scale-factor='))
        apps.append({'pid': int(p.name), 'dpr': float(scale)})
size = re.search(r'current (\\d+) x (\\d+)', subprocess.check_output(['xrandr', '--display', ':1'], text=True))
dpi = re.search(r'Xft.dpi:\\s*(\\d+)', subprocess.check_output(['xrdb', '-display', ':1', '-query'], text=True))
print(json.dumps({
    'framebuffer': [int(size[1]), int(size[2])], 'dpi': int(dpi[1]), 'apps': apps,
    'vncPid': int(subprocess.check_output(['supervisorctl', '-c', '/etc/supervisor/supervisord.conf', 'pid', 'xvnc'], text=True)),
}))
`,
    ], { encoding: 'utf8', timeout: 15_000 }));
}
