import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    defineInterface,
    HubRpcConnection,
    requestType,
    TransportPair,
} from "@vscode/hubrpc";
import { connectViaTransport } from "@vscode/hubrpc-client";
import type { CliChannel } from "@vscode/hubrpc-client";
import { applyJsonPatch, type JsonPatchOperation, type JsonValue } from "./jsonPatch";
import { lsCommand, type LsState } from "./ls";
import { topologyCommand } from "./topology";

const pingInterface = defineInterface(
    { id: "test.graph-commands" },
    { ping: requestType(z.object({}), z.object({ ok: z.boolean() })) },
);

interface Fixture {
    readonly client: CliChannel;
    readonly server: HubRpcConnection;
    readonly observedMethods: readonly string[];
    dispose(): void;
}

function makeFixture(): Fixture {
    const pair = new TransportPair();
    const server = HubRpcConnection.fromTransport(pair.b);
    server.register(pingInterface, { ping: () => ({ ok: true }) });
    server.service("one").register(pingInterface, { ping: () => ({ ok: true }) });
    server.service("two").register(pingInterface, { ping: () => ({ ok: true }) });
    server.enableReflection();
    server.enableReflection({ serviceId: "one" });
    server.enableReflection({ serviceId: "two" });
    server.enableInspection();
    const observedMethods: string[] = [];
    server.channel.setWireMessageObserver((_direction, message) => {
        if ("method" in message) observedMethods.push(message.method);
    });
    const connection = connectViaTransport(pair.a);
    return {
        client: connection.channel,
        server,
        observedMethods,
        dispose: () => {
            connection.close();
            server.close();
        },
    };
}

