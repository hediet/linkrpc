import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpAuthenticationState } from "./contracts";
import { assertMcpIdentities, type McpIdentities, type McpIdentityInfo } from "./mcpIdentities";
import { httpUpstream } from "./upstream";

export type McpAccessToken =
    | {
        readonly status: "ready";
        readonly accessToken: string;
        /** Defaults to `Bearer`. */
        readonly tokenType?: string;
        readonly expiresAt?: string;
    }
    | { readonly status: "authorization-required"; readonly authorizationUri: string; readonly expiresAt?: string }
    | { readonly status: "error"; readonly error: string; readonly authorizationUri?: string };

/**
 * OAuth accounts and their access tokens, e.g. backed by a token service. The
 * source obtains, caches, and refreshes tokens; {@link oauthMcpIdentities}
 * attaches them to requests.
 */
export interface McpAccessTokenSource {
    list(): readonly McpIdentityInfo[];
    onDidChange?(listener: () => void): { dispose(): void };
    getAccessToken(identityId: string): Promise<McpAccessToken>;
    /** The server rejected the last token of `identityId` (HTTP 401). */
    invalidate?(identityId: string): Promise<void>;
    /** Start signing in a new account. */
    authorize?(): Promise<{ readonly authorizationUri: string; readonly expiresAt?: string }>;
}

export class McpAuthorizationRequiredError extends Error {
    constructor(readonly identityId: string, readonly authorizationUri: string) {
        super(`MCP identity '${identityId}' requires authorization at ${authorizationUri}`);
        this.name = "McpAuthorizationRequiredError";
    }
}

export interface OAuthMcpIdentitiesOptions {
    /** Streamable HTTP MCP server URL. */
    readonly url: string | URL;
    readonly headers?: Readonly<Record<string, string>>;
    readonly tokens: McpAccessTokenSource;
    readonly fetch?: FetchLike;
}

/**
 * Identities of a Streamable HTTP MCP server that uses OAuth access tokens.
 * Every request of an identity carries its current token; after a 401 the
 * token is invalidated and the request retried once with a fresh one.
 */
export function oauthMcpIdentities(options: OAuthMcpIdentitiesOptions): McpIdentities {
    const baseFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const states = new Map<string, McpAuthenticationState>();
    const listeners = new Set<() => void>();
    const emit = () => { for (const listener of listeners) listener(); };
    const setState = (identityId: string, state: McpAuthenticationState): void => {
        if (JSON.stringify(states.get(identityId)) === JSON.stringify(state)) return;
        states.set(identityId, state);
        emit();
    };
    const sourceChanged = options.tokens.onDidChange?.(emit);

    const authorizedHeaders = async (identityId: string, init: RequestInit | undefined): Promise<Headers> => {
        const token = await options.tokens.getAccessToken(identityId);
        if (token.status === "authorization-required") {
            setState(identityId, {
                status: "authorization-required",
                authorizationUri: token.authorizationUri,
                ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
            });
            throw new McpAuthorizationRequiredError(identityId, token.authorizationUri);
        }
        if (token.status === "error") {
            setState(identityId, {
                status: "error",
                error: token.error,
                ...(token.authorizationUri !== undefined ? { authorizationUri: token.authorizationUri } : {}),
            });
            throw new Error(`MCP identity '${identityId}': ${token.error}`);
        }
        const label = options.tokens.list().find((identity) => identity.id === identityId)?.label;
        setState(identityId, {
            status: "ready",
            identityId,
            ...(label !== undefined ? { identityLabel: label } : {}),
            ...(token.expiresAt !== undefined ? { tokenExpiresAt: token.expiresAt } : {}),
        });
        const headers = new Headers(options.headers);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        headers.set("Authorization", `${token.tokenType ?? "Bearer"} ${token.accessToken}`);
        return headers;
    };

    const fetchFor = (identityId: string): FetchLike => async (input, init) => {
        const response = await baseFetch(input, { ...init, headers: await authorizedHeaders(identityId, init) });
        if (response.status !== 401) return response;
        await options.tokens.invalidate?.(identityId);
        setState(identityId, { status: "checking" });
        return baseFetch(input, { ...init, headers: await authorizedHeaders(identityId, init) });
    };

    const known = (identityId: string): boolean =>
        options.tokens.list().some((identity) => identity.id === identityId);

    return {
        list: () => {
            const identities = options.tokens.list();
            assertMcpIdentities(identities);
            return identities;
        },
        onDidChange: (listener) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        upstream: (identityId) => {
            if (!known(identityId)) throw new Error(`Unknown MCP identity: ${identityId}`);
            return httpUpstream({ url: options.url, fetch: fetchFor(identityId) });
        },
        authentication: (identityId) => states.get(identityId) ?? { status: "checking" },
        ...(options.tokens.authorize !== undefined ? { authorize: () => options.tokens.authorize!() } : {}),
        dispose: () => {
            sourceChanged?.dispose();
            listeners.clear();
        },
    };
}
