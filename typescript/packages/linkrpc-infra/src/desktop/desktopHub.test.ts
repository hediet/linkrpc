import { describe, expect, it } from 'vitest';
import { DESKTOP_RELAY_CHUNK, DESKTOP_RELAY_WINDOW, DesktopRelay, type DesktopRelayFrame } from './desktopHub';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Desktop hub relay', () => {
    it('withholds credit until consumption and bounds both directions', async () => {
        const frames: DesktopRelayFrame[] = [];
        let consume!: () => void;
        const relay = new DesktopRelay(async frame => { frames.push(frame); },
            () => new Promise<void>(resolve => { consume = resolve; }), error => { throw error; });
        try {
            relay.write(new Uint8Array(DESKTOP_RELAY_WINDOW));
            await tick();
            expect(frames.filter(frame => frame.t === 'data')).toHaveLength(16);
            let drained = false;
            const drain = relay.drain().then(() => { drained = true; });
            relay.receive({ t: 'data', data: 'AQID' });
            await tick();
            expect({ drained, credit: frames.filter(frame => frame.t === 'credit') }).toEqual({ drained: false, credit: [] });
            consume();
            await tick();
            expect(frames.at(-1)).toEqual({ t: 'credit', bytes: 3 });
            relay.receive({ t: 'credit', bytes: DESKTOP_RELAY_WINDOW });
            await drain;
            expect({ drained, buffered: relay.bufferedAmount }).toEqual({ drained: true, buffered: 0 });
        } finally { relay.dispose(); }
    });

    it('does not send data until ready and handles disposal during a blocked send', async () => {
        let complete!: () => void;
        const frames: DesktopRelayFrame[] = [];
        const relay = new DesktopRelay(frame => {
            frames.push(frame);
            return new Promise<void>(resolve => { complete = resolve; });
        }, () => {}, error => { throw error; }, true);
        relay.write(new Uint8Array(DESKTOP_RELAY_WINDOW));
        expect(frames).toEqual([]);
        relay.start();
        const drain = relay.drain();
        relay.dispose();
        await expect(drain).rejects.toThrow('closed');
        complete();
        await tick();
        expect({ frames: frames.length, buffered: relay.bufferedAmount }).toEqual({ frames: 1, buffered: 0 });
        expect(() => relay.write(new Uint8Array(1))).toThrow('closed');
    });

    it('rejects malformed frames, excess credit and unbounded writes', () => {
        const relay = new DesktopRelay(async () => {}, () => {}, error => { throw error; }, true);
        try {
            for (const data of ['', 'A===', 'AB==', '____', 'AAAA\n', 'AAAA'.repeat(5462)]) {
                expect(() => relay.receive({ t: 'data', data })).toThrow();
            }
            for (const bytes of [0, -1, 1, 1.5, Infinity]) {
                expect(() => relay.receive({ t: 'credit', bytes })).toThrow('credit');
            }
            expect(() => relay.write(new Uint8Array(DESKTOP_RELAY_WINDOW + 1))).toThrow('buffer');
        } finally { relay.dispose(); }
    });

    it('terminates once on send or consumer failure', async () => {
        const errors: string[] = [];
        const relay = new DesktopRelay(async () => { throw new Error('send failed'); }, () => {},
            error => errors.push(error.message));
        relay.write(new Uint8Array(10));
        await tick();
        expect(errors).toEqual(['send failed']);
        const consumer = new DesktopRelay(async () => {}, async () => { throw new Error('consumer failed'); },
            error => errors.push(error.message));
        consumer.receive({ t: 'data', data: 'AQID' });
        consumer.receive({ t: 'data', data: 'AQID' });
        await tick();
        expect(errors).toEqual(['send failed', 'consumer failed']);
    });
});
