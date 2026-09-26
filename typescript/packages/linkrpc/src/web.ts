// Browser-oriented entry for linkrpc. Re-exports the full platform-neutral
// surface so `./web` is a strict superset of `.` — consumers get everything
// from the root entry plus the browser-only helpers below, and the emitted
// `.d.ts` chunk graph has `index` as a clear dominator of `web`.
export * from "./index";
export * from "./transport/initialize";
export * from "./transport/webSocketTransport";
export {
    WindowMessageTransport,
    type MessageEndpoint,
    type MessageLikeEvent,
} from "./transport/windowMessageTransport";
