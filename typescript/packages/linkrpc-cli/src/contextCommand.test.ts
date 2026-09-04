import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './cli';
import { internalCompleteCommand } from './commands/internalComplete';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('context command', () => {
    it('combines selection, policy, stored defaults, and effective values', async () => {
        let output = '';
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            output += String(chunk);
            return true;
        });

        await main([
            'context',
            '--context', ':empty',
            '--endpoint', 'wss://hub.example.test?token=%',
            '--endpoint-token', 'secret',
        ], 'hub');

        expect(output).toBe([
            'Context',
            '  Reference: :empty',
            '  Selected via: --context',
            '  Profile: hub',
            '  Environment overrides: disabled',
            '',
            'Stored defaults',
            '  (none)',
            '',
            'Effective values',
            '  --endpoint = wss://hub.example.test?token=%  (command line)',
            '  --endpoint-token = <stored>  (command line)',
            '',
        ].join('\n'));
        expect(output).not.toContain('secret');
    });

    it('does not offer the former resolve subcommand', async () => {
        const output = await internalCompleteCommand({
            line: 'hub context ',
            point: 'hub context '.length,
            skipConnect: true,
        });

        expect(output.split('\n')).toEqual([
            'list\tList stored contexts.',
            'remove\tRemove the selected context.',
            'set\tSet values on the selected context.',
            'show\tShow stored context defaults only.',
        ]);
    });
});
