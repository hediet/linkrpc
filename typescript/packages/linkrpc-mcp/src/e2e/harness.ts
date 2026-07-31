import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
    createSeededMemoryPrincipal,
    createSeededSigningIdentity,
    defineInterface,
    type IMessageTransport,
    requestType,
    TransportPair,
} from "@hediet/linkrpc";
import { z } from "zod";
import { HubSigningSender } from "@hediet/linkrpc/hub/client";
import { createHubAccessConfig, HubAccessGrantSigner } from "@hediet/linkrpc-hub";
import {
    Hub,
    hubRegisterServiceId,
    createHubServiceInterfaces,
    registerHubAccessService,
    registerHubServices,
    registerIdentityServices,
    RootOverlay,
    withForwardedCallGate,
    withVerifiedSignature,
} from "@hediet/linkrpc-hub/hub/server";
import {
    LinkRpcMcpServer,
    type LinkRpcMcpServerOptions,
} from "../server";

/** Registers a cleanup callback to run when the current test finishes. */
export type OnTestFinished = (fn: () => void | Promise<void>) => void;

export interface TestDisposableStore {
    /** Register a disposer; runs at test teardown (LIFO). Async disposers are not awaited. */
    add(dispose: () => void | Promise<void>): void;
}

/**
 * Collect disposables and tear them down (LIFO) when the test finishes. Async
 * disposers are fired without awaiting — teardown is best-effort, so a slow
 * `client.close()` never blocks the next test.
 */
export function createTestDisposableStore(onTestFinished: OnTestFinished): TestDisposableStore {
    const disposers: Array<() => void | Promise<void>> = [];
    onTestFinished(() => {
        for (let i = disposers.length - 1; i >= 0; i--) {
            void disposers[i]();
        }
    });
    return { add: (dispose) => disposers.push(dispose) };
}

/** A trivial hub service the e2e suites exercise end-to-end through the MCP tool. */
export const greeterInterface = defineInterface(
    { id: "greeter", description: "Greets by name." },
    {
        hello: requestType(
            z.object({ name: z.string() }),
            z.object({ greeting: z.string() }),
        ),
    },
);

/** The greeter implementation shared by every harness. */
const greeterImpl = {
    hello: ({ name }: { name: string }) => ({ greeting: `Hello, ${name}!` }),
};

/** Extract the first text block of an MCP tool result. */
export function getResultText(res: unknown): string {
    return (res as { content: { type: string; text: string }[] }).content[0].text;
}

/** Parse the first text block of an MCP tool result as JSON. */
export function parseResult(res: unknown): any {
    return JSON.parse(getResultText(res));
}

/**
 * The tool result exactly as the LLM receives it — the MCP `content` blocks plus
 * the `isError` flag — but with each JSON text block parsed back into an object
 * so inline snapshots stay readable instead of one giant escaped string. Text
 * blocks that aren't JSON (e.g. plain error messages) are kept verbatim.
 */
export function llmResult(res: unknown): unknown {
    const r = res as { isError?: boolean; content: { type: string; text: string }[] };
    const content = r.content.map((c) => {
        if (c.type !== "text") return c;
        try {
            return { type: "text", json: JSON.parse(c.text) };
        } catch {
            return { type: "text", text: c.text };
        }
    });
    return r.isError ? { content, isError: true } : { content };
}

/** Connect an MCP {@link Client} to `server` over an in-memory transport pair. */
async function connectClient(
    server: LinkRpcMcpServer,
    name: string,
    d: TestDisposableStore,
): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name, version: "0.0.0" });
    await client.connect(clientTransport);

    d.add(() => {
        void client.close();
        server.dispose();
    });
    return client;
}

/**
 * Real in-memory hub serving `hello::greeter::hello`, fronted by a real
 * `LinkRpcMcpServer` whose connection is a consumer-provided `HubSigningSender`
 * (seed-0 identity) attached straight to the hub. No sockets, no env, no gate —
 * every call is admitted.
 */
export async function makeUngatedHarness(d: TestDisposableStore): Promise<Client> {
    const hub = new Hub();
    createHubServiceInterfaces(hub);
    const svc = hubRegisterServiceId(hub, "hello");
    d.add(() => svc.dispose());
    svc.connection.register(greeterInterface, greeterImpl, { serviceId: "hello" });

    const principal = await createSeededMemoryPrincipal({ seed: 0 });
    const server = new LinkRpcMcpServer({
        provider: async () => HubSigningSender.create(hub.attachOut().transport, principal),
    });
    return connectClient(server, "e2e-ungated-client", d);
}

