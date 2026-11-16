import { defineInterface, LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { object, string } from 'zod/mini';
import { describe, expect, it, vi } from 'vitest';
import {
    OBSERVABLE_LOG_INTERFACE_TAG,
    ObservableLogTemplate,
    observableLogHandlers,
    type ObservableLogPage,
    type ObservableLogRead,
    type ObservableLogSource,
} from './index';

/** One log per channel; cursors are per-channel sequence numbers; keeps only the newest `retain` entries. */
class Channels implements ObservableLogSource<{ channel: string }, string> {
    private readonly _logs = new Map<string, { seq: number; text: string }[]>();
    private readonly _listeners = new Set<() => void>();
    constructor(private readonly _retain = Infinity) { }

    post(channel: string, text: string): void {
        const log = this._logs.get(channel) ?? [];
        log.push({ seq: (log.at(-1)?.seq ?? 0) + 1, text });
        while (log.length > this._retain) log.shift();
        this._logs.set(channel, log);
        for (const listener of this._listeners) listener();
    }

    read({ channel }: { channel: string }, after: string | undefined, limit: number): ObservableLogRead<string> {
        const log = this._logs.get(channel) ?? [];
        const afterSeq = after === undefined ? 0 : Number(after);
        const entries = log.filter(e => e.seq > afterSeq).slice(0, limit)
            .map(e => ({ cursor: String(e.seq), entry: e.text }));
        return { entries, gap: after !== undefined && log.length > 0 && log[0].seq > afterSeq + 1 };
    }

    latest({ channel }: { channel: string }): string | undefined {
        const log = this._logs.get(channel);
        return log && log.length > 0 ? String(log[log.length - 1].seq) : undefined;
    }

    subscribe(_params: { channel: string }, listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }
}

const chatInterface = defineInterface({ id: 'test.chat' }, {
    messages: ObservableLogTemplate({ params: object({ channel: string() }), entry: string() }),
});

function setup(source: Channels, pageSize?: number) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    server.register(chatInterface, { messages: observableLogHandlers(source, { pageSize }) }, { serviceId: 'test/chat' });
    return client.get(chatInterface, { serviceId: 'test/chat' });
}

function texts(pages: ObservableLogPage<string>[]) {
    return pages.map(p => ({ texts: p.entries.map(e => e.entry), gap: p.gap, cursor: p.cursor }));
}

describe('ObservableLogTemplate', () => {
    it('tags the interface with read/follow wire methods', () => {
        expect({
            methods: Object.keys(chatInterface.toSchema().methods).sort(),
            tags: chatInterface.info.tags,
        }).toEqual({ methods: ['messages$follow', 'messages$read'], tags: [OBSERVABLE_LOG_INTERFACE_TAG] });
    });

    it('reads pages after a cursor and reports dropped entries as a gap', async () => {
        const source = new Channels(3);
        const chat = setup(source);
        for (const text of ['a', 'b', 'c']) source.post('dev', text);
        const first = await chat.messages.read({ params: { channel: 'dev' }, limit: 2 });
        expect(texts([first])).toEqual([{ texts: ['a', 'b'], gap: false, cursor: '2' }]);
        for (const text of ['d', 'e']) source.post('dev', text);
        expect(texts([await chat.messages.read({ params: { channel: 'dev' }, after: first.cursor })]))
            .toEqual([{ texts: ['c', 'd', 'e'], gap: false, cursor: '5' }]);
        source.post('dev', 'f');
        expect(texts([await chat.messages.read({ params: { channel: 'dev' }, after: first.cursor })]))
            .toEqual([{ texts: ['d', 'e', 'f'], gap: true, cursor: '6' }]);
        expect(await chat.messages.read({ params: { channel: 'empty' } })).toEqual({ entries: [], gap: false });
    });

    it('follows new entries from now, and resumes from a cursor without missing any', async () => {
        const source = new Channels();
        const chat = setup(source, 2);
        source.post('dev', 'old');
        const pages: ObservableLogPage<string>[] = [];
        const call = chat.messages.follow({ params: { channel: 'dev' } }, { onMessage: page => { pages.push(page); } });
        const settled = Promise.resolve(call).catch(() => 'cancelled');
        await vi.waitFor(() => expect(texts(pages)).toEqual([{ texts: [], gap: false, cursor: '1' }]));
        source.post('other', 'ignored');
        source.post('dev', 'new');
        await vi.waitFor(() => expect(pages.at(-1)?.entries.map(e => e.entry)).toEqual(['new']));
        call.cancel();
        await settled;

        for (const text of ['x', 'y', 'z']) source.post('dev', text);
        const resumed: ObservableLogPage<string>[] = [];
        const resume = chat.messages.follow({ params: { channel: 'dev' }, after: pages.at(-1)!.cursor },
            { onMessage: page => { resumed.push(page); } });
        const resumeSettled = Promise.resolve(resume).catch(() => 'cancelled');
        await vi.waitFor(() => expect(texts(resumed)).toEqual([
            { texts: ['x', 'y'], gap: false, cursor: '4' },
            { texts: ['z'], gap: false, cursor: '5' },
        ]));
        resume.cancel();
        await resumeSettled;
    });
});
