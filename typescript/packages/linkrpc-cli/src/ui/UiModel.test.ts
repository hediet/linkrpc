import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
    defineInterface,
    type JsonValue,
    requestType,
    LinkRpcConnection,
    type RawStreamingCall,
    TransportPair,
} from "@hediet/linkrpc";
import { connectViaTransport, type CliChannel } from "@hediet/linkrpc-client";
import { UiModel } from "./UiModel";

const greeter = defineInterface(
    { id: "test.greeter" },
    {
        hello: requestType(
            z.object({ name: z.string() }),
            z.object({ greeting: z.string() }),
        ),
        count: requestType(
            z.object({ to: z.number() }),
            z.object({ done: z.boolean() }),
        ).withStream({ server: z.object({ n: z.number() }) }),
    },
);

function makeModel() {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.b);
    server.register(greeter, {
        hello: async ({ name }) => ({ greeting: `Hi, ${name}!` }),
        count: async ({ to }, _ctx, stream) => {
            for (let i = 1; i <= to; i++) await stream.send({ n: i });
            return { done: true };
        },
    });
    server.enableReflection();
    const conn = connectViaTransport(pair.a);
    const model = new UiModel(conn.channel);
    return {
        model,
        dispose: () => {
            model.dispose();
            conn.close();
            server.close();
        },
    };
}

/** Wait until a sample function returns a truthy value, polling on the microtask queue. */
async function waitFor<T>(sample: () => T | undefined, timeoutMs = 2000): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const v = sample();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("waitFor: timed out");
}

function streamingCall(result: Promise<JsonValue>): RawStreamingCall {
    return {
        result,
        send: () => { },
        cancel: () => { },
        ping: async () => { },
    };
}

