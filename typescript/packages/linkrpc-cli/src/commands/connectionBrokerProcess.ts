import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
    formatEndpointUri,
    traceMessageTransport,
    type ResolvedEndpoint,
} from "@hediet/linkrpc/node";
import { SocketServer } from "@hediet/linkrpc-hub/hub/server/node";
import {
    connect,
    connectViaTransport,
} from "@hediet/linkrpc-client";
import type { StaticHubSchema } from "../staticHubSchema";
import { ConnectionBroker, type BrokerStopReason } from "./connectionBroker";

export interface RunConnectionBrokerOptions {
    readonly remote: ResolvedEndpoint;
    readonly timeoutMs: number;
    readonly ttlMs: number;
    readonly notificationLimit?: number;
    readonly staticHubSchema?: StaticHubSchema;
}

export interface RunningConnectionBroker {
    readonly endpoint: string;
    readonly stopped: Promise<BrokerStopReason>;
    dispose(): void;
}

export async function runConnectionBroker(
    options: RunConnectionBrokerOptions,
): Promise<RunningConnectionBroker> {
    const startedAt = Date.now();
    let broker: ConnectionBroker | undefined;
    const remote = await connect(options.remote, {
        trace: () => broker?.recordActivity(),
    });
    const token = randomUUID();
    const server = await SocketServer.start({
        isTokenAccepted: async (candidate) => candidate === token,
    });
    const mode = options.remote.kind === "ws-no-init" ? "raw" : "linkrpc";

    try {
        broker = new ConnectionBroker(remote, {
            id: randomUUID(),
            remoteEndpoint: formatRemoteEndpointForStatus(options.remote),
            mode,
            startedAt,
            timeoutMs: options.timeoutMs,
            ttlMs: options.ttlMs,
            ...(options.notificationLimit === undefined
                ? {}
                : { notificationLimit: options.notificationLimit }),
            ...(options.staticHubSchema === undefined
                ? {}
                : { staticHubSchema: options.staticHubSchema }),
            onStop: () => server.dispose(),
        });
        server.setConnectionHandler((transport) => {
            broker!.recordActivity();
            const traced = traceMessageTransport(transport, () => broker!.recordActivity());
            const local = connectViaTransport(traced);
            try {
                broker!.attach(local);
            } catch {
                local.close();
                return;
            }

            transport.onDidClose(() => broker!.detach(local));
        });
    } catch (error) {
        server.dispose();
        remote.close();
        throw error;
    }

    const endpoint = formatEndpointUri({
        kind: "socket",
        path: server.endpoint,
        token,
        brokerMode: mode,
    }, { revealToken: true });
    return {
        endpoint,
        stopped: broker.stopped,
        dispose: () => broker!.dispose(),
    };
}

function formatRemoteEndpointForStatus(endpoint: ResolvedEndpoint): string {
    if (endpoint.kind === "ws-no-init") {
        const url = new URL(endpoint.url);
        for (const key of [...url.searchParams.keys()]) {
            url.searchParams.set(key, "***");
        }
        return url.toString().replace(/^ws:/i, "ws-no-init:");
    }
    if (endpoint.kind === "cmd-env" || endpoint.kind === "cmd-stdio") {
        return `${endpoint.kind}:<redacted>`;
    }
    return formatEndpointUri(endpoint);
}

export interface SpawnConnectionBrokerOptions {
    readonly remote: ResolvedEndpoint;
    readonly timeoutMs: number;
    readonly ttlMs: number;
    readonly notificationLimit?: number;
    readonly readyTimeoutMs?: number;
    readonly schemaSource?: string;
}

export async function spawnConnectionBroker(
    options: SpawnConnectionBrokerOptions,
): Promise<string> {
    const cliPath = process.argv[1];
    if (cliPath === undefined) {
        throw new Error("cannot locate the linkrpc CLI entry point");
    }
    const args = [
        ...process.execArgv,
        cliPath,
        "_connection-broker",
        "--remote-endpoint",
        formatEndpointUri(options.remote, { revealToken: true }),
        "--timeout-ms",
        String(options.timeoutMs),
        "--ttl-ms",
        String(options.ttlMs),
    ];
    if (options.notificationLimit !== undefined) {
        args.push("--notification-limit", String(options.notificationLimit));
    }
    if (options.schemaSource !== undefined) {
        args.push("--schema", options.schemaSource);
    }

    const child = spawn(process.execPath, args, {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
    });
    const stdout = child.stdout;
    if (stdout === null) {
        child.kill();
        throw new Error("connection broker child exposes no stdout");
    }

    try {
        const endpoint = await readReadyEndpoint(
            child,
            stdout,
            options.readyTimeoutMs ?? 15_000,
        );
        stdout.destroy();
        child.unref();
        return endpoint;
    } catch (error) {
        child.kill();
        throw error;
    }
}

function readReadyEndpoint(
    child: ReturnType<typeof spawn>,
    stdout: NodeJS.ReadableStream,
    timeoutMs: number,
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("connection broker did not become ready before the timeout"));
        }, timeoutMs);
        const onData = (chunk: Buffer | string) => {
            buffer += chunk.toString();
            const newline = buffer.indexOf("\n");
            if (newline < 0) return;
            const endpoint = buffer.slice(0, newline).trim();
            cleanup();
            try {
                const parsed = new URL(endpoint);
                if (parsed.protocol !== "unix:" && parsed.protocol !== "npipe:") {
                    throw new Error(`unexpected broker endpoint '${endpoint}'`);
                }
                resolve(endpoint);
            } catch (error) {
                reject(error);
            }
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onExit = (code: number | null) => {
            cleanup();
            reject(new Error(`connection broker exited before becoming ready (code ${code ?? "unknown"})`));
        };
        const cleanup = () => {
            clearTimeout(timer);
            stdout.removeListener("data", onData);
            child.removeListener("error", onError);
            child.removeListener("exit", onExit);
        };
        stdout.on("data", onData);
        child.once("error", onError);
        child.once("exit", onExit);
    });
}
