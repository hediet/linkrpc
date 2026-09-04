import type { CliProfile } from './invocationContext';

export interface CliInvocation {
    readonly argv: readonly string[];
    readonly profile: CliProfile;
    readonly programName: string;
}

const INHERITED_OPTIONS_WITH_VALUE = new Set([
    '--endpoint',
    '--endpoint-cmd',
    '--endpoint-cmd-stdio',
    '--endpoint-cmd-env',
    '--endpoint-token',
    '--endpoint-cmd-cwd',
    '--config',
    '-c',
    '--provision-identity-slot',
    '--principal',
    '--context',
    '--new-context',
    '--schema',
    '--validation',
]);

const LEGACY_COMMANDS: Readonly<Record<string, readonly string[]>> = {
    connect: ['connection', 'create'],
    'connection-status': ['connection', 'status'],
    notifications: ['connection', 'notifications'],
    disconnect: ['connection', 'destroy'],
    hash: ['schema', 'hash'],
    'check-compat': ['schema', 'check-compat'],
};

const SCHEMA_SUBCOMMANDS = new Set(['show', 'hash', 'check-compat', 'help']);

export function resolveCliInvocation(
    rawArgv: readonly string[],
    executablePath: string | undefined,
): CliInvocation {
    const executable = normalizeCliExecutable(executablePath);
    let profile: CliProfile = executable === 'hub' ? 'hub' : 'rpc';
    let argv = [...rawArgv];
    let commandIndex = findCommandIndex(argv);

    if (profile === 'rpc' && commandIndex !== undefined && argv[commandIndex] === 'hub') {
        argv.splice(commandIndex, 1);
        profile = 'hub';
        commandIndex = findCommandIndex(argv);
    }

    if (commandIndex !== undefined) {
        const command = argv[commandIndex];
        const replacement = LEGACY_COMMANDS[command];
        if (replacement !== undefined) {
            argv.splice(commandIndex, 1, ...replacement);
        } else if (command === 'schema') {
            const schemaMemberIndex = findCommandIndex(argv, commandIndex + 1);
            const schemaMember = schemaMemberIndex === undefined ? undefined : argv[schemaMemberIndex];
            if (schemaMember !== undefined && !SCHEMA_SUBCOMMANDS.has(schemaMember)) {
                argv.splice(commandIndex + 1, 0, 'show');
            }
        }
    }

    const baseName = executable === 'hub' ? 'hub' : executable === 'rpc' ? 'rpc' : 'linkrpc';
    return {
        argv,
        profile,
        programName: profile === 'hub' && executable !== 'hub'
            ? `${baseName} hub`
            : baseName,
    };
}

export function normalizeCliExecutable(executablePath: string | undefined): string {
    if (executablePath === undefined) return 'linkrpc';
    return (executablePath.split(/[\\/]/).pop() ?? executablePath)
        .replace(/\.(?:cmd|exe|js|mjs|cjs)$/i, '');
}

function findCommandIndex(argv: readonly string[], start = 0): number | undefined {
    for (let index = start; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') return undefined;
        if (arg.startsWith('--') && arg.includes('=')) continue;
        if (INHERITED_OPTIONS_WITH_VALUE.has(arg)) {
            index++;
            continue;
        }
        if (arg.startsWith('-')) continue;
        return index;
    }
    return undefined;
}
