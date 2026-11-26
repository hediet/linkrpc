/**
 * Node.js language-server host over LinkRPC.
 *
 * Exposes `lsp.v1` for server discovery and `jsonRpcConnection` for transparent
 * Content-Length-framed LSP sessions, spawning one allow-listed process per
 * connection inside an allow-listed workspace root.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InterfaceRegistration, LinkRpcConnection } from '@hediet/linkrpc';
import { createContentLengthJsonRpcTransport } from '../json-rpc/contentLength';
import { registerJsonRpcConnectionService } from '../json-rpc/server';
import type { JsonRpcTransport } from '../json-rpc/transport';
import { lspConnectParamsSchema, lspInterface, type LanguageServerInfo } from './index';

const DEFAULT_MAX_SESSIONS = 8;
const KILL_GRACE_MS = 2_000;

export interface LanguageServerDefinition {
    readonly id: string;
    readonly command: readonly string[];
    readonly languages?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
}

export interface RegisterLanguageServerHostOptions {
    readonly connection: LinkRpcConnection<unknown>;
    readonly serviceId?: string;
    readonly servers: readonly LanguageServerDefinition[];
    readonly allowedRoots: readonly string[];
    readonly maxSessions?: number;
    readonly idleTimeoutMs?: number;
    readonly maxBodyBytes?: number;
    readonly onStderr?: (serverId: string, text: string) => void;
}

/**
 * Register a generic language-server host on a LinkRPC connection.
 * Exposes `lsp.v1` and `jsonRpcConnection` on `options.serviceId`.
 */
export function registerLanguageServerHost(
    options: RegisterLanguageServerHostOptions,
): InterfaceRegistration {
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
        throw new Error('maxSessions must be a positive safe integer');
    }
    if (options.idleTimeoutMs !== undefined && (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1)) {
        throw new Error('idleTimeoutMs must be a positive safe integer');
    }
    if (options.allowedRoots.length === 0) {
        throw new Error('allowedRoots must contain at least one directory');
    }

    const serverMap = new Map<string, LanguageServerDefinition>();
    const serverInfos: LanguageServerInfo[] = [];
    for (const server of options.servers) {
        if (!server.id) throw new Error('Language server definition must have a non-empty id');
        if (server.command.length === 0 || !server.command[0]) {
            throw new Error(`Language server "${server.id}" must have a non-empty command`);
        }
        if (serverMap.has(server.id)) {
            throw new Error(`Duplicate language server id "${server.id}"`);
        }
        serverMap.set(server.id, server);
        serverInfos.push({
            id: server.id,
            ...(server.languages ? { languages: [...server.languages] } : {}),
        });
    }

    let activeSessions = 0;

    const lspRegistration = options.connection.register(
        lspInterface,
        {
            listServers: async () => ({ servers: serverInfos }),
        },
        options.serviceId === undefined ? {} : { serviceId: options.serviceId },
    );

    const jsonRpcRegistration = registerJsonRpcConnectionService({
        connection: options.connection,
        serviceId: options.serviceId,
        openTransport: async (rawParams, signal): Promise<JsonRpcTransport> => {
            signal.throwIfAborted();
            const parsed = lspConnectParamsSchema.safeParse(rawParams);
            if (!parsed.success) {
                throw new Error(`Invalid LSP connect params: ${parsed.error.message}`);
            }
            const { server: serverId, rootUri } = parsed.data;
            const definition = serverMap.get(serverId);
            if (!definition) {
                throw new Error(`Unknown language server "${serverId}"`);
            }
            const resolvedRoot = await resolveAllowedRoot(rootUri, options.allowedRoots);
            signal.throwIfAborted();

            if (activeSessions >= maxSessions) {
                throw new Error(`Language server session limit reached (${maxSessions})`);
            }
            activeSessions += 1;

            let child: ChildProcess;
            try {
                child = spawn(definition.command[0], [...definition.command.slice(1)], {
                    cwd: resolvedRoot,
                    env: definition.env ? { ...process.env, ...definition.env } : process.env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: process.platform !== 'win32',
                    windowsHide: true,
                });
            } catch (error) {
                activeSessions -= 1;
                throw error;
            }

            if (!child.stdin || !child.stdout || !child.stderr) {
                activeSessions -= 1;
                terminateProcessTree(child);
                throw new Error(`Language server "${serverId}" did not open stdio pipes`);
            }

            // Always drain stderr so the child never blocks on a full pipe.
            child.stderr.on('data', (chunk: Buffer | string) => {
                options.onStderr?.(serverId, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
            });

            const inner = createContentLengthJsonRpcTransport({
                input: child.stdout,
                output: child.stdin,
                maxBodyBytes: options.maxBodyBytes,
            });

            let cleanedUp = false;
            let idleTimer: ReturnType<typeof setTimeout> | undefined;

            const cleanup = (): void => {
                if (cleanedUp) return;
                cleanedUp = true;
                activeSessions -= 1;
                if (idleTimer !== undefined) {
                    clearTimeout(idleTimer);
                    idleTimer = undefined;
                }
                terminateProcessTree(child);
            };

            const touchIdle = (): void => {
                if (options.idleTimeoutMs === undefined || cleanedUp) return;
                if (idleTimer !== undefined) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    inner.close('idleTimeout');
                }, options.idleTimeoutMs);
                idleTimer.unref?.();
            };

            child.on('error', (error) => {
                inner.close(`spawnError: ${error.message}`);
            });
            child.on('exit', (code, exitSignal) => {
                inner.close(`processExited(${code ?? exitSignal ?? 'unknown'})`);
            });
            inner.onClose(() => cleanup());
            touchIdle();

            return {
                get closed(): boolean {
                    return inner.closed;
                },
                send(frame) {
                    touchIdle();
                    return inner.send(frame);
                },
                onMessage(listener) {
                    return inner.onMessage((frame) => {
                        touchIdle();
                        listener(frame);
                    });
                },
                onClose(listener) {
                    return inner.onClose(listener);
                },
                close(reason) {
                    inner.close(reason);
                    cleanup();
                },
            };
        },
    });

    return {
        dispose(): void {
            lspRegistration.dispose();
            jsonRpcRegistration.dispose();
        },
    };
}

