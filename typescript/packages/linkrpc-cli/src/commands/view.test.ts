import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { z } from "zod";
import { defineInterface, type JsonValue } from "@hediet/linkrpc";
import { GraphObjects, GraphRoot, graphRefSchema } from "@hediet/linkrpc-infra/graph";
import type { CliChannel } from "@hediet/linkrpc-client";
import { graphView, resolveGraphRoots } from "../infra/graph/contribution";
import { discoverViewTargets, resolveViewSelection, resolveViewTarget } from "../views/discovery";
import { interfaceTarget, matchesTarget } from "../views/types";
import { registerViewCommands, viewList } from "./view";
import { withStaticHubReflection } from "./staticHubReflection";

const objects = GraphObjects({ ref: graphRefSchema, value: z.unknown() as z.ZodType<JsonValue> });
const root = GraphRoot({ params: z.object({}), ref: graphRefSchema });
const definition = defineInterface({ id: "test.custom", tags: ["linkrpc.graph"] }, {
    fetch: objects.members.batchObjGet, watch: root.members.watch,
}, { templates: {
    objects: objects.mapMembers({ batchObjGet: "fetch" }),
    sessions: root.mapMembers({ watch: "watch" }),
} });

function fixture({ defaultRoot = false, tags = ["linkrpc.graph"], serviceId = "worker" } = {}) {
    const methods: string[] = [];
    const params: unknown[] = [];
    const cancellations: string[] = [];
    const listing = { serviceId, interfaceId: definition.info.id, interfaceHash: definition.schemaHash, tags };
    const channel: CliChannel = {
        async sendRequest(method, value) {
            methods.push(method); params.push(value);
            if (method === "hubrpc.directory::list") return { items: [listing] };
            if (method === "hubrpc.defaults::get") return defaultRoot
                ? { interfaceId: definition.info.id, interfaceHash: definition.schemaHash } : {};
            if (method.endsWith("hubrpc.schemas::get")) return { schema: definition.toSchema() } as unknown as JsonValue;
            throw new Error(`Unexpected method ${method}`);
        },
        async sendNotification() {},
        sendRequestWithStream(method, value, options) {
            if (method.includes("hubrpc.directory::list") || method.endsWith("hubrpc.schemas::get")) return {
                result: channel.sendRequest(method, value), send() {}, cancel() {}, ping: async () => {},
            };
            methods.push(method); params.push(value);
            if (method.endsWith("watch") || method.endsWith("watch2")) {
                queueMicrotask(() => options?.onStreamMessage?.({ version: 1, ref: { kind: "node", id: "root" } }));
                return {
                    result: new Promise<JsonValue>(() => {}), send() {}, ping: async () => {},
                    cancel() { cancellations.push(method); },
                };
            }
            if (method.endsWith("fetch")) return {
                result: Promise.resolve({ objects: [{ ref: { kind: "node", id: "root" }, value: { title: "hello" } }], missing: [], complete: true }),
                send() {}, cancel() {}, ping: async () => {},
            };
            throw new Error(`Unexpected stream ${method}`);
        },
        close() {},
    };
    return { channel, methods, params, cancellations };
}

