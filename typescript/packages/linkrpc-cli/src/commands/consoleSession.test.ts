import { describe, expect, it } from 'vitest';
import { DetachKeyFilter } from './consoleSession';

const push = (filter: DetachKeyFilter, bytes: number[]) => {
    const { forward, detach } = filter.push(Uint8Array.from(bytes));
    return { forward: [...forward], detach };
};

describe('DetachKeyFilter', () => {
    it('detaches on Ctrl+P, Ctrl+Q and forwards what came before', () => {
        expect(push(new DetachKeyFilter(), [0x61, 0x10, 0x11, 0x62])).toEqual({ forward: [0x61], detach: true });
    });

    it('recognizes the sequence across chunks', () => {
        const filter = new DetachKeyFilter();
        expect(push(filter, [0x10])).toEqual({ forward: [], detach: false });
        expect(push(filter, [0x11])).toEqual({ forward: [], detach: true });
    });

    it('forwards a lone Ctrl+P with the next key, and keeps repeated Ctrl+P pending', () => {
        const filter = new DetachKeyFilter();
        expect(push(filter, [0x10, 0x63])).toEqual({ forward: [0x10, 0x63], detach: false });
        expect(push(filter, [0x10, 0x10])).toEqual({ forward: [0x10], detach: false });
        expect(push(filter, [0x11])).toEqual({ forward: [], detach: true });
    });

    it('forwards Ctrl+C and Ctrl+D to the program', () => {
        expect(push(new DetachKeyFilter(), [0x03, 0x04])).toEqual({ forward: [0x03, 0x04], detach: false });
    });
});
