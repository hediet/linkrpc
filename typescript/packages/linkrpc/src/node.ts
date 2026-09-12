// Node-only entry for linkrpc. Re-exports node:child_process / node:fs /
// node:crypto dependent helpers. Browser code MUST NOT import this.
//
// Re-export the full platform-neutral surface so `./node` is a strict superset
// of `.` — consumers importing the node entry get everything from the root
// entry plus the node-only helpers below, and the emitted `.d.ts` chunk graph
// has `index` as a clear dominator of `node`.
export * from './index';
export { connectToCmdStdio, openStdioChannel, serveOnStdio, type StdioChannel } from './node/stdio';
export {
    connectToHub,
    type ConnectToHubOptions,
    type HubChannel,
    type HubClientHandle,
    loadOrCreateIdentity,
    type LoadOrCreateIdentityOptions,
    openHubChannel,
    type OpenHubChannelOptions,
    type PersistedIdentity,
    registerHubPrefix,
    type RegisterHubPrefixOptions,
    LINKRPC_ENDPOINT_VAR,
    LINKRPC_TOKEN_VAR,
} from './node/hubClient';
export {
    createHubPrefixClaimer,
    type HubPrefixClaimer,
    type HubPrefixClaimerOptions,
    type ServeOverHubController,
    type ServeOverHubIdentityOptions,
    type ServeOverHubOptions,
    serveOverHubWithReconnect,
} from './node/hubReconnect';
export { fileManagedIdentityStorage } from './node/fileManagedIdentityStorage';
export { createManagedPrincipal } from './identity/managedPrincipal';
export { createSelfManagedPrincipal, createSelfManagedPrincipalFromFile } from './node/principal';
export {
    HeaderDelimitedTransport,
    type HeaderDelimitedTransportOptions,
} from './node/headerDelimitedTransport';
export {
    type ConnectedNdjson,
    type ConnectNdjsonOptions,
    connectNdjson,
    INITIALIZE_METHOD,
    LINKRPC_INITIALIZE_METHOD_ALIAS,
    INITIALIZE_PROTOCOL_VERSION,
    type InitializeParams,
    type InitializeResult,
    type InitializeRole,
    runInitializeHandshake,
    type RunInitializeHandshakeOptions,
} from './node/initialize';
export { openWebSocket, type OpenWebSocketOptions, WebSocketTransport } from './node/webSocketClientTransport';
export {
    type CmdEnvEndpoint,
    type CmdStdioEndpoint,
    type EndpointCommand,
    type ResolvedEndpoint,
    type FormatEndpointOptions,
    formatEndpointUri,
    isHubEndpoint,
    parseEndpointUri,
    type SocketEndpoint,
    type WsNoInitEndpoint,
    type WsEndpoint,
} from './connection/endpointUri';
