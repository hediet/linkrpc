/**
 * Endpoint resolution for the CLI = "where the linkrpc server lives, and how to
 * reach (or start) it". The parsed truth is the {@link ResolvedEndpoint} union from
 * `@hediet/linkrpc/node`; this module turns the ergonomic flags / env vars into
 * one.
 *
 * Sources, highest precedence first:
 *   1. `--endpoint-cmd <command>`        → spawn a server, connect via injected env
 *   2. `--endpoint-cmd-stdio <command>`  → spawn a child, talk over its stdio
 *   3. `--endpoint <uri>`                → a literal strict endpoint URI
 *   4. `LINKRPC_ENDPOINT` env var        → legacy bare path / ws url
 *
 * `--endpoint-token` overrides the token from a URI / `LINKRPC_TOKEN` for
 * socket / ws endpoints. At most one of `--endpoint*` may be given.
 * `ws-no-init:` preserves its query string verbatim and therefore does not use
 * `--endpoint-token`.
 */
import {
    type ResolvedEndpoint,
    formatEndpointUri,
    parseEndpointUri,
    LINKRPC_ENDPOINT_VAR,
    LINKRPC_TOKEN_VAR,
} from "@hediet/linkrpc/node";
import { type EndpointConfig } from "./config";
import { resolveProvisionSlot } from "./localHub";

export type { ResolvedEndpoint } from "@hediet/linkrpc/node";

export interface ResolveEndpointInput {
    /** `--endpoint <uri>`: a literal strict endpoint URI. */
    readonly endpoint?: string;
    /** `--endpoint-cmd <command>`: spawn a server, connect via injected env. */
    readonly endpointCmd?: string;
    /** `--endpoint-cmd-stdio <command>`: spawn a child, talk over its stdio. */
    readonly endpointCmdStdio?: string;
    /** `--endpoint-cmd-env <key=value>`: extra env vars for the spawned child. */
    readonly endpointCmdEnv?: Readonly<Record<string, string>>;
    /** `--endpoint-cmd-cwd <dir>`: working directory for the spawned child. */
    readonly endpointCmdCwd?: string;
    /** `--endpoint-token <token>`: overrides the URI / `LINKRPC_TOKEN` token. */
    readonly endpointToken?: string;
    /** `--provision-identity`: provision a persistent identity for `--endpoint-cmd`. */
    readonly provisionIdentity?: boolean;
    /** `--provision-identity-slot <slot>`: explicit reusable slot id for provisioning. */
    readonly provisionIdentitySlot?: string;
    readonly env?: NodeJS.ProcessEnv;
    /**
     * When set, the provisioning options are validated by the caller (e.g. the
     * `tunnel` command, which routes them to its target cmd instead of source).
     * Suppresses the "--provision-identity requires --endpoint-cmd" check.
     */
    readonly provisioningHandledElsewhere?: boolean;
}

export interface ResolveEndpointResult {
    readonly endpoint: ResolvedEndpoint | undefined;
    readonly error: string | undefined;
}

/** Apply a token override to socket / ws specs; commands carry no token. */
function _withToken(spec: ResolvedEndpoint, token: string | undefined): ResolvedEndpoint {
    if (token === undefined) return spec;
    if (spec.kind === "socket") return { ...spec, token };
    if (spec.kind === "ws") return { ...spec, token };
    return spec;
}

/**
 * Resolve the effective endpoint from flags + environment. Returns
 * `{ endpoint: undefined }` when nothing is configured (the caller may then
 * error out). Mutually-exclusive `--endpoint*` flags yield an `error`.
 */
