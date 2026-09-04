import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
    defineInterface,
    notificationType,
    requestType,
    LinkRpcConnection,
    TransportPair,
} from "@hediet/linkrpc";
import { connectViaTransport } from "@hediet/linkrpc-client";
import type { CliChannel } from "@hediet/linkrpc-client";
import { createHubDump, createInitialHubDump, lsCommand, type HubDump } from "./ls";
import type { JsonPatchOperation, JsonValue } from "./jsonPatch";
import { defaultsCommand } from "./defaults";
import { schemaCommand } from "./schema";
import { callCommand, notifyCommand } from "./call";
import { pingCommand } from "./ping";
import { diffSchemas } from "./checkCompat";

const mailerInterface = defineInterface(
    { id: "acme.email", description: "Send and inspect mail." },
    {
        send: requestType(
            z.object({
                to: z.string(),
                subject: z.string(),
                body: z.string(),
            }),
            z.object({ messageId: z.string() }),
        ),
        bounce: notificationType(z.object({ to: z.string() })),
    },
);

interface Fixture {
    client: CliChannel;
    server: LinkRpcConnection;
    received: { bounceTo: string[] };
    dispose: () => void;
}

function makeFixture(): Fixture {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.b);
    const received = { bounceTo: [] as string[] };

    server.register(mailerInterface, {
        send: async ({ to, subject }) => ({ messageId: `m_${to}_${subject.length}` }),
        bounce: ({ to }) => { received.bounceTo.push(to); },
    });
    server.service("acme.mailer").register(mailerInterface, {
        send: async ({ to }) => ({ messageId: `mailer_${to}` }),
        bounce: () => { },
    });
    server.setPreset(mailerInterface);
    server.enableReflection();
    // Mirror the hub-mode convention: services that live behind a prefix
    // expose reflection both at root and at their prefix, so form-3
    // `<prefix>::hubrpc.schemas::get` resolves.
    server.enableReflection({ serviceId: "acme.mailer" });

    const conn = connectViaTransport(pair.a);
    return {
        client: conn.channel,
        server,
        received,
        dispose: () => {
            conn.close();
            server.close();
        },
    };
}

