import { describe, expect, it } from "vitest";
import { SocketServer } from "@hediet/linkrpc-hub/hub/server/node";
import { connect } from "./connect";

function settles(promise: Promise<void>, ms = 5_000): Promise<"closed" | "pending"> {
    return Promise.race([
        promise.then(() => "closed" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
    ]);
}

describe("CliConnection.closed", () => {
    it("resolves when a cmd-stdio child exits", async () => {
        const connection = await connect({
            kind: "cmd-stdio",
            command: { argv: [process.execPath, "-e", "setTimeout(() => {}, 200)"] },
        });
        try {
            expect(await settles(connection.closed)).toBe("closed");
        } finally {
            connection.close();
        }
    }, 10_000);

    it("resolves when the socket peer closes the connection", async () => {
        const server = await SocketServer.start();
        server.setConnectionHandler((peer) => setTimeout(() => peer.dispose(), 100));
        try {
            const connection = await connect({ kind: "socket", path: server.endpoint, token: undefined });
            try {
                expect(await settles(connection.closed)).toBe("closed");
            } finally {
                connection.close();
            }
        } finally {
            server.dispose();
        }
    }, 10_000);

    it("resolves on close() and stays pending while the peer is alive", async () => {
        const server = await SocketServer.start();
        try {
            const connection = await connect({ kind: "socket", path: server.endpoint, token: undefined });
            expect(await settles(connection.closed, 300)).toBe("pending");
            connection.close();
            expect(await settles(connection.closed)).toBe("closed");
        } finally {
            server.dispose();
        }
    }, 10_000);
});
