import { describe, expect, it } from 'vitest';
import { rewriteParamShortcuts } from './paramFlags';

describe('rewriteParamShortcuts', () => {
    const assignmentForms = [
        ['--p:path=/workspace/a'],
        ['--p:path', '/workspace/a'],
        ['--param', 'path=/workspace/a'],
        ['--param=path=/workspace/a'],
    ];
    const shortcutCases = [
        { flag: '--cap:allow-prefix', value: '/workspace/', matcher: { prefix: '/workspace/' } },
        { flag: '--cap:allow-enum', value: '["/workspace/a","/workspace/b"]', matcher: { enum: ['/workspace/a', '/workspace/b'] } },
        { flag: '--cap:allow-subset', value: '["read","write"]', matcher: { subsetOf: ['read', 'write'] } },
    ];

    it.each(assignmentForms)('attaches prefix constraints to assignment %j', (...assignment) => {
        const normalized = rewriteParamShortcuts([...assignment, '--cap:allow-prefix=/workspace/']);
        expect(normalized.slice(-2)).toEqual(['--cap:allow-param', 'path={"prefix":"/workspace/"}']);
    });

    for (const { flag, value, matcher } of shortcutCases) {
        it.each([false, true])(`supports ${flag} with equals=%s`, equals => {
            expect(rewriteParamShortcuts([
                'call', 'files::fs::read', '--cap:request', '--p:path=/workspace/a',
                ...(equals ? [`${flag}=${value}`] : [flag, value]),
            ])).toEqual([
                'call', 'files::fs::read', '--cap:request', '--param', 'path=/workspace/a',
                '--cap:allow-param', `path=${JSON.stringify(matcher)}`,
            ]);
        });
    }

    it('normalizes any, empty prefixes, empty subsets, and complex enums without changing data', () => {
        expect(rewriteParamShortcuts(['--p:x=42', '--cap:allow-any']))
            .toEqual(['--param', 'x=42', '--cap:allow-param', 'x={"any":true}']);
        expect(rewriteParamShortcuts(['--p:x=a', '--cap:allow-prefix=']).slice(-1)).toEqual(['x={"prefix":""}']);
        expect(rewriteParamShortcuts(['--p:x=[]', '--cap:allow-subset=[]']).slice(-1)).toEqual(['x={"subsetOf":[]}']);
        expect(rewriteParamShortcuts(['--p:x=null', '--cap:allow-enum=[null,42,true,{"a":1},["x"]]']).slice(-1))
            .toEqual(['x={"enum":[null,42,true,{"a":1},["x"]]}']);
    });

    it('attaches to the last variadic parameter and supports distinct constrained parameters', () => {
        expect(rewriteParamShortcuts([
            '--param', 'mode=text', 'path=/docs/a', '--cap:allow-prefix=/docs/',
            '--p:tags=["read"]', '--cap:allow-subset=["read","write"]',
        ])).toEqual([
            '--param', 'mode=text', 'path=/docs/a', '--cap:allow-param', 'path={"prefix":"/docs/"}',
            '--param', 'tags=["read"]', '--cap:allow-param', 'tags={"subsetOf":["read","write"]}',
        ]);
    });

    it.each([
        ['--cap:allow-prefix=/docs/'],
        ['--params', '{"path":"/docs/a"}', '--cap:allow-prefix=/docs/'],
        ['--p:path=a', '--cap:request', '--cap:allow-any'],
        ['--p:path.nested=a', '--cap:allow-any'],
        ['--p:path=a', '--cap:allow-prefix'],
        ['--p:path=a', '--cap:allow-enum=invalid'],
        ['--p:path=a', '--cap:allow-enum=[]'],
        ['--p:path=a', '--cap:allow-enum={}'],
        ['--p:path=a', '--cap:allow-subset=[42]'],
        ['--p:path=a', '--cap:allow-any=true'],
        ['--p:path=a', '--cap:allow-prefix', '--cap:request'],
        ['--p:path=a', '--cap:allow-prefix=/docs/', '--cap:allow-any'],
        ['--p:path=a', '--cap:allow-prefix=/docs/', '--cap:allow-param', 'path={"any":true}'],
        ['--cap:allow-param=path={"any":true}', '--p:path=a', '--cap:allow-prefix=/docs/'],
        ['--p:path=a', '--cap:allow-any', '--p:path=b'],
        ['--cap:allow-param', 'path={"any":true}', 'path={"prefix":"/docs/"}'],
    ])('rejects malformed or ambiguous constraints %j', (...args) => {
        expect(() => rewriteParamShortcuts(args)).toThrow();
    });

    it('preserves literal dash-prefixed values with equals and spaces in prefixes', () => {
        expect(rewriteParamShortcuts(['--p:path=-value', '--cap:allow-prefix=-']).slice(-1))
            .toEqual(['path={"prefix":"-"}']);
        expect(rewriteParamShortcuts(['--p:path', '/my project/a', '--cap:allow-prefix', '/my project/']).slice(-1))
            .toEqual(['path={"prefix":"/my project/"}']);
    });

    it('does not interpret constraints past the end-of-options marker', () => {
        expect(rewriteParamShortcuts(['--', '--p:path=a', '--cap:allow-any']))
            .toEqual(['--', '--p:path=a', '--cap:allow-any']);
    });
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

    it('shares shortcuts with caps request and inline capability requests', () => {
        expect(rewriteParamShortcuts([
            'caps', 'request', 'files::fs::read', '--p:path=/docs/a',
            '--cap:allow-param', 'path={"prefix":"/docs/"}',
        ])).toEqual([
            'caps', 'request', 'files::fs::read', '--param', 'path=/docs/a',
            '--cap:allow-param', 'path={"prefix":"/docs/"}',
        ]);
        expect(rewriteParamShortcuts([
            'call', 'files::fs::read', '--cap:request', '--p:path', '/docs/a',
        ])).toEqual([
            'call', 'files::fs::read', '--cap:request', '--param', 'path=/docs/a',
        ]);
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
