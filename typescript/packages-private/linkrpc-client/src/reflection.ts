import type { IRequestSender, SigningCallCtx } from "@hediet/linkrpc";
import {
    DEFAULT_WALK_DEPTH,
    type DiscoveredListing,
    fetchDirectory,
    fetchSchema,
    findMethodInSchema,
    type InaccessibleDirectory,
    type ListOptions,
    type ServiceListing,
    walkHub,
    type WalkHubOptions,
    type WalkHubResult,
} from "@hediet/linkrpc/hub/common";

/**
 * The sender every CLI command / reflection helper speaks over: the signing
 * decorator that wraps the live channel. Decoupled from the concrete
 * `JsonRpcChannel` so reconnect can swap the underlying channel transparently.
 */
export type CliChannel = IRequestSender<SigningCallCtx>;

/**
 * The directory walk and the `linkrpc.directory` / `linkrpc.schemas` fetch
 * helpers now live in `@hediet/linkrpc` core (so the hub can share them for
 * access-candidate resolution). They are re-exported here so existing CLI
 * imports (`../reflection`) keep working.
 */
export {
    DEFAULT_WALK_DEPTH,
    fetchDirectory,
    fetchSchema,
    findMethodInSchema,
    walkHub,
};
export { walkHubDetailed } from "@hediet/linkrpc/hub/common";
export type {
    DiscoveredListing,
    InaccessibleDirectory,
    ListOptions,
    ServiceListing,
    WalkHubOptions,
    WalkHubResult,
};

export interface DefaultsResult {
    readonly serviceId?: string;
    readonly interfaceId?: string;
    readonly hash?: string;
}

export async function fetchDefaults(channel: CliChannel): Promise<DefaultsResult> {
    const raw = await channel.sendRequest("linkrpc.defaults::get", {}) as {
        serviceId?: string;
        interfaceId?: string;
        interfaceHash?: string;
    } | null | undefined;
    if (!raw) return {};
    return {
        serviceId: raw.serviceId,
        interfaceId: raw.interfaceId,
        hash: raw.interfaceHash,
    };
}
