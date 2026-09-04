/**
 * Static description of the CLI's command surface, used to drive
 * completion. The runtime CLI is defined with `commander` in {@link ../cli};
 * this table mirrors it. A drift test
 * ({@link ./tree.test.ts}) verifies subcommand & flag names match.
 *
 * Keeping the tree static (rather than introspecting commander at
 * completion time) lets the completer run with zero startup cost in the
 * common static-only case and keeps the slot-resolution logic completely
 * pure — straightforward to unit-test.
 */

export type SlotType =
    /** A bare or qualified `[svc::][iface::]method[@hash]` reference. */
    | 'methodRef'
    /** A bare `interfaceId[@hash]` (e.g. `schema <interfaceRef>`). */
    | 'interfaceRef'
    /** A service id known to the hub. */
    | 'serviceId'
    /** A bare interface id, sans hash. */
    | 'interfaceId'
    /** One of the supported shell names (powershell, bash, zsh, fish). */
    | 'shell'
    /** Anything else — completer returns no dynamic suggestions. */
    | 'free';

export interface FlagDef {
    readonly name: string;
    readonly takesValue: boolean;
    readonly valueType?: SlotType;
    readonly description?: string;
}

export interface PositionalDef {
    readonly name: string;
    readonly type: SlotType;
}

export interface SubcommandDef {
    readonly name: string;
    readonly description: string;
    readonly options: readonly FlagDef[];
    readonly positionals: readonly PositionalDef[];
    readonly subcommands?: readonly SubcommandDef[];
    /** When set, extra positionals beyond {@link positionals} are completed as this type. */
    readonly variadic?: SlotType;
    /** Hide from subcommand-name completion (used for `_complete`). */
    readonly hidden?: boolean;
}

export interface CommandTree {
    readonly globalOptions: readonly FlagDef[];
    readonly subcommands: readonly SubcommandDef[];
}

const ENDPOINT_GLOBAL_OPTIONS: readonly FlagDef[] = [
    { name: '--endpoint', takesValue: true, valueType: 'free', description: 'endpoint URI' },
    { name: '--endpoint-cmd', takesValue: true, valueType: 'free' },
    { name: '--endpoint-cmd-stdio', takesValue: true, valueType: 'free' },
    { name: '--endpoint-cmd-env', takesValue: true, valueType: 'free' },
    { name: '--endpoint-cmd-cwd', takesValue: true, valueType: 'free' },
    { name: '--endpoint-token', takesValue: true, valueType: 'free' },
    { name: '--context', takesValue: true, valueType: 'free' },
    { name: '--context-set', takesValue: false },
    { name: '--new-context', takesValue: true, valueType: 'free' },
    { name: '--schema', takesValue: true, valueType: 'free' },
    { name: '--validation', takesValue: true, valueType: 'free' },
    { name: '--use-env', takesValue: false },
    { name: '--no-use-env', takesValue: false },
    { name: '--provision-identity', takesValue: false },
    { name: '--provision-identity-slot', takesValue: true, valueType: 'free' },
    {
        name: '--principal',
        takesValue: true,
        valueType: 'free',
        description: '"managed", "user:<id>", or "file:<path>"',
    },
];

const HUB_GLOBAL_OPTIONS: readonly FlagDef[] = [
    ...ENDPOINT_GLOBAL_OPTIONS,
    { name: '--config', takesValue: true, valueType: 'free' },
];

