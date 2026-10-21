import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './cli';
import { internalCompleteCommand } from './commands/internalComplete';
import { ContextStore } from './contexts';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('context command', () => {
    it('does not implicitly create a context when setting values', async () => {
        vi.spyOn(ContextStore.prototype, 'select').mockResolvedValue({
            reference: { kind: 'empty' }, context: undefined,
            selectedBy: 'empty', explicitlySelected: false,
        });
        const write = vi.spyOn(ContextStore.prototype, 'set');
        await expect(main(['context', 'set', '--endpoint', 'ws://localhost:7000'], 'hub'))
            .rejects.toThrow('--new-context .');
        expect(write).not.toHaveBeenCalled();
    });

    it('creates only the requested context with context set --new-context', async () => {
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        vi.spyOn(ContextStore.prototype, 'select').mockResolvedValue({
            reference: { kind: 'empty' }, context: undefined,
            selectedBy: 'empty', explicitlySelected: false,
        });
        vi.spyOn(ContextStore.prototype, 'assertCanCreate').mockResolvedValue();
        const write = vi.spyOn(ContextStore.prototype, 'replace').mockImplementation(async (reference, values) => ({
            key: 'id:new', reference, values, createdAt: '', updatedAt: '',
        }));
        const set = vi.spyOn(ContextStore.prototype, 'set');
        await main(['context', 'set', '--new-context', 'id:new', '--endpoint', 'ws://localhost:7000'], 'hub');
        expect(write).toHaveBeenCalledWith(
            { kind: 'id', id: 'new' }, expect.objectContaining({ endpoint: 'ws://localhost:7000' }),
            { createOnly: true },
        );
        expect(set).not.toHaveBeenCalled();
    });

    it('requires an existing selection even for context set', async () => {
        const select = vi.spyOn(ContextStore.prototype, 'select').mockRejectedValue(new Error('context is missing; use --new-context'));
        const write = vi.spyOn(ContextStore.prototype, 'set');
        await expect(main(['context', 'set', '--context', 'id:missing', '--endpoint', 'ws://localhost:7000'], 'hub'))
            .rejects.toThrow('--new-context');
        expect(select).toHaveBeenCalledWith(expect.objectContaining({ selector: 'id:missing' }));
        expect(select.mock.calls[0][0]?.allowMissing).not.toBe(true);
        expect(write).not.toHaveBeenCalled();
    });

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
            'create\tCreate a context.',
            'list\tList stored contexts.',
            'remove\tRemove the selected context.',
            'set\tSet values on the selected context.',
            'show\tShow stored context defaults only.',
        ]);
    });
});
