import { describe, expect, it } from 'vitest';
import { parseLine, tokenize } from './parse';

describe('tokenize', () => {
    it('splits on whitespace', () => {
        const t = tokenize('hub call foo');
        expect(t.map((x) => x.text)).toEqual(['hub', 'call', 'foo']);
        expect(t[0]).toMatchObject({ start: 0, end: 3, quoted: false });
        expect(t[1]).toMatchObject({ start: 4, end: 8 });
        expect(t[2]).toMatchObject({ start: 9, end: 12 });
    });

    it('preserves text inside single and double quotes', () => {
        const t = tokenize(`hub call "a b" 'c d'`);
        expect(t.map((x) => x.text)).toEqual(['hub', 'call', 'a b', 'c d']);
        expect(t[2].quoted).toBe(true);
        expect(t[3].quoted).toBe(true);
        // start includes the opening quote, end includes the closing one.
        expect(t[2]).toMatchObject({ start: 9, end: 14 });
    });

    it('handles an unterminated quote by consuming the rest of the line', () => {
        const t = tokenize(`hub call "abc`);
        expect(t.map((x) => x.text)).toEqual(['hub', 'call', 'abc']);
    });

    it('collapses runs of whitespace', () => {
        const t = tokenize('hub   call\t\tfoo');
        expect(t.map((x) => x.text)).toEqual(['hub', 'call', 'foo']);
    });

    it('returns empty for blank input', () => {
        expect(tokenize('')).toEqual([]);
        expect(tokenize('   ')).toEqual([]);
    });
});

describe('parseLine', () => {
    it('cursor on a token sets currentToken to that token', () => {
        const p = parseLine('hub call', 'hub call'.length);
        expect(p.currentToken?.text).toBe('call');
        expect(p.currentWordPrefix).toBe('call');
        expect(p.tokensBefore.map((t) => t.text)).toEqual(['hub']);
    });

    it('cursor in trailing whitespace yields an empty new word', () => {
        const p = parseLine('hub call ', 'hub call '.length);
        expect(p.currentToken).toBeUndefined();
        expect(p.currentWordPrefix).toBe('');
        expect(p.tokensBefore.map((t) => t.text)).toEqual(['hub', 'call']);
    });

    it('cursor inside a token returns the prefix typed so far', () => {
        // "hub call azure-cli::Ru" with cursor right after "Ru"
        const line = 'hub call azure-cli::Runner';
        const point = 'hub call azure-cli::Ru'.length;
        const p = parseLine(line, point);
        expect(p.currentToken?.text).toBe('azure-cli::Runner');
        expect(p.currentWordPrefix).toBe('azure-cli::Ru');
        expect(p.tokensBefore.map((t) => t.text)).toEqual(['hub', 'call']);
    });

    it('cursor at start of line yields empty new word and no previous tokens', () => {
        const p = parseLine('hub call', 0);
        expect(p.currentToken).toBeUndefined();
        expect(p.currentWordPrefix).toBe('');
        expect(p.tokensBefore).toEqual([]);
    });

    it('cursor past the line length is clamped to end-of-line', () => {
        const p = parseLine('hub', 99);
        expect(p.currentToken?.text).toBe('hub');
        expect(p.currentWordPrefix).toBe('hub');
    });

    it('cursor right after a token (no trailing space) still completes that token', () => {
        const line = 'hub';
        const p = parseLine(line, line.length);
        expect(p.currentToken?.text).toBe('hub');
        expect(p.currentWordPrefix).toBe('hub');
    });
});
