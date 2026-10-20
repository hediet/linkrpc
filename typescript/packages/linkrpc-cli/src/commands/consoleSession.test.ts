import { describe, expect, it } from 'vitest';
import { DEFAULT_DETACH_KEYS, DetachKeyFilter, DetachKeys } from './consoleSession';

const push = (filter: DetachKeyFilter, bytes: number[] | string) => {
    const input = typeof bytes === 'string' ? [...Buffer.from(bytes, 'latin1')] : bytes;
    const { forward, detach } = filter.push(Uint8Array.from(input));
    return { forward: Buffer.from(forward).toString('latin1'), detach };
};

describe('DetachKeys', () => {
    it('parses Docker syntax and describes the sequence', () => {
        expect([DEFAULT_DETACH_KEYS, DetachKeys.parse('ctrl-p,ctrl-q'), DetachKeys.parse('ctrl-],x'), DetachKeys.parse('ctrl-@')].map(keys => ({
            bytes: [...keys.bytes], label: keys.label,
        }))).toEqual([
            { bytes: [0x02, 0x64], label: 'Ctrl+B, then d' },
            { bytes: [0x10, 0x11], label: 'Ctrl+P, then Ctrl+Q' },
            { bytes: [0x1d, 0x78], label: 'Ctrl+], then x' },
            { bytes: [0x00], label: 'Ctrl+@' },
        ]);
    });

    it.each(['', 'ctrl-', 'ctrl-1', 'alt-x', 'ab', 'ctrl-p,,d'])('rejects %j', spec => {
        expect(() => DetachKeys.parse(spec)).toThrow(/Invalid detach key/);
    });
});

describe('DetachKeyFilter', () => {
    it('detaches on the default Ctrl+B, then d, forwarding what came before', () => {
        expect(push(new DetachKeyFilter(), 'ls\x02d rest')).toEqual({ forward: 'ls', detach: true });
    });

    it('recognizes the sequence across chunks', () => {
        const filter = new DetachKeyFilter();
        expect(push(filter, '\x02')).toEqual({ forward: '', detach: false });
        expect(push(filter, 'd')).toEqual({ forward: '', detach: true });
    });

    it('forwards a held-back prefix unchanged when the sequence does not complete', () => {
        const filter = new DetachKeyFilter();
        expect(push(filter, '\x02c')).toEqual({ forward: '\x02c', detach: false });
        expect(push(filter, '\x02\x02')).toEqual({ forward: '\x02', detach: false });
        expect(push(filter, 'd')).toEqual({ forward: '', detach: true });
    });

    it('uses a configured sequence and forwards Ctrl+C, Ctrl+D, and the default keys', () => {
        const filter = new DetachKeyFilter(DetachKeys.parse('ctrl-p,ctrl-q'));
        expect(push(filter, '\x03\x04\x02d')).toEqual({ forward: '\x03\x04\x02d', detach: false });
        expect(push(filter, '\x10\x11')).toEqual({ forward: '', detach: true });
    });

    it('supports longer sequences with repeated keys', () => {
        const filter = new DetachKeyFilter(DetachKeys.parse('a,a,b'));
        expect(push(filter, 'aaab')).toEqual({ forward: 'a', detach: true });
    });
});
