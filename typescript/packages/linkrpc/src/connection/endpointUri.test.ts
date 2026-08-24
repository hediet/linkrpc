import { describe, expect, it } from 'vitest';
import {
    type ResolvedEndpoint,
    formatEndpointUri,
    isHubEndpoint,
    parseEndpointUri,
} from './endpointUri';

describe('parseEndpointUri', () => {
    it('parses unix: socket with token', () => {
        expect(parseEndpointUri('unix:/run/hub/hub.sock?token=abc')).toEqual({
            kind: 'socket',
            path: '/run/hub/hub.sock',
            token: 'abc',
        });
    });

    it('parses unix: socket without token', () => {
        expect(parseEndpointUri('unix:/run/hub/hub.sock')).toEqual({
            kind: 'socket',
            path: '/run/hub/hub.sock',
        });
    });

    it('parses npipe: into a Windows pipe path', () => {
        expect(parseEndpointUri('npipe://./pipe/linkrpc?token=t')).toEqual({
            kind: 'socket',
            path: '\\\\.\\pipe\\linkrpc',
            token: 't',
        });
    });

    it('parses broker mode on a socket endpoint', () => {
        expect(parseEndpointUri('npipe://./pipe/linkrpc?token=t&broker=raw')).toEqual({
            kind: 'socket',
            path: '\\\\.\\pipe\\linkrpc',
            token: 't',
            brokerMode: 'raw',
        });
    });

    it('rejects invalid broker modes', () => {
        expect(() => parseEndpointUri('unix:/run/hub.sock?broker=other'))
            .toThrow(/linkrpc.*raw/);
    });

    it('parses ws: and strips the token into a field', () => {
        expect(parseEndpointUri('ws://host:7700/?token=abc')).toEqual({
            kind: 'ws',
            url: 'ws://host:7700/',
            token: 'abc',
        });
    });

    it('parses wss: without token', () => {
        expect(parseEndpointUri('wss://hub.example.com/')).toEqual({
            kind: 'ws',
            url: 'wss://hub.example.com/',
        });
    });

    it('parses ws-no-init: and preserves protocol-specific query parameters', () => {
        expect(parseEndpointUri('ws-no-init://host:4123/?tkn=abc&client=cli')).toEqual({
            kind: 'ws-no-init',
            url: 'ws://host:4123/?tkn=abc&client=cli',
        });
    });

    it('parses cmd-stdio: with a verbatim command', () => {
        expect(parseEndpointUri('cmd-stdio:?command=node%20server.js%20--port%208080')).toEqual({
            kind: 'cmd-stdio',
            command: { command: 'node server.js --port 8080' },
        });
    });

    it('parses cmd-stdio: with repeated argv', () => {
        expect(parseEndpointUri('cmd-stdio:?argv=node&argv=server.js&argv=--port&argv=8080')).toEqual({
            kind: 'cmd-stdio',
            command: { argv: ['node', 'server.js', '--port', '8080'] },
        });
    });

    it('parses cmd: (env) with a command', () => {
        expect(parseEndpointUri('cmd:?command=node%20server.js')).toEqual({
            kind: 'cmd-env',
            command: { command: 'node server.js' },
        });
    });

    it('parses cmd: cwd into a field', () => {
        expect(parseEndpointUri('cmd:?command=node%20server.js&cwd=%2Fwork%2Fdir')).toEqual({
            kind: 'cmd-env',
            command: { command: 'node server.js' },
            cwd: '/work/dir',
        });
    });

    it('parses cmd-stdio: cwd into a field', () => {
        expect(parseEndpointUri('cmd-stdio:?command=node%20s.js&cwd=%2Fwork%2Fdir')).toEqual({
            kind: 'cmd-stdio',
            command: { command: 'node s.js' },
            cwd: '/work/dir',
        });
    });

    it('prefers argv over command when both present', () => {
        expect(parseEndpointUri('cmd:?command=ignored&argv=node&argv=x')).toEqual({
            kind: 'cmd-env',
            command: { argv: ['node', 'x'] },
        });
    });

    it('auto-detects a bare ws url', () => {
        expect(parseEndpointUri('ws://host:7700')).toEqual({
            kind: 'ws',
            url: 'ws://host:7700/',
        });
    });

    it('auto-detects a bare socket path', () => {
        expect(parseEndpointUri('/tmp/x.sock')).toEqual({
            kind: 'socket',
            path: '/tmp/x.sock',
        });
        expect(parseEndpointUri('\\\\.\\pipe\\foo')).toEqual({
            kind: 'socket',
            path: '\\\\.\\pipe\\foo',
        });
    });

    it('throws on an unknown scheme', () => {
        expect(() => parseEndpointUri('ftp://host/x')).toThrow(/unsupported endpoint scheme/);
    });

    it('throws on a cmd endpoint missing command/argv', () => {
        expect(() => parseEndpointUri('cmd:?foo=bar')).toThrow(/requires a 'command' or 'argv'/);
    });

    it('throws on an empty uri', () => {
        expect(() => parseEndpointUri('   ')).toThrow(/empty/);
    });
});

