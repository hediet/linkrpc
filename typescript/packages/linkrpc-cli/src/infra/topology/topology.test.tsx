import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";
import {
    bareInterfaceTarget, computeInterfaceHash, LinkRpcConnection, TransportPair, type JsonRpcChannel, type JsonValue,
} from "@hediet/linkrpc";
import { topologyInterface, type TopologyGraph } from "@hediet/linkrpc/inspection";
import { connectViaTransport } from "@hediet/linkrpc-client";
import { Command } from "commander";
import { topologyView } from "./contribution";
import { TopologyObservation, readTopology, resolveTopologyTarget } from "./model";
import { TopologySession } from "./session";
import { sampleTopology } from "./fixtures/sampleGraph";
import { discoverViewTargets, resolveViewSelection } from "../../views/discovery";
import { interfaceTarget, matchesTarget, type ViewOpenContext } from "../../views/types";
import { dispatchHostKey, dispatchViewKey } from "../../views/commands";
import { registerViewCommands, viewList } from "../../commands/view";
import { ViewFrame } from "../../views/ViewFrame";

function fixture(serviceId = "demo", isDefault = false) {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.b);
    const client = connectViaTransport(pair.a);
    let graph = structuredClone(sampleTopology);
    let getError: Error | undefined;
    let block = false;
    let getCalls = 0, cancelledWatch = 0, cancelledFetch = 0;
    let invalidate: (() => Promise<void>) | undefined;
    let rejectWatch: ((error: unknown) => void) | undefined;
    const methods: string[] = [];
    (server.channel as JsonRpcChannel).setWireMessageObserver((_direction, message) => {
        if ("method" in message && (message.method.endsWith("getGraph") || message.method.endsWith("watchGraph"))) methods.push(message.method);
    });
    server.service(serviceId).register(isDefault ? bareInterfaceTarget(topologyInterface) : topologyInterface, {
        getGraph: async (_params, _context, stream) => {
            getCalls++;
            if (getError) throw getError;
            if (block) await new Promise<void>(resolve => stream.signal.addEventListener("abort", () => {
                cancelledFetch++; resolve();
            }, { once: true }));
            return graph;
        },
        watchGraph: async (_params, _context, stream) => {
            invalidate = () => stream.send({});
            await new Promise<void>((resolve, reject) => {
                rejectWatch = reject;
                stream.signal.addEventListener("abort", () => { cancelledWatch++; resolve(); }, { once: true });
            });
            return {};
        },
    });
    server.enableReflection();
    const listing = { serviceId, interfaceId: topologyInterface.info.id, hash: topologyInterface.schemaHash,
        discoveredFrom: serviceId, isDefault, schema: JSON.parse(JSON.stringify(topologyInterface.toSchema())) };
    const context: ViewOpenContext = { channel: client.channel, target: interfaceTarget(listing), interfaces: [listing] };
    return {
        client, server, context, methods,
        get calls() { return getCalls; }, get cancelledWatch() { return cancelledWatch; }, get cancelledFetch() { return cancelledFetch; },
        update(value: TopologyGraph) { graph = value; },
        error(error: Error) { getError = error; },
        block() { block = true; },
        invalidate: async () => { if (!invalidate) throw new Error("Watch not started"); await invalidate(); },
        failWatch: (error: unknown) => rejectWatch?.(error),
        close() { client.close(); server.close(); },
    };
}
async function waitFor(check: () => boolean): Promise<void> {
    for (let index = 0; index < 200; index++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Topology did not settle");
}

describe("contributed topology view", () => {
    it.each([["", true], ["", false], ["demo", false]] as const)("routes %s default=%s and leaves the shared connection open", async (serviceId, bare) => {
        const f = fixture(serviceId, bare);
        const close = vi.spyOn(f.client.channel, "close");
        try {
            const graph = await readTopology(f.context, resolveTopologyTarget(f.context), 1000);
            expect(graph).toEqual(sampleTopology);
            expect(f.methods).toEqual([bare ? "getGraph" : [serviceId, "hubrpc.topology", "getGraph"].filter(Boolean).join("::")]);
            expect(close).not.toHaveBeenCalled();
            expect(JSON.parse(await topologyView.open(f.context, { json: true }))).toEqual(sampleTopology);
        } finally { f.close(); }
    });

    it("registers offline CLI help, discovers a per-service target, and opens through view commands", async () => {
        const f = fixture("", true);
        try {
            expect(viewList()).toContain("topology");
            const targets = await discoverViewTargets(f.client.channel, topologyView);
            expect(targets.targets.some(target => target.id === "service::")).toBe(true);
            expect(f.methods).toEqual([]);
            const context = await resolveViewSelection(f.client.channel, topologyView, { target: "service::" });
            expect(context.interfaces.some(value => value.interfaceId === topologyInterface.info.id)).toBe(true);
            const output: string[] = [];
            const command = new Command();
            registerViewCommands(command, async action => action(f.client.channel), value => output.push(value));
            await command.parseAsync(["view", "open", "topology", "--target", "service::", "--json"], { from: "user" });
            expect(JSON.parse(output.at(-1)!)).toEqual(sampleTopology);
        } finally { f.close(); }
    });

    it("matches canonical ID only and rejects a stale/incompatible schema before data calls", async () => {
        const f = fixture();
        try {
            const fake = { ...f.context.target, interfaces: [{ ...f.context.interfaces[0]!, interfaceId: "unrelated", tags: ["hubrpc.topology"] }] };
            expect(matchesTarget(fake, topologyView)).toBe(false);
            const bad = { ...f.context, interfaces: [{ ...f.context.interfaces[0]!,
                schema: { ...topologyInterface.toSchema(), methods: {} } }] };
            await expect(topologyView.open(bad, {})).rejects.toThrow("canonical inspection contract");
            expect(f.methods).toEqual([]);
        } finally { f.close(); }
    });

    it("accepts the equivalent primitive-union encoding from another Zod version but rejects contract drift", () => {
        const f = fixture();
        try {
            let converted = 0;
            const toTypeArray = (value: unknown): unknown => {
                if (Array.isArray(value)) return value.map(toTypeArray);
                if (value === null || typeof value !== "object") return value;
                const record = value as Record<string, unknown>;
                if (Object.keys(record).length === 1
                    && JSON.stringify(record.anyOf) === JSON.stringify([
                        { type: "string" }, { type: "number" }, { type: "boolean" },
                    ])) {
                    converted++;
                    return { type: ["string", "number", "boolean"] };
                }
                return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, toTypeArray(child)]));
            };
            const schema = toTypeArray(topologyInterface.toSchema()) as ReturnType<typeof topologyInterface.toSchema>;
            expect(converted).toBe(2);
            schema.hash = computeInterfaceHash(schema);
            expect(schema.hash).toBe(topologyInterface.schemaHash);
            const listing = f.context.interfaces[0]!;
            const context = { ...f.context, interfaces: [{ ...listing, hash: schema.hash, schema }] };
            expect(resolveTopologyTarget(context)).toEqual({
                serviceId: listing.serviceId, hash: schema.hash, isDefault: false,
            });

            const incompatible = structuredClone(schema);
            incompatible.methods.getGraph.params = { type: "string" };
            incompatible.hash = computeInterfaceHash(incompatible);
            expect(() => resolveTopologyTarget({ ...context, interfaces: [{ ...listing, schema: incompatible }] }))
                .toThrow("canonical inspection contract");
            expect(() => resolveTopologyTarget({ ...context, interfaces: [{
                ...listing, schema: { ...schema, hash: "stale" },
            }] })).toThrow("canonical inspection contract");
        } finally { f.close(); }
    });

    it.each([["demo", false], ["", true], ["", false]] as const)("watches %s default=%s invalidations and cancels cleanly", async (serviceId, bare) => {
        const f = fixture(serviceId, bare);
        let stop!: () => void;
        const stopped = new Promise<void>(resolve => { stop = resolve; });
        const output: string[] = [];
        const running = topologyView.open(f.context, { mode: "watch", json: true, stop: stopped, emit: (text: string) => output.push(text) });
        try {
            await waitFor(() => output.length === 1);
            const next = structuredClone(sampleTopology);
            next.nodes[0]!.label = "Changed";
            next.links.push(structuredClone(next.links[0]!));
            f.update(next);
            await f.invalidate();
            await waitFor(() => output.length === 2);
            expect(JSON.parse(output[0]!)).toEqual(sampleTopology);
            expect(JSON.parse(output[1]!)).toEqual(next);
            expect(output.every(line => !line.includes("\n"))).toBe(true);
            expect(f.methods).toContain(bare ? "watchGraph" : [serviceId, "hubrpc.topology", "watchGraph"].filter(Boolean).join("::"));
            stop(); await running;
            await waitFor(() => f.cancelledWatch === 1);
        } finally { stop(); await running.catch(() => {}); f.close(); }
    });

    it.each(["fetch", "watch"] as const)("surfaces %s failures rather than retaining silent stale CLI output", async kind => {
        const f = fixture();
        const output: string[] = [];
        const running = topologyView.open(f.context, { mode: "watch", stop: new Promise<void>(() => {}),
            emit: (text: string) => output.push(text) });
        const failure = expect(running).rejects.toThrow(kind === "fetch" ? "fetch broke" : "watch broke");
        try {
            await waitFor(() => output.length === 1);
            if (kind === "fetch") { f.error(new Error("fetch broke")); await f.invalidate(); }
            else f.failWatch(new Error("watch broke"));
            await failure;
        } finally { f.close(); }
    });

    it("cancels and drains an in-flight refresh without emitting after disposal", async () => {
        const f = fixture();
        const received: TopologyGraph[] = [];
        const errors: unknown[] = [];
        const observation = new TopologyObservation(f.context, resolveTopologyTarget(f.context), 1000, {
            onGraph: graph => received.push(graph), onError: error => errors.push(error), onEnd() {},
        });

        try {
            await observation.ready;
            f.block();
            const refresh = observation.refresh();
            await waitFor(() => f.calls === 2);
            await observation.disposeAsync();
            await refresh;
            await waitFor(() => f.cancelledFetch === 1 && f.cancelledWatch === 1);
            expect(received).toHaveLength(1);
            expect(errors).toEqual([]);
        } finally { await observation.disposeAsync(); f.close(); }
    });

    it("rejects invalid snapshots and times out/cancels a stuck authoritative fetch", async () => {
        const invalid = fixture();
        try {
            invalid.update({ observerServiceId: "demo" } as TopologyGraph);
            await expect(readTopology(invalid.context, resolveTopologyTarget(invalid.context), 1000)).rejects.toBeDefined();
        } finally { invalid.close(); }
        const slow = fixture();
        try {
            slow.block();
            await expect(readTopology(slow.context, resolveTopologyTarget(slow.context), 20)).rejects.toThrow(/timed out/i);
            await waitFor(() => slow.cancelledFetch === 1);
        } finally { slow.close(); }
    });

    it.each([false, true])("renders bounded Ink frames (tabbed=%s), pans/pages, refreshes and generates help", async tabbed => {
        const f = fixture();
        const session = new TopologySession(f.context, resolveTopologyTarget(f.context), 1000);
        const output = Object.assign(new PassThrough(), { columns: 48 });
        let frame = "";
        output.on("data", chunk => { if (String(chunk).includes("TOPOLOGY")) frame = stripVTControlCharacters(String(chunk)); });
        const instance = render(<ViewFrame session={session} rows={18} columns={48} tabbed={tabbed} />, {
            stdout: output as never, stderr: output as never, stdin: new PassThrough() as never,
            debug: true, exitOnCtrlC: false, patchConsole: false,
        });
        try {
            await waitFor(() => session.state.get().snapshots === 1 && frame.includes("snapshot 1"));
            expect(frame.trimEnd().split("\n")).toHaveLength(18);
            expect(session.state.get().rows).toBeGreaterThanOrEqual(16);
            expect(frame).toContain("┌");
            dispatchViewKey(session, { input: "", name: "pagedown" });
            expect(session.state.get().top).toBeGreaterThan(0);
            dispatchViewKey(session, { input: "", name: "right" });
            expect(session.state.get().left).toBe(8);
            dispatchViewKey(session, { input: "]" });
            expect(session.state.get().left).toBeGreaterThan(8);
            dispatchViewKey(session, { input: "?" });
            await waitFor(() => frame.includes("TOPOLOGY COMMANDS"));
            expect(session.commands.get().find(command => command.id === "topology.help")?.title).toBe("Close commands");
            expect(frame).toContain("Refresh snapshot");
            dispatchViewKey(session, { input: "?" });
            dispatchViewKey(session, { input: "r" });
            await waitFor(() => session.state.get().snapshots === 2);
            f.error(new Error("refresh failed"));
            dispatchViewKey(session, { input: "r" });
            await waitFor(() => frame.includes("ERROR:") && frame.includes("refresh failed"));
            expect(session.state.get().lines.length).toBeGreaterThan(0);
            const quit = vi.fn();
            expect(dispatchHostKey(session, { input: "q" }, { quit })).toBe(true);
            expect(quit).toHaveBeenCalledOnce();
        } finally { instance.unmount(); await session.disposeAsync(); output.destroy(); f.close(); }
    });
});