async function resolveAllowedRoot(
    rootUri: string,
    allowedRoots: readonly string[],
): Promise<string> {
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(rootUri);
    } catch {
        throw new Error(`Invalid rootUri "${rootUri}": must be a valid file:// URI`);
    }
    if (parsedUrl.protocol !== 'file:') {
        throw new Error(`Invalid rootUri "${rootUri}": only file:// URIs are allowed`);
    }
    const rawPath = fileURLToPath(parsedUrl);
    const resolvedRoot = await realpath(rawPath);
    const rootStat = await stat(resolvedRoot);
    if (!rootStat.isDirectory()) {
        throw new Error(`rootUri "${rootUri}" is not a directory`);
    }

    for (const candidate of allowedRoots) {
        let resolvedAllowed: string;
        try {
            resolvedAllowed = await realpath(candidate);
        } catch {
            continue;
        }
        if (isPathInside(resolvedAllowed, resolvedRoot)) {
            return resolvedRoot;
        }
    }
    throw new Error(`rootUri "${rootUri}" is outside allowed roots`);
}

function isPathInside(parent: string, target: string): boolean {
    const normalizedParent = process.platform === 'win32' ? parent.toLowerCase() : parent;
    const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
    const rel = path.relative(normalizedParent, normalizedTarget);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function terminateProcessTree(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform !== 'win32') {
        try {
            process.kill(-pid, 'SIGTERM');
        } catch {
            child.kill('SIGTERM');
        }
        const timer = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                child.kill('SIGKILL');
            }
        }, KILL_GRACE_MS);
        timer.unref?.();
        return;
    }
    child.kill();
}
