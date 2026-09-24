import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
    type JsonValue,
    type InterfaceTemplatesMetadata,
    type RawStreamingCall,
    defineInterface,
} from "@hediet/linkrpc";
import {
    graphRefSchema,
    GraphObjects,
    GraphRoot,
} from "@hediet/linkrpc-infra/graph";
import type { DiscoveredListing } from "@hediet/linkrpc/hub/common";
import type { CliChannel } from "@hediet/linkrpc-client";
import {
    graphDescriptorsFromSchema,
    renderGraphTargetList,
    selectGraphTarget,
    watchRoots,
    type GraphTarget,
} from "./inspectGraph";

describe("graph reflection discovery", () => {
    it("recognizes standard templates through custom containing interface identities", () => {
        const objects = GraphObjects({ ref: graphRefSchema, value: z.unknown() as z.ZodType<JsonValue> });
        const root = GraphRoot({ params: z.object({ workspace: z.string() }), ref: graphRefSchema });
        const graph = defineInterface({ id: "acme.custom.graph" }, {
            fetchObjects: objects.members.batchObjGet,
            watchSessions: root.members.watch,
            watch: root.members.watch,
        }, { templates: {
            cache: objects.mapMembers({ batchObjGet: 'fetchObjects' }),
            sessions: root.mapMembers({ watch: 'watchSessions' }),
            all: root.mapMembers({ watch: 'watch' }),
        } });
        const graphDescriptors = graphDescriptorsFromSchema(
            listing("worker", graph.info.id, graph.schemaHash),
            graph.toSchema(),
        );
        expect(graphDescriptors.stores).toEqual([
            expect.objectContaining({
                serviceId: "worker",
                interfaceId: "acme.custom.graph",
                batchMethod: "worker::acme.custom.graph::fetchObjects",
            }),
        ]);
        expect(graphDescriptors.roots).toEqual([
            expect.objectContaining({
                serviceId: "worker",
                interfaceId: "acme.custom.graph",
                root: "sessions",
                watchMethod: "worker::acme.custom.graph::watchSessions",
            }),
            expect.objectContaining({ root: "all", watchMethod: "worker::acme.custom.graph::watch" }),
        ]);
    });

    it("rejects multiple stores, unmatched refs, and roots in another containing interface", () => {
        const objects = GraphObjects({ ref: graphRefSchema, value: z.string() });
        const root = GraphRoot({ params: z.object({}), ref: z.string() });
        const existing = defineInterface({ id: 'invalid' }, {
            first: objects.members.batchObjGet, second: objects.members.batchObjGet, watch: root.members.watch,
        });
        const multiple = defineInterface(existing.info, existing.members, { templates: {
            a: objects.mapMembers({ batchObjGet: 'first' }),
            b: objects.mapMembers({ batchObjGet: 'second' }),
        } });
        expect(() => graphDescriptorsFromSchema(listing('', existing.info.id, existing.schemaHash), multiple.toSchema())).toThrow(/at most one/);
        const unmatched = defineInterface(existing.info, existing.members, { templates: {
            objects: objects.mapMembers({ batchObjGet: 'first' }),
            root: root.mapMembers({ watch: 'watch' }),
        } });
        expect(() => graphDescriptorsFromSchema(listing('', unmatched.info.id, unmatched.schemaHash), unmatched.toSchema())).toThrow(/compatible objects instance/);
        const standalone = defineInterface({ id: 'root.only' }, root.members, {
            templates: { root: root.mapMembers({ watch: 'watch' }) },
        });
        expect(() => graphDescriptorsFromSchema(listing('', standalone.info.id, standalone.schemaHash), standalone.toSchema())).toThrow(/same interface/);
    });

    it("supports dollar-delimited concrete member names through explicit mappings", () => {
        const objects = GraphObjects({ ref: graphRefSchema, value: z.string() });
        const graph = defineInterface({ id: 'mapped' }, { 'cache$batchObjGet': objects.members.batchObjGet }, {
            templates: { cache: objects.mapMembers({ batchObjGet: 'cache$batchObjGet' }) },
        });
        expect(graphDescriptorsFromSchema(listing('', graph.info.id, graph.schemaHash), graph.toSchema()).stores[0]?.batchMethod)
            .toBe('mapped::cache$batchObjGet');
    });

    it("lists ambiguous roots and requires exact selectors", () => {
        const targets = [
            target("worker-a", "acme.roots", "recent"),
            target("worker-b", "acme.roots", "recent"),
        ];
        expect(selectGraphTarget(targets, {})).toBeUndefined();
        expect(() => selectGraphTarget(targets, { root: "recent" })).toThrow(/ambiguous/);
        expect(selectGraphTarget(targets, {
            serviceId: "worker-b",
            interfaceId: "acme.roots",
            root: "recent",
        })?.serviceId).toBe("worker-b");
        expect(renderGraphTargetList({ targets, warnings: [] })).toContain(
            "worker-a::acme.roots root=recent objects=acme.objects",
        );
    });

    it("rejects a self-consistent template spoofing a standard identity", () => {
        const objects = GraphObjects({ ref: graphRefSchema, value: z.string() });
        const graph = defineInterface({ id: 'graph' }, objects.members, {
            templates: { objects: objects.mapMembers({ batchObjGet: 'batchObjGet' }) },
        });
        const schema = graph.toSchema();
        const metadata = schema["x-interface-templates"] as InterfaceTemplatesMetadata;
        const instance = metadata.instances[0]!;
        const spoofed = {
            ...schema,
            "x-interface-templates": {
                templates: {
                    [instance.template]: { id: instance.template, parameters: [], methods: {} },
                },
                instances: [{ ...instance, arguments: {}, members: {} }],
            },
        };
        expect(() => graphDescriptorsFromSchema(
            listing("", graph.info.id, graph.schemaHash), spoofed,
        )).toThrow(/Unsupported graph template contract/);
    });
});