export function resolveEndpoint(input: ResolveEndpointInput): ResolveEndpointResult {
    const env = input.env ?? process.env;
    const explicit = [input.endpoint, input.endpointCmd, input.endpointCmdStdio].filter(
        (v) => v !== undefined,
    );
    if (explicit.length > 1) {
        return {
            endpoint: undefined,
            error: "specify at most one of --endpoint, --endpoint-cmd, --endpoint-cmd-stdio",
        };
    }
    if (
        (input.provisionIdentity === true || input.provisionIdentitySlot !== undefined)
        && input.endpointCmd === undefined
        && input.provisioningHandledElsewhere !== true
    ) {
        return {
            endpoint: undefined,
            error: "--provision-identity / --provision-identity-slot require --endpoint-cmd",
        };
    }
    const cmdEnv = input.endpointCmdEnv;
    const cmdCwd = input.endpointCmdCwd;
    if (
        cmdEnv !== undefined && Object.keys(cmdEnv).length > 0
        && input.endpointCmd === undefined && input.endpointCmdStdio === undefined
    ) {
        return {
            endpoint: undefined,
            error: "--endpoint-cmd-env requires --endpoint-cmd or --endpoint-cmd-stdio",
        };
    }
    if (
        cmdCwd !== undefined
        && input.endpointCmd === undefined && input.endpointCmdStdio === undefined
    ) {
        return {
            endpoint: undefined,
            error: "--endpoint-cmd-cwd requires --endpoint-cmd or --endpoint-cmd-stdio",
        };
    }

    try {
        if (input.endpointCmd !== undefined) {
            const provisionSlot = resolveProvisionSlot(
                input.provisionIdentitySlot,
                input.provisionIdentity === true,
                input.endpointCmd,
            );
            return {
                endpoint: {
                    kind: "cmd-env",
                    command: { command: input.endpointCmd },
                    ...(provisionSlot !== undefined ? { provisionSlot } : {}),
                    ...(cmdEnv !== undefined ? { env: cmdEnv } : {}),
                    ...(cmdCwd !== undefined ? { cwd: cmdCwd } : {}),
                },
                error: undefined,
            };
        }
        if (input.endpointCmdStdio !== undefined) {
            return {
                endpoint: {
                    kind: "cmd-stdio",
                    command: { command: input.endpointCmdStdio },
                    ...(cmdEnv !== undefined ? { env: cmdEnv } : {}),
                    ...(cmdCwd !== undefined ? { cwd: cmdCwd } : {}),
                },
                error: undefined,
            };
        }
        if (input.endpoint !== undefined) {
            const spec = parseEndpointUri(input.endpoint);
            // Explicit endpoint: token comes from the URI or --endpoint-token,
            // never from LINKRPC_TOKEN.
            return { endpoint: _withToken(spec, input.endpointToken), error: undefined };
        }

        const envEndpoint = env[LINKRPC_ENDPOINT_VAR];
        if (envEndpoint) {
            const spec = parseEndpointUri(envEndpoint);
            // Env endpoint: --endpoint-token wins, then the URI token, then
            // LINKRPC_TOKEN.
            const token = input.endpointToken
                ?? ("token" in spec ? spec.token : undefined)
                ?? env[LINKRPC_TOKEN_VAR];
            return { endpoint: _withToken(spec, token), error: undefined };
        }
    } catch (e) {
        return { endpoint: undefined, error: (e as Error).message };
    }

    return { endpoint: undefined, error: undefined };
}

/** One-line, token-redacted description of an endpoint for logs. */
export function formatEndpoint(spec: ResolvedEndpoint): string {
    return formatEndpointUri(spec);
}

export interface ResolveTargetEndpointInput {
    /** `--target-endpoint <uri>`. */
    readonly targetEndpoint?: string;
    /** `--target-endpoint-cmd <command>`. */
    readonly targetEndpointCmd?: string;
    /** `--target-endpoint-cmd-stdio <command>`. */
    readonly targetEndpointCmdStdio?: string;
    /** `--target-endpoint-cmd-env <key=value>` (repeatable). */
    readonly targetEndpointCmdEnv?: Readonly<Record<string, string>>;
    /** `--target-endpoint-cmd-cwd <dir>`: working directory for the spawned target child. */
    readonly targetEndpointCmdCwd?: string;
    /** `--target-endpoint-token <token>`. */
    readonly targetEndpointToken?: string;
    /**
     * Provisioning options to bind to the *target* cmd. Same semantics as
     * the global `--provision-identity[-slot]`; the `tunnel` command routes
     * them here when the target is a cmd.
     */
    readonly provisionIdentity?: boolean;
    readonly provisionIdentitySlot?: string;
}

/**
 * Resolve a *target* endpoint from `--target-*` flags. Mirrors
 * {@link resolveEndpoint} for tunnel-style commands that have both a source
 * (the hub the CLI claims on) and a target (the implementation that handles
 * inbound requests). Returns `{ endpoint: undefined }` when no `--target-*`
 * flag is set so the caller can error with a command-specific message.
 *
 * Unlike {@link resolveEndpoint}, no env-var fallback is consulted \u2014 the
 * target is always explicit.
 */
