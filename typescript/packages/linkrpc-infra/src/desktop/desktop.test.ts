import { defineInterface, LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { object, string } from 'zod/mini';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DesktopHost, DesktopTemplate, desktopHandlers, desktopInstances, maintainDesktopLease,
    type DesktopSession, type DesktopStream,
} from './index';

afterEach(() => vi.useRealTimers());
const viewport = { width: 800, height: 600, devicePixelRatio: 1.25 };

describe('Desktop control lease', () => {
    it('probes at 20s; one unanswered probe expires at exactly 60s; late pong cannot revive it', async () => {
        vi.useFakeTimers();
        let pong!: () => void;
        const ping = vi.fn(() => new Promise<void>(resolve => { pong = resolve; }));
        const expired = vi.fn();
        const lease = maintainDesktopLease(ping, expired);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(ping).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(ping).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(39_999);
        expect({ probes: ping.mock.calls.length, expired: expired.mock.calls.length }).toEqual({ probes: 1, expired: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(expired.mock.calls.map(([error]) => error.message)).toEqual(['Desktop control lease expired']);
        pong();
        await vi.advanceTimersByTimeAsync(120_000);
        expect({ probes: ping.mock.calls.length, expired: expired.mock.calls.length }).toEqual({ probes: 1, expired: 1 });
        lease.dispose();
    });

    it('renews only on completed round trips, not sending probes', async () => {
        vi.useFakeTimers();
        const ping = vi.fn().mockResolvedValueOnce(undefined).mockImplementation(() => new Promise(() => {}));
        const expired = vi.fn();
        const lease = maintainDesktopLease(ping, expired);
        await vi.advanceTimersByTimeAsync(79_999);
        expect({ probes: ping.mock.calls.length, expired: expired.mock.calls.length }).toEqual({ probes: 2, expired: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(expired).toHaveBeenCalledTimes(1);
        lease.dispose();
    });

    it('fails immediately on ping rejection and removes all timers on disposal', async () => {
        vi.useFakeTimers();
        const expired = vi.fn();
        const lease = maintainDesktopLease(() => Promise.reject(new Error('connection closed')), expired);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(expired.mock.calls.map(([error]) => error.message)).toEqual(['connection closed']);
        lease.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('DesktopHost', () => {
    const session = () => ({
        answer: 'answer', done: new Promise<void>(() => {}),
        dispose: vi.fn(), setViewport: vi.fn(async () => {}),
    } satisfies DesktopSession);
    const stream = (control: AbortController, send = vi.fn(async () => {})): DesktopStream => ({
        signal: control.signal, send, onMessage: () => {},
        ping: () => Promise.resolve(),
    });

    it('releases the controller even when sending the answer hangs', async () => {
        const live = session();
        const host = new DesktopHost({ title: 'one', open: async () => live });
        const control = new AbortController();
        const send = vi.fn(() => new Promise<void>(() => {}));
        const attached = host.attach({ offer: 'offer', viewport }, stream(control, send));
        const settled = attached.catch(error => error.message);
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        await expect(host.attach({ offer: 'offer', viewport }, stream(new AbortController()))).rejects.toThrow('already has a controller');
        control.abort(new Error('caller left'));
        expect(await settled).toBe('caller left');
        expect({ disposed: live.dispose.mock.calls.length, info: host.info() }).toEqual({
            disposed: 1, info: { title: 'one', available: true, protocol: 'rfb' },
        });
    });

    it('disposes a late backend result after cancellation during setup', async () => {
        const live = session();
        let finish!: (value: DesktopSession) => void;
        const host = new DesktopHost({ title: 'one', open: () => new Promise(resolve => { finish = resolve; }) });
        const control = new AbortController();
        const attached = host.attach({ offer: 'offer', viewport }, stream(control)).catch(error => error.message);
        control.abort(new Error('setup cancelled'));
        expect(await attached).toBe('setup cancelled');
        finish(live);
        await vi.waitFor(() => expect(live.dispose).toHaveBeenCalledTimes(1));
        expect(host.info().available).toBe(true);
    });

    it('expires a blackholed control request even when the session remains live', async () => {
        vi.useFakeTimers();
        const live = session();
        const host = new DesktopHost({ title: 'one', open: async () => live });
        const transport = { ...stream(new AbortController()), ping: () => new Promise<void>(() => {}) };
        const attached = host.attach({ offer: 'offer', viewport }, transport).catch(error => error.message);
        await vi.advanceTimersByTimeAsync(60_000);
        expect({ result: await attached, disposed: live.dispose.mock.calls.length, available: host.info().available }).toEqual({
            result: 'Desktop control lease expired', disposed: 1, available: true,
        });
    });
});

describe('Desktop template', () => {
    it('discovers mapped members and selects interchangeable sources using typed params', async () => {
        const definition = defineInterface({ id: 'test.sources' }, {
            screens: DesktopTemplate({ params: object({ source: string() }) }).mapMembers({ info: 'describeScreen', attach: 'controlScreen' }),
        });
        expect(desktopInstances(definition.toSchema()).map(({ name, info, attach }) => ({ name, info, attach }))).toEqual([
            { name: 'screens', info: 'describeScreen', attach: 'controlScreen' },
        ]);
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const caller = LinkRpcConnection.fromTransport(pair.b);
        const hosts = new Map(['first', 'second'].map(title => [title, new DesktopHost({
            title, open: async () => { throw new Error('not needed'); },
        })]));
        server.register(definition, {
            screens: desktopHandlers(({ source }: { source: string }) => {
                const host = hosts.get(source);
                if (!host) throw new Error('Unknown source');
                return host;
            }),
        });
        try {
            const client = caller.get(definition).screens;
            expect(await Promise.all(['first', 'second'].map(source => client.info({ params: { source } })))).toEqual([
                { title: 'first', available: true, protocol: 'rfb' }, { title: 'second', available: true, protocol: 'rfb' },
            ]);
        } finally { caller.close(); server.close(); }
    });
});