describe("graph root watch lifecycle", () => {
    function fixture() {
        let push!: (payload: JsonValue) => void;
        const call: RawStreamingCall = {
            result: new Promise(() => {}),
            send: vi.fn(),
            cancel: vi.fn(),
            dispose: vi.fn(),
            ping: async () => {},
        };
        const channel: Pick<CliChannel, "sendRequestWithStream"> = {
            sendRequestWithStream: (_method, _params, options) => {
                push = payload => options?.onStreamMessage?.(payload);
                return call;
            },
        };
        return { channel, call, push: (payload: JsonValue) => push(payload) };
    }

    it("cancels a watch that never offers a root", async () => {
        const { channel, call } = fixture();
        await expect(watchRoots(
            channel, target("", "demo", "sessions"), {}, undefined, 10, async () => false,
        )).rejects.toThrow("produced no root");
        expect(call.cancel).toHaveBeenCalledOnce();
        expect(call.dispose).toHaveBeenCalledOnce();
    });

    it("propagates failures after the initial successful offer", async () => {
        const { channel, call, push } = fixture();
        const watching = watchRoots(
            channel, target("", "demo", "sessions"), {}, undefined, 1_000,
            async offer => {
                if (offer.version === 2) throw new Error("second load failed");
                return true;
            },
        );
        const failed = expect(watching).rejects.toThrow("second load failed");
        push({ version: 1, ref: { kind: "node", id: "one" } });
        await new Promise(resolve => setTimeout(resolve, 0));
        push({ version: 2, ref: { kind: "node", id: "two" } });
        await failed;
        expect(call.cancel).toHaveBeenCalledOnce();
    });
});

function listing(serviceId: string, interfaceId: string, hash: string): DiscoveredListing {
    return {
        serviceId,
        interfaceId,
        hash,
        discoveredFrom: serviceId,
    };
}

function target(serviceId: string, interfaceId: string, root: string): GraphTarget {
    const argument = { schema: { type: "string" } as const };
    return {
        serviceId,
        interfaceId,
        hash: "hash",
        graphInterfaceId: "acme.objects",
        root,
        watchMethod: `${serviceId}::${interfaceId}::root$watch`,
        batchMethod: `${serviceId}::acme.objects::objects$batchObjGet`,
        paramsArgument: argument,
        refArgument: argument,
        valueArgument: argument,
    };
}
