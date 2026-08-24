/* eslint-disable no-console */
/**
 * Smoke test: spin up an in-process hubv2 Hub + SocketServer, then exercise
 * the BUILT sandbox (`dist/`) and the MCP-server-shaped host API end to end.
 * Exercises the real `?esm`-bundled guest runtime, so build first:
 *
 *     pnpm build && node --experimental-strip-types scripts/smoke.ts
 */
import { InMemoryManagedIdentity, type ManagedIdentity } from "@hediet/linkrpc";
import { Hub, HubConnectionAcceptor, createHubServiceInterfaces } from "@hediet/linkrpc-hub/hub/server";
import { SocketServer } from "@hediet/linkrpc-hub/hub/server/node";
import { Ed25519CryptoProvider, formatEndpointUri } from "@hediet/linkrpc/node";
import { ConnectionPool, runSandboxed, explore, type SandboxHostApi } from "../dist/index.js";
import { summarizeGrants } from "../src/grants";

async function main(): Promise<void> {
    const crypto = new Ed25519CryptoProvider();
    const hub = new Hub();
    const hubServiceId = "hub";
    createHubServiceInterfaces(hub, { hubServiceId });
    const socketServer = await SocketServer.start();
    const acceptor = new HubConnectionAcceptor({
        server: socketServer,
        hub,
        hubServiceId,
        resolveIdentity: (): Promise<ManagedIdentity> => InMemoryManagedIdentity.generate(crypto),
    });
    const endpoint = socketServer.endpoint;
    // hubv2 authenticates by provenance; the client still sends an
    // `linkrpc::initialize` token, which this server accepts and ignores.
    const token = "smoke";
    console.log(`[smoke] hub listening on ${endpoint}`);

    const pool = new ConnectionPool();
    let exitCode = 0;
    try {
        const connectionUri = formatEndpointUri(
            { kind: "socket", path: endpoint, token },
            { revealToken: true },
        );
        const pooled = await pool.resolve(connectionUri);
        const host: SandboxHostApi = {
            call: async (method, paramsJson) => {
                const params = paramsJson === "" ? {} : JSON.parse(paramsJson);
                const r = await pooled.channel.sendRequest(method, params);
                return JSON.stringify(r ?? null);
            },
            notify: async (method, paramsJson) => {
                const params = paramsJson === "" ? {} : JSON.parse(paramsJson);
                await pooled.channel.sendNotification(method, params);
                return "";
            },
            explore: async (argsJson) => {
                const args = argsJson === "" ? {} : JSON.parse(argsJson);
                return JSON.stringify(await explore(pooled.channel, args));
            },
            requestAccess: async (argsJson) => {
                const args = argsJson === "" ? {} : JSON.parse(argsJson);
                const result = await pooled.session.requestAccess({
                    consumer: { name: "linkrpc-mcp", purpose: args.purpose },
                    permissions: args.permissions ?? [],
                    duration: args.duration,
                });
                return JSON.stringify(result);
            },
            grants: async () => JSON.stringify(summarizeGrants(pooled.session.listGrants())),
        };

        // 1. Pure JS, no host calls.
        console.log("[smoke] 1 — arithmetic");
        const r1 = await runSandboxed("({ }) => 1 + 2", host, undefined);
        console.log("   ->", r1.resultJson);

        // 2. Call hubDirectory::listPrefixes (form 2, addresses the hub itself).
        console.log("[smoke] 2 — con.call hubDirectory::listPrefixes");
        const r2 = await runSandboxed(
            `({ con }) => con.call("", "hubDirectory", "listPrefixes")`,
            host,
            undefined,
        );
        console.log("   ->", r2.resultJson);

        // 3. con.explore() — walks the bus.
        console.log("[smoke] 3 — con.explore()");
        const r3 = await runSandboxed(`({ con }) => con.explore()`, host, undefined);
        console.log("   ->", r3.resultJson);

        // 4. con.explore with includeSchema for a known root interface.
        console.log("[smoke] 4 — con.explore({ interfaceId: 'linkrpc.directory', includeSchema: true, maxResults: 3 })");
        const r4 = await runSandboxed(
            `({ con }) => con.explore({ interfaceId: 'linkrpc.directory', includeSchema: true, maxResults: 3 })`,
            host,
            undefined,
        );
        console.log("   ->", r4.resultJson);

        // 5. lastResultVal threading.
        console.log("[smoke] 5 — lastResultVal");
        const r5a = await runSandboxed("({ }) => ({ tick: 41 })", host, undefined);
        const r5b = await runSandboxed(
            "({ lastResultVal }) => ({ next: lastResultVal.tick + 1 })",
            host,
            JSON.parse(r5a.resultJson),
        );
        console.log("   ->", r5b.resultJson);

        // 6. Logs from console.log are captured.
        console.log("[smoke] 6 — console logs");
        const r6 = await runSandboxed(
            `({ }) => { console.log("hello", { a: 1 }); console.warn("be careful"); return "done"; }`,
            host,
            undefined,
        );
        console.log("   logs:", r6.logs, "result:", r6.resultJson);

        // 7. Error inside user code surfaces.
        console.log("[smoke] 7 — thrown error");
        try {
            await runSandboxed(`({ }) => { throw new Error("boom"); }`, host, undefined);
            console.error("   !! expected an error");
            exitCode = 1;
        } catch (e) {
            console.log("   caught:", (e as Error).message);
        }

        // 8. Timeout enforcement (very small budget).
        console.log("[smoke] 8 — timeout");
        try {
            await runSandboxed(
                `({ }) => { while (true) {} }`,
                host,
                undefined,
                { timeoutMs: 200 },
            );
            console.error("   !! expected a timeout");
            exitCode = 1;
        } catch (e) {
            console.log("   caught:", (e as Error).message);
        }
    } finally {
        pool.dispose();
        acceptor.dispose();
    }
    setTimeout(() => process.exit(exitCode), 200).unref();
}

main().catch((err: unknown) => {
    console.error("[smoke] FAILED:", (err as Error).message);
    console.error((err as Error).stack);
    process.exit(1);
});
