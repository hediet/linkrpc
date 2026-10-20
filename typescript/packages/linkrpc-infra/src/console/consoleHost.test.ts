import { defineInterface, LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { object, string } from 'zod/mini';
import { describe, expect, it, vi } from 'vitest';
import {
    CONSOLE_INTERFACE_TAG,
    CONSOLE_TEMPLATE_ID,
    ConsoleHost,
    consoleHandlers,
    consoleInterface,
    ConsoleTemplate,
    decodeConsoleData,
    encodeConsoleData,
    OutputHistory,
    type ConsoleBackend,
    type ConsoleHistory,
    type ConsoleServerMessage,
} from './index';

function setup(options: { mode?: 'pipe' | 'tty'; history?: ConsoleHistory } = {}) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    const backend = { write: vi.fn(), resize: vi.fn(), signal: vi.fn() } satisfies ConsoleBackend;
    const host = new ConsoleHost({ mode: options.mode ?? 'pipe', signals: ['SIGINT'], backend, history: options.history });
    host.register(server, 'test/console');
    const console = client.get(consoleInterface, { serviceId: 'test/console' }).console;
    const attach = (params: Omit<Parameters<typeof console.attach>[0], 'params'> = {}) => {
        const messages: ConsoleServerMessage[] = [];
        const call = console.attach({ ...params, params: {} }, { onMessage: message => { messages.push(message); } });
        return { call, messages, settled: call.then(result => result, error => String(error)) };
    };
    return { host, backend, console, attach };
}

const text = (data: string) => new TextEncoder().encode(data);
const readable = (messages: readonly ConsoleServerMessage[]) => messages.map(message =>
    'data' in message ? { ...message, data: new TextDecoder().decode(decodeConsoleData(message.data)) } : message);

describe('ConsoleHost', () => {
    it('replays retained output, then shares live output and input between attachments', async () => {
        const f = setup();
        f.host.started(42);
        f.host.output('stdout', text('before\n'));
        const first = f.attach();
        const second = f.attach({ interactive: false });
        await vi.waitFor(() => expect(first.messages.at(-1)).toEqual({ t: 'live' }));
        await vi.waitFor(() => expect(second.messages.at(-1)).toEqual({ t: 'live' }));
        f.host.output('stderr', text('after\n'));
        await first.call.send({ t: 'input', data: encodeConsoleData(text('typed\n')) });
        await second.call.send({ t: 'input', data: encodeConsoleData(text('ignored\n')) });
        await vi.waitFor(() => expect(second.messages.at(-1)).toEqual({ t: 'notice', text: 'This attachment is read-only' }));
        expect(f.backend.write.mock.calls.map(([data]) => new TextDecoder().decode(data))).toEqual(['typed\n']);

        await first.call.cancel();
        expect(await first.settled).toEqual({ exit: null });
        f.host.exited({ code: 3, signal: null });
        f.host.finish();
        expect(await second.settled).toEqual({ exit: { code: 3, signal: null } });
        expect(readable(second.messages)).toEqual([
            { t: 'console', mode: 'pipe', signals: ['SIGINT'], running: true, pid: 42 },
            { t: 'output', stream: 'stdout', data: 'before\n' },
            { t: 'live' },
            { t: 'output', stream: 'stderr', data: 'after\n' },
            { t: 'notice', text: 'This attachment is read-only' },
            { t: 'exit', code: 3, signal: null },
        ]);
    });

    it('adopts the most recent interactive TTY size and rejects unsupported signals per attachment', async () => {
        const f = setup({ mode: 'tty' });
        const first = f.attach({ size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(first.messages.at(-1)).toEqual({ t: 'live' }));
        const second = f.attach({ size: { cols: 60, rows: 20 } });
        await vi.waitFor(() => expect(second.messages.at(-1)).toEqual({ t: 'live' }));
        await second.call.send({ t: 'signal', signal: 'SIGKILL' });
        await first.call.send({ t: 'signal', signal: 'SIGINT' });
        await vi.waitFor(() => expect(f.backend.signal).toHaveBeenCalledWith('SIGINT'));
        expect(first.messages).toContainEqual({ t: 'resized', cols: 60, rows: 20 });
        expect(second.messages[0]).toMatchObject({ t: 'console', mode: 'tty', size: { cols: 60, rows: 20 } });
        expect(second.messages).toContainEqual({ t: 'notice', text: 'SIGKILL is not supported by this console (supported: SIGINT)' });
        expect(f.backend.resize.mock.calls).toEqual([[{ cols: 100, rows: 30 }], [{ cols: 60, rows: 20 }]]);
        f.host.close();
        await first.settled;
        await expect(f.console.attach({ params: {} }, { onMessage: () => {} })).rejects.toThrow('The console is closed');
    });

    it('queues events that occur while an asynchronous snapshot is captured', async () => {
        let release!: () => void;
        const history: ConsoleHistory = {
            append: () => {},
            snapshot: () => new Promise(resolve => {
                release = () => resolve([{ t: 'screen', data: encodeConsoleData(text('screen')) }]);
            }),
        };
        const f = setup({ mode: 'tty', history });
        const attachment = f.attach();
        await vi.waitFor(() => expect(release).toBeDefined());
        f.host.output('tty', text('during'));
        release();
        f.host.output('tty', text('after'));
        await vi.waitFor(() => expect(attachment.messages).toHaveLength(5));
        expect(readable(attachment.messages).map(message => message.t === 'console' ? message.t : message)).toEqual([
            'console',
            { t: 'screen', data: 'screen' },
            { t: 'live' },
            { t: 'output', stream: 'tty', data: 'during' },
            { t: 'output', stream: 'tty', data: 'after' },
        ]);
    });

    it('completes new attachments after replay once no process is pending', async () => {
        const f = setup();
        f.host.started();
        f.host.output('stdout', text('done\n'));
        f.host.exited({ code: 0, signal: null });
        f.host.finish();
        const attachment = f.attach();
        expect(await attachment.settled).toEqual({ exit: { code: 0, signal: null } });
        expect(readable(attachment.messages).map(message => message.t)).toEqual(['console', 'output', 'live']);
    });

    it('bounds retained pipe output by bytes', () => {
        const history = new OutputHistory(8);
        for (const chunk of ['aaaa', 'bbbb', 'cccc']) history.append({ type: 'output', stream: 'stdout', data: text(chunk) });
        expect(readable(history.snapshot())).toEqual([
            { t: 'output', stream: 'stdout', data: 'bbbb' },
            { t: 'output', stream: 'stdout', data: 'cccc' },
        ]);
    });

    it('round-trips arbitrary bytes', () => {
        const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);
        expect(decodeConsoleData(encodeConsoleData(bytes))).toEqual(bytes);
    });
});