describe("compiled-in views", () => {
    it("resolves a unique interface and opens it on one ephemeral connection", async () => {
        const f = fixture();
        const output: string[] = [];
        const command = new Command();
        const connect = vi.fn(async (action: (channel: CliChannel) => Promise<void>) => { await action(f.channel); });
        registerViewCommands(command, connect, text => output.push(text));
        await command.parseAsync([
            "view", "open", "graph", "--interface", definition.info.id,
            "--root", "sessions", "--json", "--depth", "2",
        ], { from: "user" });
        expect(connect).toHaveBeenCalledOnce();
        expect(f.methods.filter(method => method === "hubrpc.directory::list")).toHaveLength(1);
        expect(JSON.parse(output[0]!)).toEqual({ title: "hello" });
    });

    it("coalesces default and qualified entries for unique interface selection", async () => {
        const f = fixture({ defaultRoot: true, serviceId: "" });
        const context = await resolveViewSelection(f.channel, graphView, { interface: definition.info.id });
        expect(context.target.kind).toBe("interface");
        expect(context.interfaces[0]?.isDefault).toBe(true);
        expect(resolveGraphRoots(context)[0]?.watchMethod).toBe("watch");
    });

    it("requires unique selectors, supports service narrowing, and rejects missing selection", async () => {
        const f = fixture();
        const base = f.channel.sendRequest.bind(f.channel);
        f.channel.sendRequest = async (method, params, options) => method === "hubrpc.directory::list"
            ? { items: ["one", "two"].map(serviceId => ({
                serviceId, interfaceId: definition.info.id, interfaceHash: definition.schemaHash, tags: ["linkrpc.graph"],
            })) } : base(method, params, options);
        await expect(resolveViewSelection(f.channel, graphView, { interface: definition.info.id })).rejects.toThrow("ambiguous");
        expect(f.methods.some(method => method.includes("schemas"))).toBe(false);
        const selected = await resolveViewSelection(f.channel, graphView, { interface: definition.info.id, service: "two" });
        expect(selected.target.serviceId).toBe("two");
        const service = await resolveViewSelection(f.channel, graphView, { service: "one" });
        expect(service.target.kind).toBe("service");
        await expect(resolveViewSelection(f.channel, graphView, {})).rejects.toThrow("Specify --target");
        await expect(resolveViewSelection(f.channel, graphView, { interface: "missing" })).rejects.toThrow("No matching target");
    });

    it("prints actual interface/service tag conditions and both modes offline", async () => {
        expect(viewList()).toContain("interface:tag(linkrpc.graph)");
        expect(viewList()).toContain("service:implements(tag(linkrpc.graph))");
        expect(viewList()).toContain("cli,tui");
        const connect = vi.fn();
        const output: string[] = [];
        const command = new Command();
        registerViewCommands(command, connect, value => output.push(value));
        await command.parseAsync(["view", "list", "--json"], { from: "user" });
        expect(connect).not.toHaveBeenCalled();
        expect(JSON.parse(output[0]!)[0].conditions).not.toContain("templateId");
    });

    it("lists tagged targets without schema reads, watch calls, or data loads", async () => {
        const f = fixture();
        const result = await discoverViewTargets(f.channel, graphView);
        expect(result.targets.map(target => target.kind).sort()).toEqual(["interface", "service"]);
        expect(f.methods).toEqual(["hubrpc.directory::list", "hubrpc.defaults::get"]);
        expect(result.targets.find(target => target.kind === "interface")!.id).toBe("interface:worker::test.custom:qualified");
        expect(result.targets.find(target => target.kind === "service")!.id).toBe("service:worker:");
    });

    it("matches names or tags, never template IDs or service name prefixes", () => {
        const target = interfaceTarget({ serviceId: "worker/sub", discoveredFrom: "", interfaceId: "acme.api", tags: [] });
        expect(matchesTarget(target, { conditions: [{ kind: "interface", interface: { interfaceId: "acme.api" } }] })).toBe(true);
        expect(matchesTarget(target, graphView)).toBe(false);
        expect(viewList()).not.toContain("template");
    });

    it("does not fetch a schema for an explicit nonmatching tag list", async () => {
        const f = fixture({ tags: ["unrelated"] });
        expect((await discoverViewTargets(f.channel, graphView)).targets).toEqual([]);
        expect(f.methods.every(method => !method.includes("schemas"))).toBe(true);
    });

    it("re-resolves latest schema and routes through the selected service", async () => {
        const f = fixture();
        const context = await resolveViewTarget(f.channel, graphView, "service:worker:");
        const roots = resolveGraphRoots(context);
        expect(roots[0]!.watchMethod).toBe("worker::test.custom::watch");
        const schemaParams = f.params[f.methods.findIndex(method => method.includes("schemas"))] as Record<string, unknown>;
        expect(schemaParams.hash).toBe(definition.schemaHash);
        const snapshot = await graphView.open(context, { json: true });
        expect(JSON.parse(snapshot)).toBeDefined();
        expect(f.cancellations).toEqual(["worker::test.custom::watch"]);
    });

    it("supports root service/default interface with bare invocation", async () => {
        const f = fixture({ serviceId: "", defaultRoot: true });
        expect((await discoverViewTargets(f.channel, graphView)).targets.some(target => target.id === "service::")).toBe(true);
        expect(f.methods.some(method => method.includes("schemas"))).toBe(false);
        const context = await resolveViewTarget(f.channel, graphView, "service::");
        expect(context.target.kind).toBe("service");
        expect(context.interfaces).toHaveLength(1);
        expect(resolveGraphRoots(context)[0]!.watchMethod).toBe("watch");
        await graphView.open(context, { json: true });
        expect(f.methods).toContain("watch");
        expect(f.methods).toContain("fetch");
    });

    it("lists root schemas without starting any graph call", async () => {
        const f = fixture();
        const context = await resolveViewTarget(f.channel, graphView, "service:worker:");
        const count = f.methods.length;
        const rows = JSON.parse(await graphView.open(context, { mode: "roots", json: true }));
        expect(rows[0].root).toBe("sessions");
        expect(f.methods).toHaveLength(count);
    });

    it("rejects invalid params and spoofed tags before graph calls", async () => {
        const f = fixture();
        const context = await resolveViewTarget(f.channel, graphView, "service:worker:");
        const count = f.methods.length;
        await expect(graphView.open(context, { params: "not json" })).rejects.toThrow("--params");
        await expect(graphView.open(context, { params: "null" })).rejects.toThrow("root params");
        await expect(graphView.open({
            ...context, interfaces: context.interfaces.map(item => ({ ...item, schema: { ...item.schema, "x-interface-templates": undefined } })),
        }, {})).rejects.toThrow("no compatible graph roots");
        expect(f.methods).toHaveLength(count);
    });

    it("reports ambiguous roots and resolves a root by exact name", async () => {
        const f = fixture();
        const context = await resolveViewTarget(f.channel, graphView, "service:worker:");
        const multiple = defineInterface(definition.info, {
            ...definition.members, watch2: root.members.watch,
        }, { templates: {
            objects: objects.mapMembers({ batchObjGet: "fetch" }),
            sessions: root.mapMembers({ watch: "watch" }),
            other: root.mapMembers({ watch: "watch2" }),
        } });
        const two = {
            ...context,
            interfaces: [{ ...context.interfaces[0]!, schema: multiple.toSchema() }],
        };
        await expect(graphView.open(two, {})).rejects.toThrow("ambiguous");
        expect(JSON.parse(await graphView.open(two, { mode: "roots", json: true }))).toHaveLength(2);
        await graphView.open(two, { root: "other", json: true });
        expect(f.methods).toContain("worker::test.custom::watch2");
    });

    it("watch emits independently parseable JSONL and cancels its root stream", async () => {
        const f = fixture();
        const context = await resolveViewTarget(f.channel, graphView, "service:worker:");
        let stop!: () => void;
        const stopped = new Promise<void>(resolve => { stop = resolve; });
        const lines: string[] = [];
        await graphView.open(context, {
            mode: "watch", json: true, stop: stopped,
            emit(value: string) { lines.push(value); stop(); },
        });
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain("\n");
        expect(JSON.parse(lines[0]!)).toBeDefined();
        expect(f.cancellations).toHaveLength(1);
    });

    it("rejects a disappeared target and never treats row numbers as IDs", async () => {
        const f = fixture();
        await expect(resolveViewTarget(f.channel, graphView, "0")).rejects.toThrow("Unknown or unavailable");
    });

    it("rejects ambiguous schema revisions instead of silently selecting a row", async () => {
        const f = fixture();
        const base = f.channel.sendRequest.bind(f.channel);
        f.channel.sendRequest = async (method, params, options) => method === "hubrpc.directory::list"
            ? { items: ["first", "second"].map(interfaceHash => ({
                serviceId: "worker", interfaceId: definition.info.id, interfaceHash, tags: ["linkrpc.graph"],
            })) } : base(method, params, options);
        const result = await discoverViewTargets(f.channel, graphView);
        expect(result.targets.map(target => target.id)).toHaveLength(2);
        await expect(resolveViewTarget(f.channel, graphView, "service:worker:")).rejects.toThrow("ambiguous");
    });

    it("does not scan schemas for many absent-tag rows, even on entirely tagless directories", async () => {
        const f = fixture();
        const base = f.channel.sendRequest.bind(f.channel);
        f.channel.sendRequest = async (method, params, options) => method === "hubrpc.directory::list"
            ? { items: Array.from({ length: 100 }, (_, index) => ({
                serviceId: `worker-${index}`, interfaceId: `test.untagged.${index}`, interfaceHash: "old",
            })) }
            : base(method, params, options);
        const result = await discoverViewTargets(f.channel, graphView);
        expect(result.targets).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(f.methods.some(method => method.includes("schemas"))).toBe(false);
        const byId = await discoverViewTargets(f.channel, {
            ...graphView, conditions: [{ kind: "interface", interface: { interfaceId: "test.untagged.42" } }],
        });
        expect(byId.targets.map(target => target.interfaceId)).toEqual(["test.untagged.42"]);
        expect(f.methods.some(method => method.includes("schemas"))).toBe(false);
    });

    it("rejects an explicit target that conflicts with an interface or service selector", async () => {
        const f = fixture();
        await expect(resolveViewSelection(f.channel, graphView, {
            target: "service:worker:", interface: "other",
        })).rejects.toThrow("--target does not match --interface");
        await expect(resolveViewSelection(f.channel, graphView, {
            target: "interface:worker::test.custom:qualified", interface: "other",
        })).rejects.toThrow("--target does not match --interface");
        await expect(resolveViewSelection(f.channel, graphView, {
            target: "service:worker:", service: "other",
        })).rejects.toThrow("--target does not match --service");
    });

    it("has an explicit TUI option and graph-specific help, not inspect commands", () => {
        const command = new Command();
        registerViewCommands(command, async () => {});
        expect(command.commands.map(value => value.name())).toEqual(["view"]);
        const open = command.commands[0]!.commands.find(value => value.name() === "open")!;
        const help = open.commands[0]!.helpInformation();
        expect(help).toContain("--target <id>");
        expect(help).toContain("--tui");
        expect(help).toContain("--mode <mode>");
        expect(help).not.toContain("template");
    });

    it("preserves the reporting directory separately from the invocation route", async () => {
        const f = fixture();
        const base = f.channel.sendRequest.bind(f.channel);
        f.channel.sendRequest = async (method, params, options) => {
            if (method === "hubrpc.directory::list") return { items: [{
                serviceId: "catalog", interfaceId: "hubrpc.directory", interfaceHash: "directory", tags: [],
                reachableServiceIds: [{ prefix: "" }],
            }] };
            if (method === "catalog::hubrpc.directory::list") return { items: [{
                serviceId: "worker", interfaceId: definition.info.id, interfaceHash: definition.schemaHash, tags: ["linkrpc.graph"],
            }] };
            return base(method, params, options);
        };
        const discovery = await discoverViewTargets(f.channel, graphView);
        expect(discovery.warnings).toEqual([]);
        expect(discovery.targets.map(target => target.id)).toContain("service:worker:catalog");
        const context = await resolveViewTarget(f.channel, graphView, "service:worker:catalog");
        expect(f.methods).toContain("catalog::hubrpc.schemas::get");
        expect(resolveGraphRoots(context)[0]!.watchMethod).toBe("worker::test.custom::watch");
    });

    it("uses a static schema profile for discovery while forwarding graph calls", async () => {
        const f = fixture({ defaultRoot: true, serviceId: "" });
        const ref = { interfaceId: definition.info.id, interfaceHash: definition.schemaHash };
        const channel = withStaticHubReflection(f.channel, {
            services: [{ serviceId: "", interfaces: [ref] }],
            defaultInterface: ref, interfaceSchemas: [definition.toSchema()],
        });
        const context = await resolveViewTarget(channel, graphView, "service::");
        expect(f.methods).toEqual([]);
        await graphView.open(context, { json: true });
        expect(f.methods).toEqual(["watch", "fetch"]);
    });
});