describe('formatEndpointUri', () => {
    it('redacts the token by default', () => {
        const spec: ResolvedEndpoint = { kind: 'socket', path: '/run/hub.sock', token: 'secret' };
        expect(formatEndpointUri(spec)).toBe('unix:/run/hub.sock?token=***');
    });

    it('reveals the token when asked', () => {
        const spec: ResolvedEndpoint = { kind: 'socket', path: '/run/hub.sock', token: 'secret' };
        expect(formatEndpointUri(spec, { revealToken: true })).toBe('unix:/run/hub.sock?token=secret');
    });

    it('formats a tokenless socket', () => {
        expect(formatEndpointUri({ kind: 'socket', path: '/run/hub.sock' })).toBe('unix:/run/hub.sock');
    });

    it('formats a Windows pipe back to npipe:', () => {
        expect(formatEndpointUri({ kind: 'socket', path: '\\\\.\\pipe\\linkrpc', token: 't' }, { revealToken: true }))
            .toBe('npipe://./pipe/linkrpc?token=t');
    });

    it('formats broker mode on a socket endpoint', () => {
        expect(formatEndpointUri({
            kind: 'socket',
            path: '\\\\.\\pipe\\linkrpc',
            token: 't',
            brokerMode: 'raw',
        }, { revealToken: true })).toBe('npipe://./pipe/linkrpc?token=t&broker=raw');
    });

    it('formats ws with token in the query', () => {
        expect(formatEndpointUri({ kind: 'ws', url: 'wss://host/', token: 'k' }, { revealToken: true }))
            .toBe('wss://host/?token=k');
    });

    it('formats ws-no-init with its query parameters intact', () => {
        expect(formatEndpointUri({
            kind: 'ws-no-init',
            url: 'ws://host:4123/?tkn=abc',
        })).toBe('ws-no-init://host:4123/?tkn=abc');
    });

    it('formats cmd-stdio with argv', () => {
        const spec: ResolvedEndpoint = { kind: 'cmd-stdio', command: { argv: ['node', 'server.js'] } };
        expect(formatEndpointUri(spec)).toBe('cmd-stdio:?argv=node&argv=server.js');
    });

    it('formats cmd-env with a command string', () => {
        const spec: ResolvedEndpoint = { kind: 'cmd-env', command: { command: 'node server.js' } };
        expect(formatEndpointUri(spec)).toBe('cmd:?command=node+server.js');
    });

    it('round-trips through parse with revealToken', () => {
        const cases: ResolvedEndpoint[] = [
            { kind: 'socket', path: '/run/hub.sock', token: 'abc' },
            { kind: 'socket', path: '\\\\.\\pipe\\linkrpc', token: 't' },
            { kind: 'socket', path: '/run/raw.sock', token: 'r', brokerMode: 'raw' },
            { kind: 'ws', url: 'wss://host/', token: 'k' },
            { kind: 'ws-no-init', url: 'ws://host:4123/?tkn=abc' },
            { kind: 'cmd-stdio', command: { argv: ['node', 'server.js', '--port', '8080'] } },
            { kind: 'cmd-env', command: { command: 'node server.js' } },
        ];
        for (const spec of cases) {
            expect(parseEndpointUri(formatEndpointUri(spec, { revealToken: true }))).toEqual(spec);
        }
    });
});

describe('isHubEndpoint', () => {
    it('classifies socket and ws as hub-like', () => {
        expect(isHubEndpoint({ kind: 'socket', path: '/x' })).toBe(true);
        expect(isHubEndpoint({ kind: 'socket', path: '/x', brokerMode: 'raw' })).toBe(false);
        expect(isHubEndpoint({ kind: 'ws', url: 'ws://x' })).toBe(true);
        expect(isHubEndpoint({ kind: 'ws-no-init', url: 'ws://x' })).toBe(false);
        expect(isHubEndpoint({ kind: 'cmd-stdio', command: { command: 'x' } })).toBe(false);
        expect(isHubEndpoint({ kind: 'cmd-env', command: { command: 'x' } })).toBe(false);
    });
});
