import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './cli';
import { ContextStore } from './contexts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function selectEmptyContext(): void {
    vi.spyOn(ContextStore.prototype, 'select').mockResolvedValue({
        reference: { kind: 'empty' },
        context: undefined,
        selectedBy: 'empty',
        explicitlySelected: false,
    });
}

async function runMissingEndpoint(args: string[]): Promise<string> {
    selectEmptyContext();
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`exit ${code}`);
    });

    await expect(main(args)).rejects.toThrow('exit 2');
    return stderr;
}

async function runHelp(args: string[]): Promise<string> {
    selectEmptyContext();
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk);
        return true;
    });
    await main(args);
    return stdout;
}

describe('endpoint guidance', () => {
    it.each(['LINKRPC_ENDPOINT', 'HUBRPC_ENDPOINT'])('explains the ignored %s in the RPC profile', async variable => {
        vi.stubEnv('LINKRPC_ENDPOINT', undefined);
        vi.stubEnv('HUBRPC_ENDPOINT', undefined);
        vi.stubEnv('LINKRPC_TOKEN', undefined);
        vi.stubEnv('HUBRPC_TOKEN', undefined);
        vi.stubEnv(variable, 'ws://ignored.example');
        const stderr = await runMissingEndpoint([
            '--context', ':empty', 'call', 'acme.email::send', '--params={}',
        ]);

        expect(stderr).toContain('--endpoint / --endpoint-cmd / --endpoint-cmd-stdio');
        expect(stderr).toContain('or a configured context');
        expect(stderr).toContain(`${variable} is set but only used by hub commands`);
        expect(stderr).toContain('run `linkrpc hub <command>` (or pass --use-env)');
    });

    it('does not advertise endpoint environment variables in RPC call help when unset', async () => {
        vi.stubEnv('LINKRPC_ENDPOINT', undefined);
        vi.stubEnv('HUBRPC_ENDPOINT', undefined);
        vi.stubEnv('LINKRPC_TOKEN', undefined);
        vi.stubEnv('HUBRPC_TOKEN', undefined);
        const stdout = await runHelp([
            '--context', ':empty', 'call', 'acme.email::send', '--help',
        ]);

        expect(stdout).toContain('--endpoint / --endpoint-cmd / --endpoint-cmd-stdio');
        expect(stdout).toContain('or a configured context');
        expect(stdout).not.toContain('LINKRPC_ENDPOINT');
    });

    it('explains the ignored endpoint variable in RPC call help', async () => {
        vi.stubEnv('LINKRPC_ENDPOINT', undefined);
        vi.stubEnv('HUBRPC_ENDPOINT', 'ws://ignored.example');
        vi.stubEnv('LINKRPC_TOKEN', undefined);
        vi.stubEnv('HUBRPC_TOKEN', undefined);
        const stdout = await runHelp([
            '--context', ':empty', 'call', 'acme.email::send', '--help',
        ]);

        expect(stdout).toContain('HUBRPC_ENDPOINT is set but only used by hub commands');
        expect(stdout).toContain('run `linkrpc hub <command>` (or pass --use-env)');
    });

    it('advertises LINKRPC_ENDPOINT in hub-profile call help', async () => {
        vi.stubEnv('LINKRPC_ENDPOINT', undefined);
        vi.stubEnv('HUBRPC_ENDPOINT', undefined);
        vi.stubEnv('LINKRPC_TOKEN', undefined);
        vi.stubEnv('HUBRPC_TOKEN', undefined);
        const stdout = await runHelp(['hub', 'call', 'acme.email::send', '--help']);

        expect(stdout).toContain('LINKRPC_ENDPOINT');
        expect(stdout).not.toContain('only used by hub commands');
    });
});