export interface GatedHub {
    /**
     * Attach a fresh **capability-mode gated** client transport — the same
     * wiring the socket acceptor / extension `attachParticipant` install: a
     * forwarded-call gate requiring an admin-rooted capability, plus the consent
     * front door (`hubAccess::*`) served at the connection root (never forwarded
     * → never gated). No prefix is exempt, so even the `hello::greeter::hello`
     * call must present a cap rooted at the admin issuer.
     */
    attachClient(): IMessageTransport;
    /**
     * Like {@link attachClient}, but the participant leg also serves
     * `identity::*` off a fixed seeded identity — exactly what the extension's
     * `attachParticipant({ resolveIdentity, identityStorage })` does. This lets
     * a consumer dialing in over the transport build a *managed* principal
     * (signing delegated to this leg's `identity::sign`), the trust model the
     * in-process default MCP connection uses.
     */
    attachManagedClient(): IMessageTransport;
}

/**
 * Stand up a gated hub serving `hello::greeter::hello`, with the real
 * `hubAccess` consent front door installed at each participant's overlay root
 * (auto-approving). The hub owns its own deterministic admin `issuer`: it roots
 * the forwarded-call gate and signs the greeter caps minted by consent.
 */
export async function makeGatedHub(d: TestDisposableStore): Promise<GatedHub> {
    const issuer = await createSeededSigningIdentity({ seed: 1 });
    const hub = new Hub();
    createHubServiceInterfaces(hub);
    const svc = hubRegisterServiceId(hub, "hello");
    d.add(() => svc.dispose());
    svc.connection.register(greeterInterface, greeterImpl, { serviceId: "hello" });

    // The consent surface: a standalone in-process signer holding the hub admin
    // identity, auto-granting every request. `createHubAccessConfig` adapts it
    // onto the hubAccess front door. (The distributed, keyless path uses
    // `HubAccessManifestHost` + a remote approver instead.)
    const signer = new HubAccessGrantSigner(issuer, () => ({ result: "permitted" }));
    const hubAccess = createHubAccessConfig(signer.decide);

    const attachClient = (serveIdentity = false): IMessageTransport => {
        const hubPair = new TransportPair();
        const hubFacing = withForwardedCallGate(hubPair.b, {
            requireCapability: true,
            acceptedRootIssuers: () => [
                { principal: issuer.publicSigningIdentity.principal, isPublic: true },
            ],
        });
        const upstream = hub.attach(hubFacing);
        const overlay = new RootOverlay({ uplink: hubPair.a });
        registerHubServices(overlay.root, upstream, { hubServiceId: "hub" });
        registerHubAccessService(overlay.root, hubAccess);
        if (serveIdentity) {
            // Serve `identity::*` off a fixed seeded identity so a consumer can
            // build a managed principal whose signing is delegated here.
            registerIdentityServices(overlay.root, {
                resolveIdentity: async () =>
                    (await createSeededMemoryPrincipal({ seed: 2 })).identity,
            });
        }
        const appPair = new TransportPair();
        overlay.connectParticipant(
            withVerifiedSignature(appPair.a, { verifySignatures: true }),
        );
        return appPair.b;
    };

    return {
        attachClient: () => attachClient(false),
        attachManagedClient: () => attachClient(true),
    };
}

/**
 * Wire a `LinkRpcMcpServer` whose provider attaches a **gated** link to the hub,
 * signing as a fresh deterministic consumer principal. The consent front door
 * (`hubAccess::*`) is served at the connection root (never forwarded → never
 * gated), so no bootstrap cap is needed to reach it; the greeter cap is
 * negotiated by the tool script through `con.requestAccess(...)`. Teardown is
 * registered on the running test, so there is no shared mutable state between
 * cases.
 */
export async function makeGatedHarness(
    gated: GatedHub,
    d: TestDisposableStore,
    observers: Pick<LinkRpcMcpServerOptions, "onExploreCall" | "onToolCall"> = {},
): Promise<Client> {
    const principal = await createSeededMemoryPrincipal({ seed: 0 });
    const server = new LinkRpcMcpServer({
        provider: async () => HubSigningSender.create(gated.attachClient(), principal),
        ...observers,
    });
    return connectClient(server, "e2e-gated-client", d);
}

/**
 * Wire a `LinkRpcMcpServer` whose **default connection** (no `connection` arg) is
 * an in-process transport into the gated hub — the path the VS Code extension
 * uses. The server builds a *managed* principal over that leg (signing delegated
 * to the hub-served `identity::*`) and reaches the root-served `hubAccess`
 * front door, all via the normal `ConnectionPool` + `setupSigning`. No socket,
 * port, or token.
 */
export async function makeManagedDefaultHarness(gated: GatedHub, d: TestDisposableStore): Promise<Client> {
    const server = new LinkRpcMcpServer({
        defaultConnection: () => ({ transport: gated.attachManagedClient() }),
    });
    return connectClient(server, "e2e-managed-default-client", d);
}
