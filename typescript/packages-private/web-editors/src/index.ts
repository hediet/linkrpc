export * from "./protocol";
export * from "./content/contentModel";
export * from "./content/textJsonCodec";
// `WindowMessageTransport` now lives in `@hediet/linkrpc/web`. Re-exported
// here so existing consumers keep working.
export {
    WindowMessageTransport,
    type MessageEndpoint,
    type MessageLikeEvent,
} from "@hediet/linkrpc/web";
export * from "./host/WebEditorHost";
export * from "./client/WebEditorClient";
export * from "./client/VsCodeAppHostClient";
export {
    createWindowParentConnection,
    type ConnectionInput,
} from "./client/connection";
export type { IDisposable, Event } from "./utils/event";
