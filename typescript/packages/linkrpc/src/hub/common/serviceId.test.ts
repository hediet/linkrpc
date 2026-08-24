import { describe, expect, it } from 'vitest';
import {
    isServiceIdUnder,
    isValidServiceId,
    ROOT_SERVICE_ID,
    splitServiceId,
} from './serviceId';

describe('isValidServiceId', () => {
    it('treats the root ("") as valid', () => {
        expect(isValidServiceId(ROOT_SERVICE_ID)).toBe(true);
        expect(isValidServiceId('')).toBe(true);
    });

    it('accepts single and multi-segment ids', () => {
        expect(isValidServiceId('foo')).toBe(true);
        expect(isValidServiceId('foo/bar')).toBe(true);
        expect(isValidServiceId('a/b/c')).toBe(true);
    });

    it('rejects leading, trailing, and empty segments', () => {
        expect(isValidServiceId('/')).toBe(false);
        expect(isValidServiceId('/foo')).toBe(false);
        expect(isValidServiceId('foo/')).toBe(false);
        expect(isValidServiceId('foo//bar')).toBe(false);
    });
});

describe('splitServiceId', () => {
    it('yields the empty array for the root', () => {
        expect(splitServiceId('')).toEqual([]);
    });

    it('splits on "/"', () => {
        expect(splitServiceId('foo')).toEqual(['foo']);
        expect(splitServiceId('foo/bar')).toEqual(['foo', 'bar']);
    });
});

describe('isServiceIdUnder', () => {
    it('the root prefix covers everything', () => {
        expect(isServiceIdUnder('anything/here', '')).toBe(true);
        expect(isServiceIdUnder('', '')).toBe(true);
    });

    it('covers the prefix itself and its descendants', () => {
        expect(isServiceIdUnder('a/b', 'a/b')).toBe(true);
        expect(isServiceIdUnder('a/b/c', 'a/b')).toBe(true);
    });

    it('is segment-aware', () => {
        expect(isServiceIdUnder('a/bc', 'a/b')).toBe(false);
        expect(isServiceIdUnder('a', 'a/b')).toBe(false);
    });
});