const SHARED_COMMANDS: readonly SubcommandDef[] = [
    {
            name: 'ls',
            description: 'List services and interfaces.',
            positionals: [],
            options: [
                { name: '--interface', takesValue: true, valueType: 'interfaceId' },
                { name: '--service', takesValue: true, valueType: 'serviceId' },
                { name: '--depth', takesValue: true, valueType: 'free' },
                { name: '--with-members', takesValue: false },
                { name: '--json', takesValue: false },
                { name: '--dump', takesValue: true, valueType: 'free' },
                { name: '--dump-patches', takesValue: true, valueType: 'free' },
                { name: '--stream', takesValue: false },
                { name: '--watch', takesValue: false },
            ],
        },
    {
            name: 'defaults',
            description: 'Print the preset service / interface.',
            positionals: [],
            options: [{ name: '--json', takesValue: false }],
        },
    {
            name: 'schema',
            description: 'Inspect, hash, and compare interface schemas.',
        positionals: [{ name: 'interfaceRef', type: 'interfaceRef' }],
            options: [],
            subcommands: [
                {
                    name: 'show',
                    description: 'Print an interface schema.',
                    positionals: [{ name: 'interfaceRef', type: 'interfaceRef' }],
                    options: [
                        { name: '--method', takesValue: true, valueType: 'free' },
                        { name: '--service', takesValue: true, valueType: 'serviceId' },
                        { name: '--json', takesValue: false },
                    ],
                },
                {
                    name: 'hash',
                    description: 'Hash a local schema.',
                    positionals: [{ name: 'schema', type: 'free' }],
                    options: [],
                },
                {
                    name: 'check-compat',
                    description: 'Compare a local schema against the live one.',
                    positionals: [
                        { name: 'interfaceId', type: 'interfaceId' },
                        { name: 'local', type: 'free' },
                    ],
                    options: [],
                },
            ],
        },
    {
            name: 'call',
            description: 'Invoke a request.',
            positionals: [{ name: 'methodRef', type: 'methodRef' }],
            options: [
                { name: '--params', takesValue: true, valueType: 'free' },
                { name: '--param', takesValue: true, valueType: 'free' },
                { name: '--no-validate', takesValue: false },
            ],
        },
    {
            name: 'notify',
            description: 'Fire a notification (no response).',
            positionals: [{ name: 'methodRef', type: 'methodRef' }],
            options: [
                { name: '--params', takesValue: true, valueType: 'free' },
                { name: '--param', takesValue: true, valueType: 'free' },
                { name: '--no-validate', takesValue: false },
            ],
        },
    {
        name: 'batch',
        description: 'Run sequential calls and notifications.',
        positionals: [],
        variadic: 'free',
        options: [],
    },
    {
        name: 'connection',
        description: 'Manage persistent RPC connections.',
        positionals: [],
        options: [],
        subcommands: [
            {
                name: 'create',
                description: 'Create a persistent connection.',
                positionals: [],
                options: [
                    { name: '--timeout', takesValue: true, valueType: 'free' },
                    { name: '--ttl', takesValue: true, valueType: 'free' },
                    { name: '--notification-limit', takesValue: true, valueType: 'free' },
                ],
            },
            {
                name: 'status',
                description: 'Show persistent connection status.',
                positionals: [],
                options: [],
            },
            {
                name: 'notifications',
                description: 'Read buffered server notifications.',
                positionals: [],
                options: [
                    { name: '--after', takesValue: true, valueType: 'free' },
                    { name: '--wait', takesValue: true, valueType: 'free' },
                    { name: '--follow', takesValue: false },
                ],
            },
            {
                name: 'destroy',
                description: 'Destroy a persistent connection.',
                positionals: [],
                options: [],
            },
        ],
    },
    {
        name: 'context',
        description: 'Show how the active context resolves, or modify its defaults.',
        positionals: [],
        options: [],
        subcommands: [
            { name: 'show', description: 'Show stored context defaults only.', positionals: [], options: [] },
            { name: 'list', description: 'List stored contexts.', positionals: [], options: [] },
            {
                name: 'set',
                description: 'Set values on the selected context.',
                positionals: [],
                options: [{ name: '--unset', takesValue: true, valueType: 'free' }],
            },
            { name: 'remove', description: 'Remove the selected context.', positionals: [], options: [] },
        ],
    },
    {
            name: 'ping',
            description: 'One reflection round-trip; prints latency.',
            positionals: [],
            options: [],
        },
    {
            name: 'ui',
            description: 'Launch the terminal UI.',
            positionals: [],
            options: [],
        },
    {
            name: 'completions',
            description: 'Print a shell completion script for the requested shell.',
            positionals: [{ name: 'shell', type: 'shell' }],
            options: [],
        },
    {
            name: '_complete',
            description: '(internal) Emit completion candidates for a partial command line.',
            positionals: [],
            options: [
                { name: '--line', takesValue: true, valueType: 'free' },
                { name: '--point', takesValue: true, valueType: 'free' },
            ],
            hidden: true,
        },
    {
        name: 'connect',
        description: 'Legacy alias for connection create.',
        positionals: [],
        options: [
            { name: '--timeout', takesValue: true, valueType: 'free' },
            { name: '--ttl', takesValue: true, valueType: 'free' },
            { name: '--notification-limit', takesValue: true, valueType: 'free' },
        ],
    },
    {
        name: 'connection-status',
        description: 'Legacy alias for connection status.',
        positionals: [],
        options: [],
    },
    {
        name: 'notifications',
        description: 'Legacy alias for connection notifications.',
        positionals: [],
        options: [
            { name: '--after', takesValue: true, valueType: 'free' },
            { name: '--wait', takesValue: true, valueType: 'free' },
            { name: '--follow', takesValue: false },
        ],
    },
    {
        name: 'disconnect',
        description: 'Legacy alias for connection destroy.',
        positionals: [],
        options: [],
    },
    {
        name: 'hash',
        description: 'Legacy alias for schema hash.',
        positionals: [{ name: 'schema', type: 'free' }],
        options: [],
    },
    {
        name: 'check-compat',
        description: 'Legacy alias for schema check-compat.',
        positionals: [
            { name: 'interfaceId', type: 'interfaceId' },
            { name: 'local', type: 'free' },
        ],
        options: [],
    },
];

