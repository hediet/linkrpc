import { describe, expect, it } from 'vitest';
import { CallQuery, callTargetOf, excludeMethodTerm, methodPattern } from './callQuery';
import type { CallRecord } from './callRecord';

function call(method: string, serviceId: string | undefined, overrides: Partial<CallRecord> = {}): CallRecord {
    return {
        v: 1, id: method, at: 0, level: 'info', kind: 'request', status: 'completed', durationMs: 0,
        method, ...(serviceId !== undefined ? { serviceId } : {}), from: { label: 'e1' }, ...overrides,
    };
}

const calls = [
    call('hediet/devbox::hubrpc.directory::list', 'hediet/devbox', { to: { label: 'hediet/devbox', service: 'devtunnel' } }),
    call('hediet/devbox/compute::linkrpc.computeNode.command::run', 'hediet/devbox/compute', { to: { label: 'hediet/devbox', service: 'devtunnel' } }),
    call('hediet/pc2::hubrpc.directory::list', 'hediet/pc2', { from: { label: 'hediet/devbox', service: 'devtunnel' } }),
    call('hediet/pc2/notes::test.echo::echo', 'hediet/pc2/notes', { status: 'failed', error: { code: 1, message: 'no route for x' } }),
    call('::hubrpc.node::getNodeId', undefined),
];

const run = (text: string) => calls.filter(record => CallQuery.parse(text).matches(record)).map(record => record.method);

describe('CallQuery', () => {
    it('combines text and method terms, with negation and quotes', () => {
        expect({
            text: run('directory'),
            textAndNegatedText: run('directory -devbox'),
            negatedServiceAndInterface: run('-method:hediet/devbox::* -method:*::hubrpc.directory::*'),
            quotedPhrase: run('"no route"'),
            rootForm: run('method:::hubrpc.node::*'),
            principalLikeTextIsNotAQualifier: run('id:key:'),
            throughService: run('service:DevTunnel'),
            notThroughServiceButDirectory: run('-service:devtunnel directory'),
        }).toMatchInlineSnapshot(`
          {
            "negatedServiceAndInterface": [
              "hediet/devbox/compute::linkrpc.computeNode.command::run",
              "hediet/pc2/notes::test.echo::echo",
              "::hubrpc.node::getNodeId",
            ],
            "notThroughServiceButDirectory": [],
            "principalLikeTextIsNotAQualifier": [],
            "quotedPhrase": [
              "hediet/pc2/notes::test.echo::echo",
            ],
            "rootForm": [
              "::hubrpc.node::getNodeId",
            ],
            "text": [
              "hediet/devbox::hubrpc.directory::list",
              "hediet/pc2::hubrpc.directory::list",
            ],
            "textAndNegatedText": [],
            "throughService": [
              "hediet/devbox::hubrpc.directory::list",
              "hediet/devbox/compute::linkrpc.computeNode.command::run",
              "hediet/pc2::hubrpc.directory::list",
            ],
          }
        `);
    });

    it('splits methods and builds exclusion terms for each combination', () => {
        const target = callTargetOf(calls[0]!);
        const { serviceId, interfaceId, member } = target;
        expect({
            target,
            root: callTargetOf(calls[4]!),
            terms: [
                excludeMethodTerm({ serviceId }),
                excludeMethodTerm({ serviceId, interfaceId }),
                excludeMethodTerm({ interfaceId }),
                excludeMethodTerm({ interfaceId, member }),
                excludeMethodTerm(target),
            ],
        }).toMatchInlineSnapshot(`
          {
            "root": {
              "interfaceId": "hubrpc.node",
              "member": "getNodeId",
              "serviceId": undefined,
            },
            "target": {
              "interfaceId": "hubrpc.directory",
              "member": "list",
              "serviceId": "hediet/devbox",
            },
            "terms": [
              "-method:hediet/devbox::*",
              "-method:hediet/devbox::hubrpc.directory::*",
              "-method:*::hubrpc.directory::*",
              "-method:*::hubrpc.directory::list",
              "-method:hediet/devbox::hubrpc.directory::list",
            ],
          }
        `);
        expect(methodPattern({})).toBe('*');
    });

    it('appends terms once', () => {
        const once = CallQuery.appendTerm('echo ', '-method:a::*');
        expect([once, CallQuery.appendTerm(once, '-method:a::*'), CallQuery.appendTerm('', 'x')]).toEqual(['echo -method:a::*', 'echo -method:a::*', 'x']);
    });
});