describe('ConsoleTemplate', () => {
    it('tags containing interfaces and publishes discoverable template metadata', () => {
        const schema = consoleInterface.toSchema();
        const metadata = schema['x-interface-templates'] as {
            templates: Record<string, { id: string; parameters: string[]; tags?: string[] }>;
            instances: { name: string; template: string; members: Record<string, string> }[];
        };
        expect({
            tags: schema.tags,
            template: metadata.templates[CONSOLE_TEMPLATE_ID],
            instances: metadata.instances.map(({ name, template, members }) => ({ name, template, members })),
            methods: Object.keys(schema.methods).sort(),
        }).toMatchObject({
            tags: [CONSOLE_INTERFACE_TAG],
            template: { id: CONSOLE_TEMPLATE_ID, parameters: ['params'], tags: [CONSOLE_INTERFACE_TAG] },
            instances: [{ name: 'console', template: CONSOLE_TEMPLATE_ID, members: { info: 'info', attach: 'attach' } }],
            methods: ['attach', 'info'],
        });
    });

    it('routes params to one of several consoles of a service', async () => {
        const managed = defineInterface({ id: 'test.consoles' }, {
            consoles: ConsoleTemplate({ params: object({ name: string() }) }),
        });
        const hosts = new Map(['a', 'b'].map(name => [name, new ConsoleHost({
            mode: 'pipe', signals: [], backend: { write: vi.fn(), resize: vi.fn(), signal: vi.fn() },
        })]));
        const pair = new TransportPair();
        LinkRpcConnection.fromTransport(pair.a).register(managed, {
            consoles: consoleHandlers(({ name }: { name: string }) => {
                const host = hosts.get(name);
                if (!host) throw new Error(`No console "${name}"`);
                return host;
            }),
        });
        hosts.get('b')!.started(7);
        const client = LinkRpcConnection.fromTransport(pair.b).get(managed).consoles;
        expect(await client.info({ params: { name: 'b' } })).toMatchObject({ running: true, pid: 7 });
        expect(await client.info({ params: { name: 'a' } })).toMatchObject({ running: false });
        await expect(client.info({ params: { name: 'c' } })).rejects.toThrow('No console "c"');
    });
});
