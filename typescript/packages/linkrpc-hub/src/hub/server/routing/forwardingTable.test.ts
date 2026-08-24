import { describe, expect, it } from 'vitest';
import { ForwardingTable, validatePrefix } from './forwardingTable';

describe('ForwardingTable', () => {
    it('returns the exact owner for an exact prefix', () => {
        const t = new ForwardingTable<string>();
        t.set('calc', 'A');
        expect(t.longestPrefixMatch('calc')).toEqual({ prefix: 'calc', value: 'A' });
    });

    it('matches descendants of a claimed prefix', () => {
        const t = new ForwardingTable<string>();
        t.set('a/b', 'A');
        expect(t.longestPrefixMatch('a/b/c/d')).toEqual({ prefix: 'a/b', value: 'A' });
    });

    it('prefers the longest matching prefix', () => {
        const t = new ForwardingTable<string>();
        t.set('a', 'short');
        t.set('a/b', 'long');
        expect(t.longestPrefixMatch('a/b/c')).toEqual({ prefix: 'a/b', value: 'long' });
        expect(t.longestPrefixMatch('a/x')).toEqual({ prefix: 'a', value: 'short' });
    });

    it('is segment-aware (does not match partial segments)', () => {
        const t = new ForwardingTable<string>();
        t.set('a/b', 'A');
        // "a/bc" is NOT under "a/b"
        expect(t.longestPrefixMatch('a/bc')).toBeUndefined();
    });

    it('returns undefined when nothing matches', () => {
        const t = new ForwardingTable<string>();
        t.set('calc', 'A');
        expect(t.longestPrefixMatch('other')).toBeUndefined();
    });

    it('supports delete and deleteByValue', () => {
        const t = new ForwardingTable<string>();
        t.set('a', 'x');
        t.set('b', 'x');
        t.set('c', 'y');
        expect(t.deleteByValue('x').sort()).toEqual(['a', 'b']);
        expect(t.prefixes().sort()).toEqual(['c']);
        expect(t.delete('c')).toBe(true);
        expect(t.size).toBe(0);
    });

    it('deleteByValue returns empty for an unknown value and keeps the table intact', () => {
        const t = new ForwardingTable<string>();
        t.set('a', 'x');
        expect(t.deleteByValue('absent')).toEqual([]);
        expect(t.size).toBe(1);
    });

    it('reassigning a prefix updates the reverse index', () => {
        const t = new ForwardingTable<string>();
        t.set('a', 'x');
        t.set('a', 'y');
        // 'a' no longer belongs to 'x'.
        expect(t.deleteByValue('x')).toEqual([]);
        expect(t.get('a')).toBe('y');
    });
});

describe('validatePrefix', () => {
    it('accepts well-formed prefixes', () => {
        expect(validatePrefix('a')).toBeUndefined();
        expect(validatePrefix('a/b/c')).toBeUndefined();
    });

    it('rejects malformed prefixes', () => {
        expect(validatePrefix('')).toBeDefined();
        expect(validatePrefix('/a')).toBeDefined();
        expect(validatePrefix('a/')).toBeDefined();
        expect(validatePrefix('a//b')).toBeDefined();
        expect(validatePrefix(42 as unknown)).toBeDefined();
    });
});
