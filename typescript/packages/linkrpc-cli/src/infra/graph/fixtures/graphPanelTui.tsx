import type { ViewOpenContext } from "../../../views/types";
import { runViewTui } from "../../../views/runViewTui";
import type { GraphTarget } from "../inspectGraph";
import { GraphLoader, GraphObjectCache } from "../inspectGraphModel";
import { GraphExplorerModel } from "../inspectGraphView";
import { GraphSession } from "../session";
import { render } from "ink";
import { z } from "zod";
import { defineInterface, LinkRpcConnection, TransportPair, type JsonValue } from "@hediet/linkrpc";
import { GraphObjects, GraphRoot, graphRefSchema } from "@hediet/linkrpc-infra/graph";
import { connectViaTransport } from "@hediet/linkrpc-client";
import { App } from "../../../ui/App";
import { UiModel } from "../../../ui/UiModel";
import { dispatchViewKey } from "../../../views/commands";

// Standalone terminal fixture: no endpoint or background watch is required.
const root = { kind: "workspace", id: "workspace-v1" };
const alpha = { kind: "session", id: "alpha-v1" };
const missing = { kind: "message", id: "message-v1" };
const cache = new GraphObjectCache();
cache.put([
    { ref: root, value: {
        title: "Agent workspace", sessions: [alpha], pending: missing,
        ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`metric${index}`, index])),
    } },
    { ref: alpha, value: { title: "CLI visual restoration", status: "running", workspace: root } },
]);
const loader = new GraphLoader(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    return { objects: [{ ref: missing, value: { text: "Loaded on demand" } }], missing: [], complete: true };
}, cache);
const target = {
    serviceId: "local", interfaceId: "demo.graph", root: "sessions",
    paramsArgument: { schema: { type: "object" } },
} as GraphTarget;
const session = new GraphSession({} as ViewOpenContext, [target]);
session.update({ active: true, model: new GraphExplorerModel(root, loader), version: 3, params: '{"list":"sessions"}' });
if (process.argv.includes("--integrated")) await integrated();
else await runViewTui(session);

async function integrated(): Promise<void> {
    const objects = GraphObjects({ ref: graphRefSchema, value: z.unknown() as z.ZodType<JsonValue> });
    const rootTemplate = GraphRoot({ params: z.object({}), ref: graphRefSchema });
    const definition = defineInterface({ id: "demo.graph" }, {
        fetch: objects.members.batchObjGet, watch: rootTemplate.members.watch,
    }, { templates: {
        objects: objects.mapMembers({ batchObjGet: "fetch" }),
        sessions: rootTemplate.mapMembers({ watch: "watch" }),
    } });
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.b);
    server.register(definition, {
        fetch: () => ({ objects: [cache.get(root)!, cache.get(alpha)!, { ref: missing, value: { text: "Loaded on demand" } }],
            missing: [], complete: true }),
        watch: async (_params, _context, stream) => {
            await stream.send({ version: 3, ref: root });
            await new Promise<void>(resolve => stream.signal.addEventListener("abort", () => resolve(), { once: true }));
            return {};
        },
    });
    server.enableReflection();
    const client = connectViaTransport(pair.a);
    const model = new UiModel(client.channel);
    const instance = render(<App model={model} />, { exitOnCtrlC: false });
    try {
        const listings = await model.servicesPromise.promise;
        const selected = listings.find(value => value.interfaceId === definition.info.id)!;
        model.selection.set({ ...selected, methodName: undefined }, undefined);
        model.focusColumn(1);
        model.views.tab.set("graph", undefined);
        while (!model.views.session.get()) await new Promise(resolve => setTimeout(resolve, 5));
        dispatchViewKey(model.views.session.get()!, { input: "", name: "return" });
        await instance.waitUntilExit();
    } finally {
        instance.unmount(); model.dispose();
        await model.views.waitForIdle();
        client.close(); server.close();
        session.dispose();
    }
}
