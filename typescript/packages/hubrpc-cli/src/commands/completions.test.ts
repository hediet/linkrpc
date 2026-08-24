import { describe, expect, it } from 'vitest';
import { internalCompleteCommand } from './internalComplete';
import { completionsCommand } from './completions';
import type { DirectoryEntry, DirectorySource } from '../completions/directorySource';

function makeDir(entries: readonly DirectoryEntry[]): DirectorySource {
    return {
        entries: () => Promise.resolve(entries),
        methodsOnInterface: () => Promise.resolve([]),
        paramNamesForMethod: () => Promise.resolve([]),
    };
}

describe('internalCompleteCommand', () => {
    it('emits TAB-separated `text\\ttooltip` lines', async () => {
        const out = await internalCompleteCommand({
            line: 'hub ca',
            point: 6,
            skipConnect: true,
        });
        expect(out).toBe('call\tInvoke a request.');
    });

    it('emits the text only when there is no tooltip', async () => {
        const out = await internalCompleteCommand({
            line: 'hub completions ',
            point: 16,
            skipConnect: true,
        });
        // bash / fish / powershell / zsh — no tooltips on shell names
        expect(out.split('\n')).toEqual(['bash', 'fish', 'powershell', 'zsh']);
    });

    it('routes dynamic slots through the injected directory override', async () => {
        const out = await internalCompleteCommand({
            line: 'hub tunnel ',
            point: 11,
            directoryOverride: makeDir([
                { serviceId: 'azure-cli', interfaceId: 'Runner', hash: 'h' },
                { serviceId: 'github', interfaceId: 'g', hash: 'h' },
            ]),
        });
        expect(out.split('\n')).toEqual(['azure-cli', 'github']);
    });

    it('returns the empty string when no candidates exist', async () => {
        const out = await internalCompleteCommand({
            line: 'hub ping bogus',
            point: 'hub ping bogus'.length,
            skipConnect: true,
        });
        expect(out).toBe('');
    });
});

describe('completionsCommand', () => {
    it('emits the PowerShell registration script', () => {
        const script = completionsCommand({ shell: 'powershell' });
        // Should contain the native-completer registration and the internal
        // command name the script shells out to.
        expect(script).toMatch(/Register-ArgumentCompleter -Native/);
        expect(script).toMatch(/_complete --line/);
        expect(script).toMatch(/-CommandName hub,hubrpc/);
    });

    it('throws for an unsupported shell', () => {
        expect(() => completionsCommand({ shell: 'csh' })).toThrow(/unsupported shell/);
    });
});