describe("CLI commands against an in-process linkrpc server", () => {
    it("ls lists all registered interfaces", async () => {
        const fx = makeFixture();
        try {
            const out = await lsCommand(fx.client, { json: true });
            const listings = JSON.parse(out) as { interfaceId: string; serviceId: string }[];
            const ids = listings
                .filter((l) => l.interfaceId === mailerInterface.info.id)
                .map((l) => l.serviceId)
                .sort();
            expect(ids).toEqual(["", "acme.mailer"]);
        } finally {
            fx.dispose();
        }
    });

    it("ls dump preserves directory reporters and deduplicates schemas by hash", async () => {
        const fx = makeFixture();
        const directory = await mkdtemp(path.join(tmpdir(), "linkrpc-ls-dump-"));
        const dumpPath = path.join(directory, "fixtures", "hub.json");
        try {
            const out = await lsCommand(fx.client, { dumpPath });
            const dump = JSON.parse(await readFile(dumpPath, "utf8")) as HubDump;

            expect(out).toContain(dumpPath);
            expect(dump.format).toBe("linkrpc-hub-dump");
            expect(dump.version).toBe(2);
            expect(dump.complete).toBe(true);
            expect(dump.schemasComplete).toBe(true);
            expect(dump.root.target).toEqual({ kind: "root" });
            expect(Object.keys(dump.directories)).toContain("acme.mailer");
            expect(dump.root.nativeListings).toContainEqual(expect.objectContaining({
                    serviceId: "acme.mailer",
                    interfaceId: "hubrpc.directory",
            }));
            expect(dump.schemas[mailerInterface.schemaHash]).toEqual(expect.objectContaining({
                id: mailerInterface.info.id,
                hash: mailerInterface.schemaHash,
            }));
            expect(Object.keys(dump.schemas).filter((hash) => hash === mailerInterface.schemaHash))
                .toHaveLength(1);
            expect(dump.schemaErrors).toEqual({});
        } finally {
            fx.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("ls streams progressive listings as a patch log", async () => {
        const fx = makeFixture();
        const lines: string[] = [];
        try {
            const out = await lsCommand(fx.client, {
                stream: true,
                emitLine: (line) => { lines.push(line); },
            });
            const records = lines.map(parsePatchLogLine);
            const event = currentPatchLogValue(lines) as {
                type: string;
                complete: boolean;
                listings: { serviceId: string; interfaceId: string }[];
            };

            expect(out).toBe("");
            expect(records[0]).toMatchObject({
                message: "Directory snapshot: subscribed",
                time: expect.any(Number),
                value: {
                    type: "snapshot",
                    complete: false,
                    listings: [],
                },
            });
            expect(records[0]).not.toHaveProperty("patch");
            expect(records.slice(1).every((record) =>
                record.value === undefined && Array.isArray(record.patch)
            )).toBe(true);
            expect(records.at(-1)?.message).toBe("Directory exploration settled");
            expect(event.type).toBe("settled");
            expect(event.complete).toBe(true);
            expect(event.listings).toContainEqual(expect.objectContaining({
                serviceId: "acme.mailer",
                interfaceId: mailerInterface.info.id,
            }));
        } finally {
            fx.dispose();
        }
    });

    it("ls watch appends patch-log changes for service additions and removals", async () => {
        const fx = makeFixture();
        const lines: string[] = [];
        let stop!: () => void;
        const stopped = new Promise<void>((resolve) => { stop = resolve; });
        let registration: { dispose(): void } | undefined;
        try {
            const running = lsCommand(fx.client, {
                watch: true,
                stop: stopped,
                emitLine: (line) => { lines.push(line); },
            });
            await until(() => {
                if (lines.length === 0) return false;
                const value = currentPatchLogValue(lines) as { complete: boolean };
                return value.complete;
            });

            registration = fx.server.service("acme.dynamic").register(mailerInterface, {
                send: async ({ to }) => ({ messageId: `dynamic_${to}` }),
                bounce: () => {},
            });
            await until(() => {
                const value = currentPatchLogValue(lines) as {
                    listings: { serviceId: string }[];
                };
                return value.listings.some((listing) => listing.serviceId === "acme.dynamic");
            });

            registration.dispose();
            registration = undefined;
            await until(() => {
                const value = currentPatchLogValue(lines) as {
                    listings: { serviceId: string }[];
                };
                return !value.listings.some((listing) => listing.serviceId === "acme.dynamic");
            });
            stop();
            await running;

            expect(lines.map(parsePatchLogLine).slice(1).every((record) =>
                record.value === undefined && Array.isArray(record.patch)
            )).toBe(true);
        } finally {
            registration?.dispose();
            stop();
            fx.dispose();
        }
    });

    it("ls rejects output flags that would be silently ignored by streaming modes", async () => {
        const fx = makeFixture();
        try {
            await expect(lsCommand(fx.client, {
                stream: true,
                withMembers: true,
                emitLine: () => {},
            })).rejects.toThrow("--stream/--watch already emit JSON");
        } finally {
            fx.dispose();
        }
    });

    it("ls dump patches converge the initial document to the full dump", async () => {
        const fx = makeFixture();
        const lines: string[] = [];
        try {
            const out = await lsCommand(fx.client, {
                dumpPatchesPath: "-",
                emitLine: (line) => { lines.push(line); },
            });
            const operations = lines.map((line) =>
                JSON.parse(line) as JsonPatchOperation
            );
            const dump = applyPatch(
                JSON.parse(JSON.stringify(createInitialHubDump())) as JsonValue,
                operations,
            ) as HubDump;

            expect(out).toBe("");
            expect(operations.length).toBeGreaterThan(0);
            expect(dump.complete).toBe(true);
            expect(dump.schemasComplete).toBe(true);
            expect(dump.directories["acme.mailer"]).toBeDefined();
            expect(dump.schemas[mailerInterface.schemaHash]).toEqual(expect.objectContaining({
                id: mailerInterface.info.id,
            }));
            expect(dump).toEqual(await createHubDump(fx.client));
        } finally {
            fx.dispose();
        }
    });

    it("ls dump patches converge after watched service additions and removals", async () => {
        const fx = makeFixture();
        const lines: string[] = [];
        let stop!: () => void;
        const stopped = new Promise<void>((resolve) => { stop = resolve; });
        try {
            const running = lsCommand(fx.client, {
                dumpPatchesPath: "-",
                watch: true,
                stop: stopped,
                emitLine: (line) => { lines.push(line); },
            });
            await until(() => currentPatchedDump(lines).schemasComplete);

            const registration = fx.server.service("acme.dynamic").register(mailerInterface, {
                send: async ({ to }) => ({ messageId: `dynamic_${to}` }),
                bounce: () => {},
            });
            await until(() => currentPatchedDump(lines).listings.some((listing) =>
                listing.serviceId === "acme.dynamic"
                && listing.interfaceId === mailerInterface.info.id
            ));

            registration.dispose();
            await until(() => {
                const dump = currentPatchedDump(lines);
                return dump.schemasComplete && !dump.listings.some((listing) =>
                    listing.serviceId === "acme.dynamic"
                );
            });
            stop();
            await running;

            const actual = currentPatchedDump(lines);
            const expected = await createHubDump(fx.client);
            expect({ ...actual, revision: expected.revision }).toEqual(expected);
            expect(actual.revision).toBeGreaterThan(expected.revision);
        } finally {
            stop();
            fx.dispose();
        }
    });

    it("ls includes request and notification members when requested", async () => {
        const fx = makeFixture();
        try {
            const json = await lsCommand(fx.client, {
                interfaceId: mailerInterface.info.id,
                json: true,
                withMembers: true,
            });

            const listings = JSON.parse(json) as {
                serviceId: string;
                members: { name: string; kind: string }[];
            }[];
            expect(listings.find((listing) => listing.serviceId === "")?.members).toEqual([
                { name: "bounce", kind: "notification" },
                { name: "send", kind: "request" },
            ]);

            const text = await lsCommand(fx.client, {
                serviceId: "acme.mailer",
                interfaceId: mailerInterface.info.id,
                withMembers: true,
            });
            expect(text).toContain("notification  bounce");
            expect(text).toContain("request       send");
        } finally {
            fx.dispose();
        }
    });

    it("defaults reports the preset interface", async () => {
        const fx = makeFixture();
        try {
            const out = await defaultsCommand(fx.client, { json: true });
            const d = JSON.parse(out) as { interfaceId?: string; hash?: string };
            expect(d.interfaceId).toBe(mailerInterface.info.id);
            expect(d.hash).toBe(mailerInterface.schemaHash);
        } finally {
            fx.dispose();
        }
    });

    it("schema fetches the interface schema", async () => {
        const fx = makeFixture();
        try {
            const out = await schemaCommand(fx.client, {
                interfaceId: mailerInterface.info.id,
                json: true,
            });
            const schema = JSON.parse(out) as { id: string; methods: { name: string }[] };
            expect(schema.id).toBe(mailerInterface.info.id);
            expect(Object.keys(schema.methods).sort()).toEqual(["bounce", "send"]);
        } finally {
            fx.dispose();
        }
    });

    it("call validates params against the live schema and round-trips", async () => {
        const fx = makeFixture();
        try {
            const out = await callCommand(fx.client, {
                methodRef: "acme.email::send",
                paramOverrides: ["to=a@b.c", "subject=hi", "body=...."],
            });
            expect(JSON.parse(out)).toEqual({ messageId: "m_a@b.c_2" });
        } finally {
            fx.dispose();
        }
    });

    it("call validates a bare method against the preset interface schema", async () => {
        const fx = makeFixture();
        try {
            const out = await callCommand(fx.client, {
                methodRef: "send",
                paramOverrides: ["to=a@b.c", "subject=hi", "body=...."],
            });
            expect(JSON.parse(out)).toEqual({ messageId: "m_a@b.c_2" });
        } finally {
            fx.dispose();
        }
    });

    it("call reports preset schema validation errors for a bare method", async () => {
        const fx = makeFixture();
        try {
            await expect(
                callCommand(fx.client, {
                    methodRef: "send",
                    paramOverrides: ["to=a@b.c"],
                }),
            ).rejects.toThrow(/Param validation failed for send/);
        } finally {
            fx.dispose();
        }
    });

    it("call routes form-3 references to the right service", async () => {
        const fx = makeFixture();
        try {
            const out = await callCommand(fx.client, {
                methodRef: "acme.mailer::acme.email::send",
                paramOverrides: ["to=alice@x.y", "subject=hi", "body=..."],
            });
            expect(JSON.parse(out)).toEqual({ messageId: "mailer_alice@x.y" });
        } finally {
            fx.dispose();
        }
    });

    it("call rejects malformed params with --no-validate off (default)", async () => {
        const fx = makeFixture();
        try {
            await expect(
                callCommand(fx.client, {
                    methodRef: "acme.email::send",
                    paramOverrides: ["to=a@b.c"],
                }),
            ).rejects.toThrow(/Param validation failed/);
        } finally {
            fx.dispose();
        }
    });

    it("call --no-validate sends as-is and surfaces the server's invalidParams error", async () => {
        const fx = makeFixture();
        try {
            await expect(
                callCommand(fx.client, {
                    methodRef: "acme.email::send",
                    paramOverrides: ["to=a@b.c"],
                    noValidate: true,
                }),
            ).rejects.toThrow(/RPC error -32602/);
        } finally {
            fx.dispose();
        }
    });

    it("notify delivers a notification", async () => {
        const fx = makeFixture();
        try {
            await notifyCommand(fx.client, {
                methodRef: "acme.email::bounce",
                paramOverrides: ["to=ghost@x.y"],
            });
            // Notifications are fire-and-forget — wait one microtask for delivery.
            await new Promise((r) => setTimeout(r, 0));
            expect(fx.received.bounceTo).toEqual(["ghost@x.y"]);
        } finally {
            fx.dispose();
        }
    });

    it("ping returns a `pong ...ms` line", async () => {
        const fx = makeFixture();
        try {
            const out = await pingCommand(fx.client);
            expect(out).toMatch(/^pong  /);
        } finally {
            fx.dispose();
        }
    });

    it("diffSchemas reports identical when hashes match", () => {
        const schema = mailerInterface.toSchema();
        const verdict = diffSchemas(schema, schema);
        expect(verdict).toEqual({ kind: "identical", hash: schema.hash });
    });

    it("diffSchemas detects missing methods on the remote", () => {
        const remote = mailerInterface.toSchema();
        const local = {
            ...remote,
            hash: "deadbe",
            methods: {
                ...remote.methods,
                extraMethod: { params: true as const, result: true as const },
            },
        };
        const verdict = diffSchemas(local, remote);
        expect(verdict.kind).toBe("incompatible");
        if (verdict.kind === "incompatible") {
            expect(verdict.details).toMatch(/extraMethod/);
        }
    });
});

function applyPatch(initial: JsonValue, operations: readonly JsonPatchOperation[]): JsonValue {
    let document = structuredClone(initial);
    for (const operation of operations) {
        if (operation.path === "") {
            if (operation.op === "remove") {
                throw new Error("Cannot remove the document root");
            }
            document = structuredClone(operation.value);
            continue;
        }
        const segments = operation.path
            .slice(1)
            .split("/")
            .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
        let parent = document as { [key: string]: JsonValue };
        for (const segment of segments.slice(0, -1)) {
            parent = parent[segment] as { [key: string]: JsonValue };
        }
        const key = segments.at(-1)!;
        if (operation.op === "remove") {
            delete parent[key];
        } else {
            parent[key] = structuredClone(operation.value);
        }
    }
    return document;
}

function currentPatchedDump(lines: readonly string[]): HubDump {
    return applyPatch(
        JSON.parse(JSON.stringify(createInitialHubDump())) as JsonValue,
        lines.map((line) => JSON.parse(line) as JsonPatchOperation),
    ) as HubDump;
}

interface PatchLogLine {
    readonly message: string;
    readonly time: number;
    readonly value?: JsonValue;
    readonly patch?: readonly JsonPatchOperation[];
}

function parsePatchLogLine(line: string): PatchLogLine {
    return JSON.parse(line) as PatchLogLine;
}

function currentPatchLogValue(lines: readonly string[]): JsonValue {
    const first = lines[0];
    if (first === undefined) throw new Error("Patch log has no initial value");
    const initial = parsePatchLogLine(first);
    if (initial.value === undefined) throw new Error("Patch log first line has no value");
    let current = structuredClone(initial.value);
    for (const line of lines.slice(1)) {
        const record = parsePatchLogLine(line);
        if (record.patch === undefined) throw new Error("Patch log continuation has no patch");
        current = applyPatch(current, record.patch);
    }
    return current;
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
