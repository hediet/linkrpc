import { describe, expect, it } from 'vitest';
import { resolveCliInvocation } from './cliInvocation';

describe('resolveCliInvocation', () => {
    it('uses RPC defaults for linkrpc and rpc', () => {
        expect(resolveCliInvocation(['call', 'ping'], 'linkrpc').profile).toBe('rpc');
        expect(resolveCliInvocation(['call', 'ping'], 'rpc.cmd').programName).toBe('rpc');
    });

    it('uses hub defaults for the hub executable', () => {
        expect(resolveCliInvocation(['call', 'ping'], 'hub.cmd')).toMatchObject({
            profile: 'hub',
            programName: 'hub',
        });
    });

    it('recognizes hub after inherited options and removes the profile token', () => {
        expect(resolveCliInvocation(
            ['--endpoint', 'ws://example', 'hub', '--context', '.', 'call', 'ping'],
            'linkrpc',
        )).toEqual({
            profile: 'hub',
            programName: 'linkrpc hub',
            argv: ['--endpoint', 'ws://example', '--context', '.', 'call', 'ping'],
        });
    });

    it('rewrites legacy connection commands', () => {
        expect(resolveCliInvocation(['connect', '--ttl', '2h'], 'linkrpc').argv)
            .toEqual(['connection', 'create', '--ttl', '2h']);
        expect(resolveCliInvocation(['notifications', '--follow'], 'hub').argv)
            .toEqual(['connection', 'notifications', '--follow']);
    });

    it('rewrites schema hash and compatibility commands', () => {
        expect(resolveCliInvocation(['hash', 'schema.json'], 'linkrpc').argv)
            .toEqual(['schema', 'hash', 'schema.json']);
        expect(resolveCliInvocation(['check-compat', 'mail', 'local.json'], 'linkrpc').argv)
            .toEqual(['schema', 'check-compat', 'mail', 'local.json']);
    });

    it('treats legacy schema arguments as schema show', () => {
        expect(resolveCliInvocation(
            ['schema', '--endpoint', 'ws://example', 'mail'],
            'linkrpc',
        ).argv).toEqual([
            'schema',
            'show',
            '--endpoint',
            'ws://example',
            'mail',
        ]);
        expect(resolveCliInvocation(['schema', 'hash', 'schema.json'], 'linkrpc').argv)
            .toEqual(['schema', 'hash', 'schema.json']);
    });
});
