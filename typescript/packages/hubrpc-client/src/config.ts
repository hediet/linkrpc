/**
 * The declarative hub configuration now lives in `@vscode/hubrpc-hub` so the
 * exact same schema drives the CLI (`serve`, `-c`), the standalone `hubrpc-hub`
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
} from '@vscode/hubrpc-hub/config';
