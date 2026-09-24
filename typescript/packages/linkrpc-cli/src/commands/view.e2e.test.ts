import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { bareInterfaceTarget, defineInterface, LinkRpcConnection, TransportPair, type JsonRpcChannel, type JsonValue } from "@hediet/linkrpc";
import { GraphObjects, GraphRoot, graphRefSchema, ImmutableGraphRuntime, InMemoryImmutableGraphStore, standardGraphRuntimeOptions } from "@hediet/linkrpc-infra/graph";
import { connectViaTransport } from "@hediet/linkrpc-client";
import { graphView } from "../infra/graph/contribution";
import { discoverViewTargets, resolveViewSelection } from "../views/discovery";
import { GraphSession } from "../infra/graph/session";
import type { GraphRef } from "../infra/graph/inspectGraphModel";

describe("reflected graph view wire integration", () => {
    it("updates collapsed row titles over the root watch without traversing another level", async () => {
        const objects = GraphObjects({ ref: graphRefSchema, value: z.unknown() as z.ZodType<JsonValue> });
        const root = GraphRoot({ params: z.object({}), ref: graphRefSchema });
        const definition = defineInterface({ id: "test.collapsed.graph" }, { objects, root });
        const roots = [{ kind: "root", id: "v1" }, { kind: "root", id: "v2" }];
        const children = [{ kind: "item", id: "v1" }, { kind: "item", id: "v2" }];
        const detail = { kind: "detail", id: "unopened" };
        const store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
        for (let index = 0; index < roots.length; index++) {
            store.set(roots[index]!, { items: [children[index]!] });
            store.set(children[index]!, { title: index === 0 ? "Before" : "After", detail });
        }
        const runtime = new ImmutableGraphRuntime(store, standardGraphRuntimeOptions);
        const fetched: GraphRef[] = [];
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.b);
        const client = connectViaTransport(pair.a);
        server.register(bareInterfaceTarget(definition), {
            objects: { batchObjGet: request => {
                fetched.push(...request.needs.map(need => need.ref));
                return runtime.batchObjGet(request);
            } },
            root: { watch: async (_params, _context, stream) => {
                stream.onMessage(async ({ accept }) => {
                    if (accept === 1) await stream.send({ version: 2, ref: roots[1]! });
                });
                await stream.send({ version: 1, ref: roots[0]! });
                await new Promise<void>(resolve => stream.signal.addEventListener("abort", () => resolve(), { once: true }));
                return {};
            } },
        });
        server.enableReflection();
        let session: GraphSession | undefined;
        try {
            const context = await resolveViewSelection(client.channel, graphView, { interface: definition.info.id });
            const created = graphView.createSession!(context);
            expect(created).toBeInstanceOf(GraphSession);
            if (!(created instanceof GraphSession)) throw new Error("Expected graph session");
            session = created;
            session.start();
            await vi.waitFor(() => expect(session!.state.get().version).toBe(2));
            expect(session.state.get().model?.lines[1]).toMatchObject({ summary: "After", expanded: false });
            expect(fetched).toContainEqual(children[0]);
            expect(fetched).toContainEqual(children[1]);
            expect(fetched).not.toContainEqual(detail);
        } finally {
            await session?.disposeAsync();
            client.close(); server.close();
        }
    });

    it("discovers and opens the main service using the public graph templates", async () => {
        const objects = GraphObjects({ ref: graphRefSchema, value: z.unknown() as z.ZodType<JsonValue> });
        const root = GraphRoot({ params: z.object({}), ref: graphRefSchema });
        const definition = defineInterface({ id: "custom.wire.graph" }, {
            fetch: objects.members.batchObjGet, watch: root.members.watch,
        }, { templates: {
            objects: objects.mapMembers({ batchObjGet: "fetch" }),
            sessions: root.mapMembers({ watch: "watch" }),
        } });
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.b);
        const client = connectViaTransport(pair.a);
        let cancelled = false;
        const methods: string[] = [];
        (server.channel as JsonRpcChannel).setWireMessageObserver((_direction, message) => {
            if ("method" in message) methods.push(message.method);
        });
        const ref = { kind: "node", id: "live" };
        server.register(bareInterfaceTarget(definition), {
            fetch: () => ({ objects: [{ ref, value: { title: "live" } }], missing: [], complete: true }),
            watch: async (_params, _context, stream) => {
                await stream.send({ version: 1, ref });
                await new Promise<void>(resolve => stream.signal.addEventListener("abort", () => {
                    cancelled = true; resolve();
                }, { once: true }));
                return {};
            },
        });
        server.enableReflection();
        try {
            const discovery = await discoverViewTargets(client.channel, graphView);
            expect(discovery.targets.some(target => target.id === "service::")).toBe(true);
            expect(methods).not.toContain("watch");
            expect(methods).not.toContain("fetch");
            expect(methods.filter(method => method.endsWith("hubrpc.schemas::get"))).toEqual([]);
            const context = await resolveViewSelection(client.channel, graphView, { interface: definition.info.id });
            expect(JSON.parse(await graphView.open(context, { json: true }))).toEqual({ title: "live" });
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(cancelled).toBe(true);
            expect(methods).toContain("watch");
            expect(methods).toContain("fetch");
        } finally {
            client.close(); server.close();
        }
    });
});
