import { LinkRpcConnection, TransportPair } from "@hediet/linkrpc";
import { topologyInterface } from "@hediet/linkrpc/inspection";
import { connectViaTransport } from "@hediet/linkrpc-client";
import { render } from "ink";
import { TopologySession } from "../session";
import { resolveTopologyTarget } from "../model";
import { interfaceTarget, type ViewOpenContext } from "../../../views/types";
import { runViewTui } from "../../../views/runViewTui";
import { App } from "../../../ui/App";
import { UiModel } from "../../../ui/UiModel";
import { sampleTopology } from "./sampleGraph";

const pair = new TransportPair();
const server = LinkRpcConnection.fromTransport(pair.b);
server.service("demo").register(topologyInterface, {
    getGraph: () => sampleTopology,
    watchGraph: async (_params, _context, stream) => {
        await new Promise<void>(resolve => stream.signal.addEventListener("abort", () => resolve(), { once: true }));
        return {};
    },
});
server.enableReflection();
const client = connectViaTransport(pair.a);
try {
    if (process.argv.includes("--integrated")) {
        const model = new UiModel(client.channel);
        const instance = render(<App model={model} />, { exitOnCtrlC: false });
        try {
            const listings = await model.servicesPromise.promise;
            const listing = listings.find(value => value.serviceId === "demo" && value.interfaceId === topologyInterface.info.id)!;
            model.selection.set({ ...listing, methodName: undefined }, undefined);
            model.focusColumn(1);
            model.views.tab.set("topology", undefined);
            await instance.waitUntilExit();
        } finally {
            instance.unmount(); model.dispose(); await model.views.waitForIdle();
        }
    } else {
        const listing = { serviceId: "demo", interfaceId: topologyInterface.info.id, discoveredFrom: "demo",
            schema: topologyInterface.toSchema() };
        const context: ViewOpenContext = { channel: client.channel, target: interfaceTarget(listing), interfaces: [listing] };
        await runViewTui(new TopologySession(context, resolveTopologyTarget(context), 1000));
    }
} finally { client.close(); server.close(); }
