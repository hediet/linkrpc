import { describe, expect, it } from 'vitest';
import { LogBuffer } from './logBuffer';

describe('LogBuffer', () => {
    it('joins lines across chunks and keeps the newest lines', () => {
        const buffer = new LogBuffer(2);
        expect(buffer.append('stdout', 'one\r\ntw')).toEqual(['one']);
        expect(buffer.append('stdout', 'o\nthree\n')).toEqual(['two', 'three']);
        expect(buffer.lines().map(line => line.text)).toEqual(['two', 'three']);
    });

    it('cuts output without newlines instead of buffering it unboundedly', () => {
        const buffer = new LogBuffer();
        const lines = buffer.append('stdout', 'x'.repeat(20_000));
        expect(lines.map(line => line.length)).toEqual([8_192, 8_192]);
        expect(buffer.append('stdout', '\n')).toEqual(['x'.repeat(20_000 - 2 * 8_192)]);
    });
});