export function resolveTargetEndpoint(input: ResolveTargetEndpointInput): ResolveEndpointResult {
    const explicit = [
        input.targetEndpoint,
        input.targetEndpointCmd,
        input.targetEndpointCmdStdio,
    ].filter((v) => v !== undefined);
    if (explicit.length > 1) {
        return {
            endpoint: undefined,
            error:
                "specify at most one of --target-endpoint, --target-endpoint-cmd, --target-endpoint-cmd-stdio",
        };
    }
    if (
        (input.provisionIdentity === true || input.provisionIdentitySlot !== undefined)
        && input.targetEndpointCmd === undefined
    ) {
        // For tunnel, provisioning binds to the target cmd \u2014 not the source.
        // (The source typically signs with the user's `--principal` identity.)
        // Caller may still be okay if provisioning was consumed elsewhere; in
        // that case it wouldn't have reached us via this path.
        return {
            endpoint: undefined,
            error: "--provision-identity / --provision-identity-slot require --target-endpoint-cmd",
        };
    }
    const cmdEnv = input.targetEndpointCmdEnv;
    const cmdCwd = input.targetEndpointCmdCwd;
    if (
        cmdEnv !== undefined && Object.keys(cmdEnv).length > 0
        && input.targetEndpointCmd === undefined && input.targetEndpointCmdStdio === undefined
    ) {
        return {
            endpoint: undefined,
            error: "--target-endpoint-cmd-env requires --target-endpoint-cmd or --target-endpoint-cmd-stdio",
        };
    }
    if (
        cmdCwd !== undefined
        && input.targetEndpointCmd === undefined && input.targetEndpointCmdStdio === undefined
    ) {
        return {
            endpoint: undefined,
            error: "--target-endpoint-cmd-cwd requires --target-endpoint-cmd or --target-endpoint-cmd-stdio",
        };
    }

    try {
        if (input.targetEndpointCmd !== undefined) {
            const provisionSlot = resolveProvisionSlot(
                input.provisionIdentitySlot,
                input.provisionIdentity === true,
                input.targetEndpointCmd,
            );
            return {
                endpoint: {
                    kind: "cmd-env",
                    command: { command: input.targetEndpointCmd },
                    ...(provisionSlot !== undefined ? { provisionSlot } : {}),
                    ...(cmdEnv !== undefined ? { env: cmdEnv } : {}),
                    ...(cmdCwd !== undefined ? { cwd: cmdCwd } : {}),
                },
                error: undefined,
            };
        }
        if (input.targetEndpointCmdStdio !== undefined) {
            return {
                endpoint: {
                    kind: "cmd-stdio",
                    command: { command: input.targetEndpointCmdStdio },
                    ...(cmdEnv !== undefined ? { env: cmdEnv } : {}),
                    ...(cmdCwd !== undefined ? { cwd: cmdCwd } : {}),
                },
                error: undefined,
            };
        }
        if (input.targetEndpoint !== undefined) {
            const spec = parseEndpointUri(input.targetEndpoint);
            return { endpoint: _withToken(spec, input.targetEndpointToken), error: undefined };
        }
    } catch (e) {
        return { endpoint: undefined, error: (e as Error).message };
    }

    return { endpoint: undefined, error: undefined };
}

/**
 * Lower a resolved endpoint into a declarative {@link EndpointConfig} entry,
 * applying the given routing fields. Used by `tunnel -c, --config` to append
 * the source hub to a loaded config as a claiming endpoint, so the in-process
 * hub registers the service id on the source and routes its inbound calls
 * through the config-described target.
 *
 * A `cmd-env` endpoint's `provisionSlot` is carried over as a slotted managed
 * identity so the claim signs with a persistent identity.
 */
export function resolvedEndpointToConfig(
    spec: ResolvedEndpoint,
    routing: { readonly claimServiceIds: readonly string[]; },
): EndpointConfig {
    const claimServiceIds = [...routing.claimServiceIds];
    switch (spec.kind) {
        case "socket":
            return {
                kind: "socket",
                path: spec.path,
                ...(spec.token !== undefined ? { token: spec.token } : {}),
                routeServiceIds: [],
                claimServiceIds,
                defaultRoute: false,
            };
        case "ws":
            return {
                kind: "ws",
                url: spec.url,
                ...(spec.token !== undefined ? { token: spec.token } : {}),
                routeServiceIds: [],
                claimServiceIds,
                defaultRoute: false,
            };
        case "ws-no-init":
            throw new Error("ws-no-init endpoints cannot be used as declarative hub routes");
        case "cmd-env":
            return {
                kind: "cmd-env",
                ..._commandFields(spec.command),
                ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
                ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
                routeServiceIds: [],
                claimServiceIds,
                defaultRoute: false,
                ...(spec.provisionSlot !== undefined
                    ? { managedIdentity: { slot: spec.provisionSlot } }
                    : {}),
            };
        case "cmd-stdio":
            return {
                kind: "cmd-stdio",
                ..._commandFields(spec.command),
                ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
                ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
                routeServiceIds: [],
                claimServiceIds,
                defaultRoute: false,
            };
    }
}

/** Lower an {@link EndpointCommand} into the config's `cmd` / `argv` fields. */
function _commandFields(
    command: { readonly command: string; } | { readonly argv: readonly string[]; },
): { cmd: string; } | { argv: string[]; } {
    return "command" in command ? { cmd: command.command } : { argv: [...command.argv] };
}
