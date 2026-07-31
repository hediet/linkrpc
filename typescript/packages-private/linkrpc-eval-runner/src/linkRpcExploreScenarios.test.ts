import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSeededMemoryPrincipal, TransportPair } from "@hediet/linkrpc";
import { HubSigningSender } from "@hediet/linkrpc/hub/client";
import {
    createHubServiceInterfaces,
    Hub,
    registerHubServices,
    RootOverlay,
    withVerifiedSignature,
} from "@hediet/linkrpc-hub/hub/server";
import { LinkRpcMcpServer } from "@hediet/linkrpc-mcp";
import { describe, expect, it } from "vitest";
import { registerLinkRpcExploreCatalog } from "./linkRpcExploreScenarios";

describe("LinkRPC explore scenario catalog", () => {
    it("exposes a paged multi-service catalog with searchable operation descriptions", async () => {
        const hub = new Hub({ debugName: "eval-catalog-test" });
        const hubServices = createHubServiceInterfaces(hub);
        const disposeCatalog = registerLinkRpcExploreCatalog(hub);
        const principal = await createSeededMemoryPrincipal({ seed: 0 });
        const hubPair = new TransportPair();
        const upstream = hub.attach(hubPair.b);
        const overlay = new RootOverlay({ uplink: hubPair.a });
        registerHubServices(overlay.root, upstream, { hubServiceId: "hub" });
        const participantPair = new TransportPair();
        overlay.connectParticipant(withVerifiedSignature(
            participantPair.a,
            { verifySignatures: true },
        ));
        const server = new LinkRpcMcpServer({
            provider: async () => HubSigningSender.create(participantPair.b, principal),
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "eval-catalog-test", version: "0.0.1" });
        await client.connect(clientTransport);

        try {
            const browse = await runScript(
                client,
                `async ({ con }) => con.explore({ kind: "browse" })`,
            );
            expect(browse).toMatchObject({
                kind: "browse",
                total: 23,
                nextCursor: "20",
            });
            expect((browse as { entries: unknown[] }).entries).toHaveLength(20);

            const grep = await runScript(
                client,
                `async ({ con }) => con.explore({
                    kind: "grep",
                    pattern: "responsible for a dataset",
                    syntax: "literal",
                })`,
            );
            expect(grep).toMatchObject({
                kind: "grep",
                total: 1,
                entries: [{
                    serviceId: "data-platform",
                    interfaceId: "vscode.dataCatalog",
                }],
            });
        } finally {
            await client.close();
            server.dispose();
            overlay.dispose();
            upstream.dispose();
            hubPair.a.dispose();
            hubPair.b.dispose();
            participantPair.a.dispose();
            participantPair.b.dispose();
            disposeCatalog();
            hubServices.dispose();
        }
    });
});

async function runScript(client: Client, code: string): Promise<unknown> {
    const response = await client.callTool({
        name: "runLinkRpcScript",
        arguments: { code },
    }) as { content: { type: string; text: string }[] };
    const envelope = JSON.parse(response.content[0].text) as {
        status: string;
        result: unknown;
    };
    expect(envelope.status).toBe("completed");
    return envelope.result;
}
