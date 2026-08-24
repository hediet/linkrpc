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
    { name: '--provision-identity', takesValue: false },
    { name: '--provision-identity-slot', takesValue: true, valueType: 'free' },
    {
        name: '--principal',
        takesValue: true,
        valueType: 'free',
        description: '"managed", "user:<id>", or "file:<path>"',
    },
];

export const COMMAND_TREE: CommandTree = {
    globalOptions: ENDPOINT_GLOBAL_OPTIONS,
    subcommands: [
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
            description: 'Print an interface schema.',
            positionals: [{ name: 'interfaceRef', type: 'interfaceRef' }],
            options: [
                { name: '--method', takesValue: true, valueType: 'free' },
                { name: '--service', takesValue: true, valueType: 'serviceId' },
                { name: '--json', takesValue: false },
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
        {
            name: 'ping',
            description: 'One reflection round-trip; prints latency.',
            positionals: [],
            options: [],
        },
        {
            name: 'identity',
            description: 'Inspect the persistent principal used by connected CLI commands.',
            positionals: [{ name: 'command', type: 'free' }],
            options: [{ name: '--json', takesValue: false }],
        },
        {
            name: 'approval',
            description: 'Inspect and decide pending Hub access approval requests.',
            positionals: [
                { name: 'command', type: 'free' },
                { name: 'request-id', type: 'free' },
            ],
            options: [
                { name: '--json', takesValue: false },
                { name: '--reason', takesValue: true, valueType: 'free' },
            ],
        },
        {
            name: 'node',
            description: "Run a node script under the supervisor's managed identity.",
            positionals: [{ name: 'script', type: 'free' }],
            variadic: 'free',
            options: [
                { name: '--pty', takesValue: false },
                { name: '--no-pty', takesValue: false },
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
            name: 'ui',
            description: 'Launch the terminal UI.',
            positionals: [],
            options: [],
        },
        {
            name: 'logout',
            description: 'Delete the stored CLI identity.',
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
    ],
};

/**
 * Look up a flag by its long-form name. Searches the active subcommand's
 * options first, then global options. `--foo=value` is normalized to `--foo`
 * before the lookup.
 */
export function findFlag(
    name: string,
    subcommand: SubcommandDef | undefined,
    tree: CommandTree,
): FlagDef | undefined {
    const eq = name.indexOf('=');
    const flagName = eq >= 0 ? name.slice(0, eq) : name;
    return subcommand?.options.find((o) => o.name === flagName)
        ?? tree.globalOptions.find((o) => o.name === flagName);
}
