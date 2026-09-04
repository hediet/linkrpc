import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@hediet/linkrpc';
import { applyJsonDocumentEdits, parseJsonPointer } from './index';

describe('JSON document edits', () => {
    it('applies set, remove, append, splice, and insert operations', () => {
        const document: JsonValue = {
            text: 'hello',
            nested: { value: 1, remove: true },
            items: ['a'],
        };

        const result = applyJsonDocumentEdits(document, [
            { op: 'append', path: '/text', value: ' world' },
            { op: 'splice', path: '/text', offset: 6, delete: 5, insert: 'LinkRPC' },
            { op: 'set', path: '/nested/value', value: 2 },
            { op: 'remove', path: '/nested/remove' },
            { op: 'insert', path: '/items', index: -1, value: 'b' },
            { op: 'insert', path: '/items', index: 1, value: 'between' },
        ]);

        expect(result).toEqual({
            text: 'hello LinkRPC',
            nested: { value: 2 },
            items: ['a', 'between', 'b'],
        });
    });

    it('supports replacing the document root', () => {
        expect(applyJsonDocumentEdits({ old: true }, [
            { op: 'set', path: '', value: { current: true } },
        ])).toEqual({ current: true });
    });

    it('applies batches atomically without mutating the source', () => {
        const source: JsonValue = { text: 'before', items: [] };
        expect(() => applyJsonDocumentEdits(source, [
            { op: 'set', path: '/text', value: 'changed' },
            { op: 'append', path: '/items', value: 'invalid' },
        ])).toThrow();
        expect(source).toEqual({ text: 'before', items: [] });
    });

    it('decodes RFC 6901 pointer escapes', () => {
        expect(parseJsonPointer('/a~1b/~0key')).toEqual(['a/b', '~key']);
    });

    it('rejects invalid paths and operation targets', () => {
        expect(() => parseJsonPointer('missing-slash')).toThrow('Invalid JSON Pointer');
        expect(() => applyJsonDocumentEdits({ items: [] }, [
            { op: 'append', path: '/items', value: 'x' },
        ])).toThrow('Append target is not a string');
        expect(() => applyJsonDocumentEdits({ items: [] }, [
            { op: 'insert', path: '/items', index: 2, value: 'x' },
        ])).toThrow('out of bounds');
    });
});