describe("progressive graph commands", () => {
    it("emits final ls state as JSON without starting a watch", async () => {
        const fixture = makeFixture();
        try {
            const state = JSON.parse(await lsCommand(fixture.client, {
                format: "json",
            })) as LsState;

            expect(state.complete).toBe(true);
            expect(state.listings).toContainEqual(expect.objectContaining({
                serviceId: "one",
                interfaceId: pingInterface.info.id,
            }));
            expect(fixture.observedMethods.some((method) => method.endsWith("::watch")))
                .toBe(false);
            const pretty = await lsCommand(fixture.client, { format: "pretty" });
            expect(pretty).toContain("HubRPC directory (complete");
            expect(pretty).toContain("(connection root)");
        } finally {
            fixture.dispose();
        }
    });

    it("streams a reconstructable finite ls query as JSONL", async () => {
        const fixture = makeFixture();
        const lines: string[] = [];
        let current: LsState | undefined;
        try {
            await lsCommand(fixture.client, {
                format: "jsonl",
                emitLine: (line) => { lines.push(line); },
                onState: (state) => { current = state; },
            });
            const state = reconstructState<LsState>(lines);

            expect(lines.length).toBeGreaterThan(1);
            expect(JSON.parse(lines[0])).toMatchObject({
                type: "snapshot",
                revision: expect.any(Number),
            });
            expect(state.complete).toBe(true);
            expect(state.listings).toContainEqual(expect.objectContaining({
                serviceId: "one",
                interfaceId: pingInterface.info.id,
            }));
            expect(state).toEqual(jsonNormalize(current));
        } finally {
            fixture.dispose();
        }
    });

    it.each(["json", "jsonl"] as const)(
        "observes ls additions in %s watch mode",
        async (format) => {
            const fixture = makeFixture();
            const lines: string[] = [];
            let stop!: () => void;
            const stopped = new Promise<void>((resolve) => { stop = resolve; });
            let registration: { dispose(): void } | undefined;
            let current: LsState | undefined;
            try {
                const running = lsCommand(fixture.client, {
                    format,
                    watch: true,
                    stop: stopped,
                    emitLine: (line) => { lines.push(line); },
                    onState: (state) => { current = state; },
                });
                await until(() => current?.complete === true);
                registration = fixture.server.service("dynamic").register(pingInterface, {
                    ping: () => ({ ok: true }),
                });
                await until(() =>
                    current?.listings.some((listing) => listing.serviceId === "dynamic") === true);
                stop();
                const output = await running;
                const finalState = format === "json"
                    ? JSON.parse(output) as LsState
                    : reconstructState<LsState>(lines);

                expect(finalState.listings).toContainEqual(expect.objectContaining({
                    serviceId: "dynamic",
                    interfaceId: pingInterface.info.id,
                }));
                if (format === "jsonl") expect(finalState).toEqual(jsonNormalize(current));
            } finally {
                registration?.dispose();
                stop();
                fixture.dispose();
            }
        },
    );

    it("queries and merges one or multiple topology sources as JSON", async () => {
        const fixture = makeFixture();
        try {
            const single = JSON.parse(await topologyCommand(fixture.client, {
                sources: ["one"],
                format: "json",
            })) as TopologyState;
            const multiple = JSON.parse(await topologyCommand(fixture.client, {
                sources: ["one", "two"],
                format: "json",
            })) as TopologyState;

            expect(single.complete).toBe(true);
            expect(single.sources.map((source) => source.serviceId)).toEqual(["one"]);
            expect(multiple.complete).toBe(true);
            expect(multiple.sources.map((source) => source.serviceId)).toEqual(["one", "two"]);
            expect(multiple.graph.sources).toHaveLength(2);
            expect(fixture.observedMethods.some((method) => method.endsWith("::watchGraph")))
                .toBe(false);
        } finally {
            fixture.dispose();
        }
    });

    it("streams a reconstructable finite topology query as JSONL", async () => {
        const fixture = makeFixture();
        const lines: string[] = [];
        let current: TopologyState | undefined;
        try {
            await topologyCommand(fixture.client, {
                sources: ["one", "two"],
                format: "jsonl",
                emitLine: (line) => { lines.push(line); },
                onState: (state) => { current = state; },
            });
            const state = reconstructState<TopologyState>(lines);

            expect(lines.length).toBeGreaterThan(1);
            expect(state.complete).toBe(true);
            expect(state.sources.map((source) => source.state)).toEqual(["ready", "ready"]);
            expect(state.graph.sources).toHaveLength(2);
            expect(state).toEqual(jsonNormalize(current));
        } finally {
            fixture.dispose();
        }
    });

    it.each(["json", "jsonl"] as const)(
        "observes topology changes in %s watch mode",
        async (format) => {
            const fixture = makeFixture();
            const lines: string[] = [];
            let stop!: () => void;
            const stopped = new Promise<void>((resolve) => { stop = resolve; });
            let registration: { dispose(): void } | undefined;
            let current: TopologyState | undefined;
            let running: Promise<string> | undefined;
            try {
                running = topologyCommand(fixture.client, {
                    format,
                    watch: true,
                    stop: stopped,
                    emitLine: (line) => { lines.push(line); },
                    onState: (state) => { current = state; },
                });
                await until(() => current?.complete === true);
                registration = fixture.server.service("dynamic").register(pingInterface, {
                    ping: () => ({ ok: true }),
                });
                await until(() =>
                    current?.graph.routes.some((route) => route.serviceId === "dynamic") === true);
                stop();
                const output = await running;
                const finalState = format === "json"
                    ? JSON.parse(output) as TopologyState
                    : reconstructState<TopologyState>(lines);

                expect(finalState.graph.routes).toContainEqual(expect.objectContaining({
                    serviceId: "dynamic",
                }));
                if (format === "jsonl") expect(finalState).toEqual(jsonNormalize(current));
            } finally {
                registration?.dispose();
                stop();
                await running?.catch(() => {});
                fixture.dispose();
            }
        },
    );
});

interface TopologyState {
    readonly complete: boolean;
    readonly sources: readonly {
        readonly serviceId: string;
        readonly state: string;
    }[];
    readonly graph: {
        readonly sources: readonly unknown[];
        readonly routes: readonly { readonly serviceId: string }[];
    };
}

function reconstructState<T>(lines: readonly string[]): T {
    let value: JsonValue | undefined;
    let expectedRevision = 0;
    for (const line of lines) {
        const event = JSON.parse(line) as {
            readonly type: "snapshot" | "patch";
            readonly revision: number;
            readonly value?: JsonValue;
            readonly patch?: readonly JsonPatchOperation[];
        };
        expect(event.revision).toBeGreaterThanOrEqual(expectedRevision);
        expectedRevision = event.revision;
        if (event.type === "snapshot") {
            value = event.value;
        } else {
            if (value === undefined || event.patch === undefined) {
                throw new Error("Patch event arrived before the initial snapshot");
            }

            value = applyJsonPatch(value, event.patch);
        }
    }
    if (value === undefined) throw new Error("JSONL stream did not contain a snapshot");
    return value as T;
}

function jsonNormalize<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for graph state");
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}
