import { type IMessageTransport, type JsonValue } from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface, type NodeInfo } from '@hediet/linkrpc/hub/common';
import {
    connectNdjson,
    openWebSocket,
    parseEndpointUri,
    runInitializeHandshake,
    WebSocketTransport,
} from '@hediet/linkrpc/node';
import * as net from 'node:net';
import type { ParticipantConnectorConfig } from '../config';
import { spawnCommand } from '../spawn';
import { endpointCommand, forwardStdin, killChild, pipeChildLogs } from './cmdEndpoint';
import { RouteTable } from './routeTable';

const REGISTER_METHOD = `${hubGrantedServiceIdInterface.info.id}::register`;
const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 5_000;

export interface ConfiguredParticipant {
    readonly name: string;
    readonly config: ParticipantConnectorConfig;
}

export interface ConfigureParticipantsOptions {
    readonly participants: readonly ConfiguredParticipant[];
    /**
     * Attach a connected transport at the host's trust boundary. Standalone
     * hubs attach directly; embedded hosts can insert their capability gate.
     */
    readonly attachParticipant: (
        transport: IMessageTransport,
    ) => ConfiguredParticipantAttachment;
    readonly log?: (line: string) => void;
    /** Forward stdin to the single cmd-stdio participant. */
    readonly cmdInteractive?: boolean;
}

export interface ConfiguredParticipants {
    dispose(): void;
}

export interface ConfiguredParticipantAttachment {
    claimPrefix(prefix: string): void;
    setDefaultRoute(): void;
    identifyPeer(): Promise<NodeInfo>;
    request(method: string, params: JsonValue, timeoutMs?: number): Promise<JsonValue | undefined>;
    dispose(): void;
}

/**
 * Attach settings/config-defined outbound participants to an existing Hub.
 *
 * Each participant is supervised independently: it connects in the background,
 * claims its configured service ids on the far end, installs its local routes,
 * and reconnects with exponential backoff after a disconnect.
 */
export function configureParticipants(
    options: ConfigureParticipantsOptions,
): ConfiguredParticipants {
    const log = options.log ?? ((line: string) => process.stderr.write(line + '\n'));
    const disposers: Array<() => void> = [];
    const interactiveCommands = options.participants.filter(
        participant => participant.config.kind === 'cmd-stdio',
    ).length;
    if (options.cmdInteractive && interactiveCommands !== 1) {
        throw new Error(
            `cmdInteractive requires exactly one cmd-stdio participant, found ${interactiveCommands}`,
        );
    }

    validateConfiguredParticipants(options.participants);
    for (const participant of options.participants) {
        disposers.push(_startParticipant(
            participant,
            options.attachParticipant,
            log,
            options.cmdInteractive === true,
        ));
    }

    let disposed = false;
    return {
        dispose: () => {
            if (disposed) return;
            disposed = true;
            for (const dispose of disposers.reverse()) dispose();
        },
    };
}

export function validateConfiguredParticipants(
    participants: readonly ConfiguredParticipant[],
): void {
    const routes = new RouteTable();
    for (const participant of participants) {
        _validateParticipant(participant, routes);
    }
}

function _validateParticipant(
    participant: ConfiguredParticipant,
    routes: RouteTable,
): void {
    const { config, name } = participant;
    if (config.connectionTokenBinder !== undefined) {
        throw new Error(
            `participant '${name}': connectionTokenBinder is only supported on cmd-env endpoints`,
        );
    }
    for (const serviceId of config.routeServiceIds) routes.claim(serviceId, name);
    if (config.defaultRoute) routes.setDefault(name);
}

function _startParticipant(
    participant: ConfiguredParticipant,
    attachParticipant: ConfigureParticipantsOptions['attachParticipant'],
    log: (line: string) => void,
    interactive: boolean,
): () => void {
    const { config, name } = participant;
    const abort = new AbortController();
    let current: ConnectedParticipant | undefined;
    let connectingAttachment: ConfiguredParticipantAttachment | undefined;
    let stopped = false;

    const dispose = (): void => {
        if (stopped) return;
        stopped = true;
        abort.abort();
        connectingAttachment?.dispose();
        connectingAttachment = undefined;
        current?.attachment.dispose();
        current?.transport.dispose();
        current = undefined;
    };

    void (async () => {
        let backoff = INITIAL_BACKOFF_MS;
        let delayBeforeAttempt = 0;
        let hasConnected = false;
        while (!stopped) {
            if (
                delayBeforeAttempt > 0
                && !await _delayUnlessAborted(delayBeforeAttempt, abort.signal)
            ) {
                return;
            }
            try {
                const connected = await _connectParticipant(
                    participant,
                    attachParticipant,
                    log,
                    interactive,
                    abort.signal,
                    attachment => { connectingAttachment = attachment; },
                );
                if (stopped) {
                    connected.attachment.dispose();
                    connected.transport.dispose();
                    return;
                }
                connectingAttachment = undefined;
                current = connected;
                log(`[${name}] ${hasConnected ? 'reconnected' : 'connected'}`);
                hasConnected = true;
                backoff = INITIAL_BACKOFF_MS;

                await connected.closed;
                connected.attachment.dispose();
                connected.transport.dispose();
                if (current === connected) current = undefined;
                if (stopped) return;

                delayBeforeAttempt = backoff;
                log(`[${name}] disconnected; reconnecting in ${delayBeforeAttempt} ms`);
            } catch (error) {
                connectingAttachment = undefined;
                if (stopped) return;
                delayBeforeAttempt = backoff;
                log(
                    `[${name}] connection failed: ${_errorMessage(error)}; `
                    + `retrying in ${delayBeforeAttempt} ms`,
                );
                backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
            }
        }
    })().catch((error) => {
        if (!stopped) log(`[${name}] reconnect loop failed: ${_errorMessage(error)}`);
    });

    return dispose;
}

