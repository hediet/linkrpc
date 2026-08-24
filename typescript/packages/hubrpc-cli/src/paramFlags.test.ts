import { describe, expect, it } from 'vitest';
import { rewriteParamShortcuts } from './paramFlags';

describe('rewriteParamShortcuts', () => {
    it('leaves an empty argv alone', () => {
        expect(rewriteParamShortcuts([])).toEqual([]);
    });

    it('passes through tokens that do not start with --p:', () => {
        expect(rewriteParamShortcuts(['call', 'acme.email::send', '--params', '{}']))
            .toEqual(['call', 'acme.email::send', '--params', '{}']);
    });

    it('expands --p:name=value to --param name=value', () => {
        expect(rewriteParamShortcuts(['call', 'foo', '--p:to=a@b.c']))
            .toEqual(['call', 'foo', '--param', 'to=a@b.c']);
    });

    it('expands --p:name value (two tokens) to --param name=value', () => {
        expect(rewriteParamShortcuts(['call', 'foo', '--p:to', 'a@b.c']))
            .toEqual(['call', 'foo', '--param', 'to=a@b.c']);
    });

    it('treats --p:name with no value as boolean true', () => {
        expect(rewriteParamShortcuts(['call', 'foo', '--p:dryRun']))
            .toEqual(['call', 'foo', '--param', 'dryRun=true']);
    });

    it('treats --p:name followed by another flag as boolean true', () => {
        expect(rewriteParamShortcuts(['call', 'foo', '--p:dryRun', '--no-validate']))
            .toEqual(['call', 'foo', '--param', 'dryRun=true', '--no-validate']);
    });

    it('explicit --p:flag=false overrides the boolean default', () => {
        expect(rewriteParamShortcuts(['call', 'foo', '--p:dryRun=false']))
            .toEqual(['call', 'foo', '--param', 'dryRun=false']);
    });

    it('preserves nested-key dot paths', () => {
        expect(rewriteParamShortcuts(['call', 'foo', '--p:user.name=alice']))
            .toEqual(['call', 'foo', '--param', 'user.name=alice']);
    });

    it('preserves JSON values inline', () => {
        expect(rewriteParamShortcuts(['call', 'foo', '--p:count=42']))
            .toEqual(['call', 'foo', '--param', 'count=42']);
        expect(rewriteParamShortcuts(['call', 'foo', '--p:tags', '["a","b"]']))
            .toEqual(['call', 'foo', '--param', 'tags=["a","b"]']);
    });

    it('handles multiple --p: flags in one argv', () => {
        expect(
            rewriteParamShortcuts(['call', 'foo', '--p:to=a@b.c', '--p:subject', 'Hi', '--p:dryRun']),
        ).toEqual([
            'call',
            'foo',
            '--param',
            'to=a@b.c',
            '--param',
            'subject=Hi',
            '--param',
            'dryRun=true',
        ]);
    });

    it('stops expanding after `--`', () => {
        expect(
            rewriteParamShortcuts(['node', 'script.js', '--', '--p:not-a-flag', 'x']),
        ).toEqual(['node', 'script.js', '--', '--p:not-a-flag', 'x']);
    });

    it('leaves malformed --p: prefixes for commander to reject', () => {
        expect(rewriteParamShortcuts(['--p:'])).toEqual(['--p:']);
        expect(rewriteParamShortcuts(['--p:=value'])).toEqual(['--p:=value']);
    });

    it('does not mutate the input array', () => {
        const argv = ['call', 'foo', '--p:to=x'];
        const frozen = Object.freeze(argv);
        rewriteParamShortcuts(frozen);
        expect(argv).toEqual(['call', 'foo', '--p:to=x']);
    });
});
