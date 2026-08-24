/**
 * The declarative hub configuration now lives in `@hediet/linkrpc-hub` so the
 * exact same schema drives the CLI (`serve`, `-c`), the standalone `linkrpc-hub`
 * server, and the VS Code extension. This module re-exports it for the CLI's
 * existing `./config` import sites.
 */
export {
    type EndpointConfig,
    EndpointConfigSchema,
    type HubConfig,
    HubConfigSchema,
    hubConfigJsonSchema,
    type ListenerConfig,
    ListenerConfigSchema,
    parseHubConfig,
} from '@hediet/linkrpc-hub/config';