interface ConnectedParticipant {
    readonly transport: IMessageTransport;
    readonly closed: Promise<void>;
    readonly attachment: ConfiguredParticipantAttachment;
}

interface OpenParticipant {
    readonly transport: IMessageTransport;
    readonly closed: Promise<void>;
}

async function _connectParticipant(
    participant: ConfiguredParticipant,
    attachParticipant: ConfigureParticipantsOptions['attachParticipant'],
    log: (line: string) => void,
    interactive: boolean,
    signal: AbortSignal,
    onAttached: (attachment: ConfiguredParticipantAttachment | undefined) => void,
): Promise<ConnectedParticipant> {
    const { config, name } = participant;
    const opened = await _openParticipant(config, name, log, interactive);
    if (signal.aborted) {
        opened.transport.dispose();
        throw new Error(`participant '${name}' stopped`);
    }
    const onAbort = () => opened.transport.dispose();
    signal.addEventListener('abort', onAbort, { once: true });
    let attachment: ConfiguredParticipantAttachment | undefined;
    try {
        attachment = attachParticipant(opened.transport);
        onAttached(attachment);
        void attachment.identifyPeer().catch((error: unknown) => {
            log(`[${name}] peer identification failed: ${_errorMessage(error)}`);
        });
        for (const serviceId of config.claimServiceIds) {
            await _registerOnRemote(attachment, serviceId);
        }
        for (const serviceId of config.routeServiceIds) attachment.claimPrefix(serviceId);
        if (config.defaultRoute) attachment.setDefaultRoute();
        return { ...opened, attachment };
    } catch (error) {
        attachment?.dispose();
        opened.transport.dispose();
        throw new Error(`participant '${name}' registration failed: ${_errorMessage(error)}`, {
            cause: error,
        });
    } finally {
        onAttached(undefined);
        signal.removeEventListener('abort', onAbort);
    }
}

async function _openParticipant(
    config: ParticipantConnectorConfig,
    name: string,
    log: (line: string) => void,
    interactive: boolean,
): Promise<OpenParticipant> {
    switch (config.kind) {
        case 'ws':
            return _openWsTransport(config.url, config.token);
        case 'socket':
            return _openSocketTransport(config.path, config.token);
        case 'uri': {
            const resolved = parseEndpointUri(config.uri);
            if (resolved.kind === 'ws') {
                return _openWsTransport(resolved.url, config.token ?? resolved.token);
            }
            if (resolved.kind === 'socket') {
                return _openSocketTransport(resolved.path, config.token ?? resolved.token);
            }
            throw new Error(
                `participant '${name}': uri resolves to '${resolved.kind}'; `
                + `use kind 'cmd-stdio' instead`,
            );
        }
        case 'cmd-stdio': {
            const closeSignal = _closeSignal();
            const child = spawnCommand(endpointCommand(config), {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, ...config.env },
                ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
            });
            child.once('error', closeSignal.close);
            child.once('exit', closeSignal.close);
            if (!child.stdin || !child.stdout) {
                killChild(child);
                throw new Error(`participant '${name}': child exposes no stdio`);
            }
            pipeChildLogs(child, name, log, { includeStdout: false });
            const stopForwarding = interactive ? forwardStdin(child) : () => { };
            const { transport } = await connectNdjson({
                input: child.stdout,
                output: child.stdin,
                onClose: () => {
                    stopForwarding();
                    killChild(child);
                    closeSignal.close();
                },
            });
            return { transport, closed: closeSignal.closed };
        }
    }
}

async function _openSocketTransport(
    socketPath: string,
    token: string | undefined,
): Promise<OpenParticipant> {
    const socket = net.createConnection(socketPath);
    const closeSignal = _closeSignal();
    socket.on('error', () => {
        socket.destroy();
        closeSignal.close();
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            socket.once('error', onError);
            socket.once('connect', () => {
                socket.off('error', onError);
                resolve();
            });
        });
    } catch (error) {
        socket.destroy();
        throw new Error(`connect '${socketPath}' failed: ${_errorMessage(error)}`, { cause: error });
    }
    const { transport } = await connectNdjson({
        input: socket,
        output: socket,
        onClose: () => {
            socket.destroy();
            closeSignal.close();
        },
        initialize: { kind: 'client', token: token ?? '' },
    });
    return { transport, closed: closeSignal.closed };
}

async function _openWsTransport(
    url: string,
    token: string | undefined,
): Promise<OpenParticipant> {
    const ws = await openWebSocket(url);
    const closeSignal = _closeSignal();
    const transport = new WebSocketTransport(ws, () => {
        try {
            ws.close();
        } catch { /* ignore */ }
        closeSignal.close();
    });
    try {
        await runInitializeHandshake(transport, { kind: 'client', token: token ?? '' });
    } catch (error) {
        transport.dispose();
        throw error;
    }
    return { transport, closed: closeSignal.closed };
}

function _registerOnRemote(
    attachment: ConfiguredParticipantAttachment,
    prefix: string,
    timeoutMs = 10_000,
): Promise<JsonValue | undefined> {
    return attachment.request(REGISTER_METHOD, { serviceId: prefix }, timeoutMs);
}

function _closeSignal(): { readonly closed: Promise<void>; readonly close: () => void; } {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
        let didClose = false;
        close = () => {
            if (didClose) return;
            didClose = true;
            resolve();
        };
    });
    return { closed, close };
}

function _delayUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function _errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