describe("UiModel", () => {
    it("starts with no resolved services (loading state)", () => {
        const { model, dispose } = makeModel();
        try {
            // Right after construction the directory promise hasn't resolved.
            expect(model.servicesPromise.promiseResult.get()).toBeUndefined();
        } finally {
            dispose();
        }
    });

    it("resolves the directory listing through ObservablePromise", async () => {
        const { model, dispose } = makeModel();
        try {
            const result = await waitFor(() => model.servicesPromise.promiseResult.get());
            expect(result.error).toBeUndefined();
            const data = result.data!;
            const ids = data.map((s) => s.interfaceId).sort();
            expect(ids).toContain("test.greeter");
        } finally {
            dispose();
        }
    });

    it("keeps reachable services and warns about a broken service directory", async () => {
        const channel: CliChannel = {
            sendRequest: async (method) => {
                if (method === "hubrpc.directory::list") {
                    return {
                        items: [
                            {
                                serviceId: "healthy",
                                interfaceId: "hubrpc.directory",
                                interfaceHash: "healthy-directory",
                            },
                            {
                                serviceId: "broken",
                                interfaceId: "hubrpc.directory",
                                interfaceHash: "broken-directory",
                            },
                        ],
                    };
                }
                if (method === "healthy::hubrpc.directory::list") {
                    return {
                        items: [{
                            serviceId: "healthy",
                            interfaceId: "test.healthy",
                            interfaceHash: "healthy-interface",
                        }],
                    };
                }
                if (method === "broken::hubrpc.directory::list") {
                    throw new Error("Method not found: broken::hubrpc.directory::list");
                }
                if (method === "hubrpc.defaults::get") {
                    return {};
                }
                throw new Error(`Unexpected request: ${method}`);
            },
            sendNotification: async () => { },
            sendRequestWithStream: (method, params) => streamingCall(channel.sendRequest(method, params)),
            close: () => { },
        };
        const model = new UiModel(channel);
        try {
            const result = await waitFor(() => model.servicesPromise.promiseResult.get());

            expect(result.error).toBeUndefined();
            expect(result.data).toContainEqual(expect.objectContaining({
                serviceId: "healthy",
                interfaceId: "test.healthy",
            }));
            expect(model.discoveryWarnings.get()).toEqual([
                'Service "broken" does not offer a usable hubrpc.directory::list: '
                    + "Method not found: broken::hubrpc.directory::list",
            ]);
        } finally {
            model.dispose();
        }
    });

    it("keeps directory services when the root does not offer defaults", async () => {
        const channel: CliChannel = {
            sendRequest: async (method) => {
                if (method === "hubrpc.directory::list") {
                    return {
                        items: [{
                            serviceId: "healthy",
                            interfaceId: "test.healthy",
                            interfaceHash: "healthy-interface",
                        }],
                    };
                }
                if (method === "hubrpc.defaults::get") {
                    throw new Error("Method not found: hubrpc.defaults::get");
                }
                throw new Error(`Unexpected request: ${method}`);
            },
            sendNotification: async () => { },
            sendRequestWithStream: (method, params) => streamingCall(channel.sendRequest(method, params)),
            close: () => { },
        };
        const model = new UiModel(channel);
        try {
            const result = await waitFor(() => model.servicesPromise.promiseResult.get());

            expect(result.error).toBeUndefined();
            expect(result.data).toContainEqual(expect.objectContaining({
                serviceId: "healthy",
                interfaceId: "test.healthy",
            }));
            expect(model.discoveryWarnings.get()).toEqual([
                "The root service does not offer hubrpc.defaults::get: "
                    + "Method not found: hubrpc.defaults::get",
            ]);
        } finally {
            model.dispose();
        }
    });

    it("exposes the default interface without a directory service and calls it bare", async () => {
        const generatedSchema = greeter.toSchema();
        const hello = generatedSchema.methods.hello;
        const inlineParams = hello.params;
        const schema = {
            ...generatedSchema,
            methods: {
                ...generatedSchema.methods,
                hello: {
                    ...hello,
                    params: { $ref: "#/components/schemas/HelloParams" } as const,
                },
            },
            components: {
                schemas: {
                    ...generatedSchema.components?.schemas,
                    HelloParams: inlineParams,
                },
            },
        };
        const sentMethods: string[] = [];
        const channel: CliChannel = {
            sendRequest: async (method) => {
                if (method === "hubrpc.directory::list") return { items: [] };
                if (method === "hubrpc.defaults::get") {
                    return { interfaceId: schema.id, interfaceHash: schema.hash };
                }
                if (method === "hubrpc.schemas::get") return { schema };
                throw new Error(`Unexpected request: ${method}`);
            },
            sendNotification: async () => { },
            sendRequestWithStream: (method, params): RawStreamingCall => {
                if (method === "hubrpc.directory::list" || method === "hubrpc.schemas::get") {
                    return streamingCall(channel.sendRequest(method, params));
                }
                sentMethods.push(method);
                return streamingCall(Promise.resolve({ greeting: "Hi, default!" }));
            },
            close: () => { },
        };
        const model = new UiModel(channel);
        try {
            const services = (await waitFor(() => model.servicesPromise.promiseResult.get())).data!;
            expect(services).toEqual([expect.objectContaining({
                serviceId: "",
                interfaceId: schema.id,
                hash: schema.hash,
                isDefault: true,
            })]);

            model.select({
                serviceId: "",
                interfaceId: schema.id,
                methodName: "hello",
                isDefault: true,
            });
            await waitFor(() => model.currentSchemaState.get().kind === "loaded");
            expect(model.currentFields.get().map((field) => field.name)).toEqual(["name"]);
            model.setField("name", "default");
            model.submit();
            await waitFor(() => model.lastCall.get()?.promiseResult.get());

            expect(sentMethods).toEqual(["hello"]);
        } finally {
            model.dispose();
        }
    });

    it("loads the schema lazily when a method is selected", async () => {
        const { model, dispose } = makeModel();
        try {
            await waitFor(() => model.servicesPromise.promiseResult.get());
            // Initially: no selection, no schema state.
            expect(model.currentSchemaState.get()).toEqual({ kind: "none" });

            model.select({ serviceId: "", interfaceId: "test.greeter", methodName: "hello" });
            expect(model.currentSchemaState.get()).toEqual({ kind: "loading" });

            const loaded = await waitFor(() => {
                const s = model.currentSchemaState.get();
                return s.kind === "loaded" ? s : undefined;
            });
            expect(loaded.schema.id).toBe("test.greeter");
            expect(loaded.method?.name).toBe("hello");
        } finally {
            dispose();
        }
    });

    it("tracks an in-flight call via ObservablePromise (loading → result)", async () => {
        const { model, dispose } = makeModel();
        try {
            await waitFor(() => model.servicesPromise.promiseResult.get());
            model.select({ serviceId: "", interfaceId: "test.greeter", methodName: "hello" });
            await waitFor(() => {
                const s = model.currentSchemaState.get();
                return s.kind === "loaded" ? s : undefined;
            });

            model.setField("name", "alice");
            expect(model.lastCall.get()).toBeUndefined();

            model.submit();
            const inflight = model.lastCall.get();
            expect(inflight).toBeDefined();
            // Before the round-trip completes, promiseResult is undefined —
            // the view renders the "Calling…" branch off of this.
            expect(inflight!.promiseResult.get()).toBeUndefined();

            const settled = await waitFor(() => inflight!.promiseResult.get());
            expect(settled.error).toBeUndefined();
            expect(settled.data!.result).toEqual({ greeting: "Hi, alice!" });
            expect(settled.data!.latencyMs).toBeGreaterThanOrEqual(0);

            // History records the call once it settles.
            await waitFor(() => model.history.get().length > 0);
            expect(model.history.get()[0].result).toEqual({ greeting: "Hi, alice!" });
        } finally {
            dispose();
        }
    });

    it("streams server messages into streamChunks while the call is in flight", async () => {
        const { model, dispose } = makeModel();
        try {
            await waitFor(() => model.servicesPromise.promiseResult.get());
            model.select({ serviceId: "", interfaceId: "test.greeter", methodName: "count" });
            await waitFor(() => {
                const s = model.currentSchemaState.get();
                return s.kind === "loaded" && s.method ? s : undefined;
            });

            // The selected method advertises a server stream.
            expect(model.currentMethodStreams.get().server).toBe(true);

            model.setField("to", 3);
            expect(model.streamChunks.get()).toEqual([]);

            model.submit();
            const inflight = model.lastCall.get()!;
            const settled = await waitFor(() => inflight.promiseResult.get());
            expect(settled.error).toBeUndefined();
            expect(settled.data!.result).toEqual({ done: true });

            // All streamed chunks were captured, in order.
            expect(model.streamChunks.get()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
        } finally {
            dispose();
        }
    });

    it("resets streamChunks on a fresh submit", async () => {
        const { model, dispose } = makeModel();
        try {
            await waitFor(() => model.servicesPromise.promiseResult.get());
            model.select({ serviceId: "", interfaceId: "test.greeter", methodName: "count" });
            await waitFor(() => {
                const s = model.currentSchemaState.get();
                return s.kind === "loaded" && s.method ? s : undefined;
            });

            model.setField("to", 2);
            model.submit();
            await waitFor(() => model.lastCall.get()!.promiseResult.get());
            expect(model.streamChunks.get()).toEqual([{ n: 1 }, { n: 2 }]);

            // Second call starts from an empty buffer.
            model.setField("to", 1);
            model.submit();
            await waitFor(() =>
                model.streamChunks.get().length === 1 ? true : undefined,
            );
            expect(model.streamChunks.get()).toEqual([{ n: 1 }]);
        } finally {
            dispose();
        }
    });

    it("captures call errors in the ObservablePromise result", async () => {
        const { model, dispose } = makeModel();
        try {
            await waitFor(() => model.servicesPromise.promiseResult.get());
            model.select({ serviceId: "", interfaceId: "test.greeter", methodName: "hello" });
            await waitFor(() => {
                const s = model.currentSchemaState.get();
                return s.kind === "loaded" ? s : undefined;
            });
            // Submitting without a name produces a server-side invalidParams.
            model.submit();
            const inflight = model.lastCall.get()!;
            const settled = await waitFor(() => inflight.promiseResult.get());
            expect(settled.error).toBeDefined();

            // History records failures too.
            await waitFor(() => model.history.get().length > 0);
            expect(model.history.get()[0].error).toBeDefined();
        } finally {
            dispose();
        }
    });

    it("derives form fields and validation errors from the live schema", async () => {
        const { model, dispose } = makeModel();
        try {
            await waitFor(() => model.servicesPromise.promiseResult.get());
            model.select({ serviceId: "", interfaceId: "test.greeter", methodName: "hello" });
            await waitFor(() => {
                const s = model.currentSchemaState.get();
                return s.kind === "loaded" && s.method ? s : undefined;
            });

            const fields = model.currentFields.get();
            expect(fields.map((f) => f.name)).toEqual(["name"]);
            expect(fields[0].required).toBe(true);

            // Required-but-missing → error → cannot submit.
            expect(model.formErrors.get().get("name")).toBe("required");
            expect(model.canSubmit.get()).toBe(false);

            // Wrong type → schema mismatch error.
            model.setField("name", 42);
            expect(model.formErrors.get().get("name")).toBeDefined();
            expect(model.canSubmit.get()).toBe(false);

            // Valid value → no errors → can submit.
            model.setField("name", "alice");
            expect(model.formErrors.get().size).toBe(0);
            expect(model.canSubmit.get()).toBe(true);

            // Clearing with `undefined` drops the key (and re-triggers "required").
            model.setField("name", undefined);
            expect(model.formValues.get()).toEqual({});
            expect(model.formErrors.get().get("name")).toBe("required");
        } finally {
            dispose();
        }
    });

    it("selectMethod picks a concrete method on the current interface", async () => {
        const { model, dispose } = makeModel();
        try {
            await waitFor(() => model.servicesPromise.promiseResult.get());
            model.select({ serviceId: "", interfaceId: "test.greeter", methodName: undefined });
            await waitFor(() => {
                const s = model.currentSchemaState.get();
                return s.kind === "loaded" ? s : undefined;
            });
            expect(model.selection.get()?.methodName).toBeUndefined();
            expect(model.currentFields.get()).toEqual([]);

            model.selectMethod("hello");
            expect(model.selection.get()?.methodName).toBe("hello");
            expect(model.currentFields.get().length).toBe(1);
        } finally {
            dispose();
        }
    });

    it("moveServiceCursor drives column-0 navigation", async () => {
        const { model, dispose } = makeModel();
        try {
            const data = await waitFor(() => model.servicesPromise.promiseResult.get());
            // Sanity — the fixture exposes more than one (interface) row, since
            // reflection auto-registers hubrpc.defaults / .directory / .schemas.
            expect((data.data ?? []).length).toBeGreaterThan(1);

            model.moveServiceCursor(1); // -1 + 1 = 0 → first row
            const first = model.selection.get();
            expect(first?.interfaceId).toBe((data.data ?? [])[0].interfaceId);
            expect(first?.methodName).toBeUndefined();

            model.moveServiceCursor(1);
            const second = model.selection.get();
            expect(second?.interfaceId).toBe((data.data ?? [])[1].interfaceId);
        } finally {
            dispose();
        }
    });

    it("entering the methods column auto-picks the first method", async () => {
        const { model, dispose } = makeModel();
        try {
            await waitFor(() => model.servicesPromise.promiseResult.get());
            model.select({ serviceId: "", interfaceId: "test.greeter", methodName: undefined });
            await waitFor(() => {
                const s = model.currentSchemaState.get();
                return s.kind === "loaded" ? s : undefined;
            });
            expect(model.selection.get()?.methodName).toBeUndefined();

            model.focusColumn(1);
            // The autorun fires synchronously when the schema is already loaded.
            expect(model.selection.get()?.methodName).toBe("hello");
            expect(model.focusedColumn.get()).toBe(1);
        } finally {
            dispose();
        }
    });
});
