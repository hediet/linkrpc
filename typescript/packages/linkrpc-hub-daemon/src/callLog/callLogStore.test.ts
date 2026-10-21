import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CallLogConfigSchema } from './callLogConfig';
import { CallLogStore } from './callLogStore';
import type { CallRecord } from './callRecord';

const rotation = (overrides: object = {}) => CallLogConfigSchema.parse({ rotation: overrides }).rotation;

function call(id: string, at: number, overrides: Partial<CallRecord> = {}): CallRecord {
    return {
        v: 1, id, at, level: 'info', kind: 'request', status: 'completed', durationMs: 1,
        method: 'hub/echo::echo::echo', from: { label: 'e1' }, ...overrides,
    };
}

describe('CallLogStore', () => {
    let dir: string;
    let store: CallLogStore;
    let now: number;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrh-calls-'));
        now = Date.parse('2026-10-21T10:00:00Z');
    });

    afterEach(async () => {
        await store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps the latest record per call, newest first, and filters', async () => {
        store = new CallLogStore(dir, rotation(), () => now);
        store.append(call('a', 1, { status: 'pending' }));
        store.append(call('b', 2, { method: 'hub/other::x::y' }));
        store.append(call('a', 1, { status: 'failed', level: 'error', error: { code: -32000, message: 'boom' } }));
        const summary = (calls: readonly CallRecord[]) => calls.map(({ id, status }) => `${id}:${status}`);

        expect(summary((await store.query()).calls)).toEqual(['a:failed', 'b:completed']);
        expect(summary((await store.query({ minLevel: 'error' })).calls)).toEqual(['a:failed']);
        expect(summary((await store.query({ text: 'OTHER' })).calls)).toEqual(['b:completed']);
        expect(await store.query({}, 1)).toMatchObject({ calls: [{ id: 'a' }], truncated: true });
    });

    it('rotates by size, deletes the oldest files beyond maxFiles, and continues the newest file after a restart', async () => {
        store = new CallLogStore(dir, rotation({ maxFileSizeMb: 200 / (1024 * 1024), maxFiles: 2 }), () => now);
        for (let i = 0; i < 6; i++) {
            store.append(call(`c${i}`, i));
            await store.flush();
            now += 1_000;
        }
        expect(fs.readdirSync(dir)).toHaveLength(2);
        expect((await store.query()).calls.map(c => c.id)).toEqual(['c5', 'c4', 'c3', 'c2']);

        await store.close();
        store = new CallLogStore(dir, rotation({ maxFiles: 2 }), () => now);
        store.append(call('after-restart', 7));
        await store.flush();
        expect(fs.readdirSync(dir)).toHaveLength(2);
    });

    it('deletes files older than maxAgeDays when it starts a new file', async () => {
        store = new CallLogStore(dir, rotation({ maxFileSizeMb: 1 / (1024 * 1024), maxAgeDays: 1 }), () => now);
        store.append(call('old', 0));
        await store.flush();
        const [oldFile] = fs.readdirSync(dir);
        const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60_000);
        fs.utimesSync(path.join(dir, oldFile!), twoDaysAgo, twoDaysAgo);
        now += 1_000;
        store.append(call('new', 1));
        await store.flush();
        expect((await store.query()).calls.map(c => c.id)).toEqual(['new']);
    });

    it('skips a line cut short by a crash', async () => {
        fs.writeFileSync(path.join(dir, 'calls-2026-10-21T09-00-00-000Z.ndjson'), `${JSON.stringify(call('ok', 1))}\n{"v":1,"id":"cut`);
        store = new CallLogStore(dir, rotation(), () => now);
        expect((await store.query()).calls.map(c => c.id)).toEqual(['ok']);
    });
});