const HUB_ONLY_COMMANDS: readonly SubcommandDef[] = [
    {
        name: 'topology',
        description: 'Inspect the merged transport topology.',
        positionals: [],
        options: [
            { name: '--source', takesValue: true, valueType: 'serviceId' },
            { name: '--depth', takesValue: true, valueType: 'free' },
            { name: '--node', takesValue: true, valueType: 'free' },
            { name: '--service', takesValue: true, valueType: 'serviceId' },
            { name: '--kind', takesValue: true, valueType: 'free' },
            { name: '--search', takesValue: true, valueType: 'free' },
            { name: '--format', takesValue: true, valueType: 'free' },
            { name: '--json', takesValue: false },
            { name: '--stream', takesValue: false },
            { name: '--watch', takesValue: false },
        ],
        subcommands: [{
            name: 'participants',
            description: 'List participant nodes.',
            positionals: [],
            options: [
                { name: '--search', takesValue: true, valueType: 'free' },
                { name: '--json', takesValue: false },
            ],
        }],
    },
    {
        name: 'traffic',
        description: 'Observe participant traffic.',
        positionals: [],
        options: [],
        subcommands: [{
            name: 'watch',
            description: 'Watch node-wide traffic.',
            positionals: [],
            options: [
                { name: '--search', takesValue: true, valueType: 'free' },
                { name: '--node', takesValue: true, valueType: 'free' },
                { name: '--method', takesValue: true, valueType: 'free' },
                { name: '--payloads', takesValue: true, valueType: 'free' },
                { name: '--format', takesValue: true, valueType: 'free' },
                { name: '--resume', takesValue: true, valueType: 'free' },
            ],
        }],
    },
    {
            name: 'identity',
            description: 'Inspect the persistent principal used by connected CLI commands.',
            positionals: [],
            options: [],
            subcommands: [{
                name: 'show',
                description: 'Show the resolved principal.',
                positionals: [],
                options: [{ name: '--json', takesValue: false }],
            }],
        },
    {
            name: 'approval',
            description: 'Inspect and decide pending Hub access approval requests.',
            positionals: [],
            options: [],
            subcommands: [
                {
                    name: 'requests',
                    description: 'List pending requests.',
                    positionals: [],
                    options: [{ name: '--json', takesValue: false }],
                },
                {
                    name: 'approve',
                    description: 'Approve a pending request.',
                    positionals: [{ name: 'request-id', type: 'free' }],
                    options: [{ name: '--json', takesValue: false }],
                },
                {
                    name: 'deny',
                    description: 'Deny a pending request.',
                    positionals: [{ name: 'request-id', type: 'free' }],
                    options: [
                        { name: '--reason', takesValue: true, valueType: 'free' },
                        { name: '--json', takesValue: false },
                    ],
                },
                { name: 'ui', description: 'Open the approval UI.', positionals: [], options: [] },
            ],
        },
    {
            name: 'serve',
            description: 'Run a configured hub.',
            positionals: [{ name: 'config', type: 'free' }],
            options: [
                { name: '--print-schema', takesValue: false },
                { name: '--cmd-interactive', takesValue: false },
            ],
        },
    {
            name: 'tunnel',
            description: 'Claim a serviceId on the source hub and forward to a target.',
            positionals: [{ name: 'serviceId', type: 'serviceId' }],
            options: [
                { name: '--target-endpoint', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-cmd', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-cmd-stdio', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-cmd-env', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-cmd-cwd', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-token', takesValue: true, valueType: 'free' },
            ],
        },
    {
            name: 'connect-as',
            description: 'Mint a slot identity from a connectionTokenBinder service and splice a target onto the hub as that slot.',
            positionals: [
                { name: 'binderServiceId', type: 'serviceId' },
                { name: 'slot', type: 'free' },
            ],
            options: [
                { name: '--hub-endpoint', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-cmd', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-cmd-stdio', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-cmd-env', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-cmd-cwd', takesValue: true, valueType: 'free' },
                { name: '--target-endpoint-token', takesValue: true, valueType: 'free' },
                { name: '--granted-service-id', takesValue: true, valueType: 'serviceId' },
            ],
        },
    {
            name: 'mcp-forward',
            description: 'Expose an MCP server through the hub.',
            positionals: [],
            variadic: 'free',
            options: [
                { name: '--serviceId', takesValue: true, valueType: 'serviceId' },
                { name: '--env', takesValue: true, valueType: 'free' },
            ],
        },
    {
            name: 'logout',
            description: 'Delete the stored CLI identity.',
            positionals: [],
            options: [],
        },
];

export const HUB_COMMAND_TREE: CommandTree = {
    globalOptions: HUB_GLOBAL_OPTIONS,
    subcommands: [...SHARED_COMMANDS, ...HUB_ONLY_COMMANDS],
};

export const RPC_COMMAND_TREE: CommandTree = {
    globalOptions: ENDPOINT_GLOBAL_OPTIONS,
    subcommands: [
        ...SHARED_COMMANDS,
        {
            name: 'hub',
            description: 'Use the hub profile.',
            positionals: [],
            options: [{ name: '--config', takesValue: true, valueType: 'free' }],
            subcommands: [...SHARED_COMMANDS, ...HUB_ONLY_COMMANDS],
        },
    ],
};

/** Hub-profile tree retained as the default for direct resolver consumers. */
export const COMMAND_TREE = HUB_COMMAND_TREE;

/**
 * Look up a flag by its long-form name from the leaf command through its
 * ancestors, then from the global options.
 */
export function findFlag(
    name: string,
    commandPath: readonly SubcommandDef[],
    tree: CommandTree,
): FlagDef | undefined {
    const eq = name.indexOf('=');
    const flagName = eq >= 0 ? name.slice(0, eq) : name;
    for (let index = commandPath.length - 1; index >= 0; index--) {
        const flag = commandPath[index].options.find((option) => option.name === flagName);
        if (flag !== undefined) return flag;
    }
    return tree.globalOptions.find((option) => option.name === flagName);
}
