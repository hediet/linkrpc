import { parse } from "zod/mini";
import { computeInterfaceHash, LinkRpcConnection, type IRequestSender, type JsonValue, type RawStreamingCall, type StreamSendOpts } from "@hediet/linkrpc";
import { topologyInterface, zTopologyGraph, type TopologyGraph } from "@hediet/linkrpc/inspection";
import { TopologyClient, type TopologyWatch } from "@hediet/linkrpc-infra/inspection";
import type { ViewOpenContext } from "../../views/types";

export interface TopologyTarget {
    readonly serviceId: string;
    readonly hash: string;
    readonly isDefault: boolean;
}

export function resolveTopologyTarget(context: ViewOpenContext): TopologyTarget {
    const candidates = context.interfaces.filter(value => value.interfaceId === topologyInterface.info.id);
    if (candidates.length !== 1) throw new Error("Select exactly one canonical hubrpc.topology interface");
    const listing = candidates[0]!;
    const canonical = topologyInterface.toSchema();
    if (listing.schema.id !== canonical.id
        || computeInterfaceHash({ ...canonical, methods: listing.schema.methods,
            components: listing.schema.components }) !== canonical.hash) {
        throw new Error("Selected hubrpc.topology schema does not match the canonical inspection contract");
    }
    return { serviceId: listing.serviceId, hash: listing.schema.hash, isDefault: listing.isDefault === true };
}

export function topologyTimeout(options: Readonly<Record<string, unknown>>): number {
    const timeout = Number(options.timeoutMs ?? 5_000);
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("--timeout-ms must be a positive integer");
    return timeout;
}

/**
 * A send-only, non-owning connection adapter. Typed inspection clients still validate
 * the canonical contract; this adapter supplies the selected default/qualified route.
 */
export class TopologyReader {
    readonly client: TopologyClient;
    private readonly calls = new Set<RawStreamingCall>();
    private readonly pending = new Set<Promise<JsonValue>>();
    private disposed = false;

    constructor(context: ViewOpenContext, readonly target: TopologyTarget, timeoutMs: number) {
        const start = (method: string, params: JsonValue | undefined, options?: StreamSendOpts): RawStreamingCall => {
            if (this.disposed) throw new Error("Topology view is closed");
            const member = method.split("::").at(-1)!;
            if (member !== "getGraph" && member !== "watchGraph") throw new Error(`Unexpected topology member: ${member}`);
            const route = target.isDefault ? member : [target.serviceId, topologyInterface.info.id, member].filter(Boolean).join("::");
            const raw = context.channel.sendRequestWithStream(route, params, { ...options, interfaceHash: target.hash });
            let rejectLocal!: (error: unknown) => void;
            const result = Promise.race([raw.result, new Promise<never>((_, reject) => { rejectLocal = reject; })]);
            const call: RawStreamingCall = {
                result,
                send: value => raw.send(value),
                ping: () => raw.ping(),
                cancel: reason => raw.cancel(reason),
                dispose: reason => {
                    try { raw.dispose?.(reason); }
                    finally { rejectLocal(new Error(reason ?? "Topology request disposed")); }
                },
            };
            this.calls.add(call);
            this.pending.add(result);
            const finish = () => { this.calls.delete(call); this.pending.delete(result); };
            void result.then(finish, finish);
            return call;
        };
        const sender: IRequestSender = {
            sendRequest: (method, params, options) => start(method, params, options).result,
            sendRequestWithStream: start,
            sendNotification: async () => { throw new Error("Topology has no notification members"); },
            close() {},
        };
        this.client = new TopologyClient(new LinkRpcConnection(sender), target.serviceId, timeoutMs);
    }

    async snapshot(): Promise<TopologyGraph> { return parse(zTopologyGraph, await this.client.getGraph()); }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const call of this.calls) {
            try { call.cancel("topology view closed"); } catch { /* The underlying connection may already be closed. */ }
            finally { call.dispose?.("topology view closed"); }
        }
    }
    async waitForIdle(): Promise<void> { await Promise.allSettled([...this.pending]); }
}

export class TopologyObservation {
    private readonly reader: TopologyReader;
    private readonly watch: TopologyWatch;
    private readonly requests = new Set<Promise<void>>();
    private stopping = false;
    private cancellation: Promise<void> | undefined;
    readonly done: Promise<void>;
    readonly ready: Promise<TopologyGraph>;

    constructor(
        context: ViewOpenContext, target: TopologyTarget, timeoutMs: number,
        private readonly callbacks: { onGraph(graph: TopologyGraph): void; onError(error: unknown): void; onEnd(): void },
    ) {
        this.reader = new TopologyReader(context, target, timeoutMs);
        this.watch = this.reader.client.watch({
            onGraph: graph => this.accept(graph),
            onError: error => { if (!this.stopping) callbacks.onError(error); },
        });
        this.ready = this.watch.ready;
        void this.ready.catch(() => {});
        this.done = this.watch.done.then(
            () => { if (!this.stopping) callbacks.onEnd(); },
            error => { if (!this.stopping) { callbacks.onError(error); callbacks.onEnd(); } },
        );
    }
    private accept(graph: TopologyGraph): void {
        if (!this.stopping) this.callbacks.onGraph(parse(zTopologyGraph, graph));
    }
    refresh(): Promise<void> {
        if (this.stopping) return Promise.resolve();
        const request = this.reader.snapshot().then(graph => this.accept(graph)).catch(error => {
            if (!this.stopping) this.callbacks.onError(error);
        });
        this.requests.add(request);
        void request.then(() => this.requests.delete(request), () => this.requests.delete(request));
        return request;
    }
    dispose(): void {
        if (this.stopping) return;
        this.stopping = true;
        this.cancellation = this.watch.cancel("topology view closed");
        void this.cancellation.catch(() => {});
        this.reader.dispose();
    }
    async disposeAsync(): Promise<void> {
        this.dispose();
        await Promise.allSettled([this.ready, this.done, this.cancellation, ...this.requests]);
        await this.reader.waitForIdle();
    }
}

export async function readTopology(context: ViewOpenContext, target: TopologyTarget, timeoutMs: number): Promise<TopologyGraph> {
    const reader = new TopologyReader(context, target, timeoutMs);
    try { return await reader.snapshot(); }
    finally { reader.dispose(); await reader.waitForIdle(); }
}

export async function watchTopology(
    context: ViewOpenContext, target: TopologyTarget, timeoutMs: number,
    onGraph: (graph: TopologyGraph) => void, stop: Promise<void>,
): Promise<void> {
    let fail!: (error: unknown) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    const observation = new TopologyObservation(context, target, timeoutMs, {
        onGraph,
        onError: fail,
        onEnd: () => fail(new Error("Topology invalidation watch ended")),
    });
    try { await Promise.race([stop, failure]); }
    finally { await observation.disposeAsync(); }
}
