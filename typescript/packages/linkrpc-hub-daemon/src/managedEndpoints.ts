import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { z } from 'zod';
import type { LinkRpcConnection, StreamApi } from '@hediet/linkrpc';
import { ConsoleHost, consoleHandlers, type ConsoleClientMessage, type ConsoleExit, type ConsoleSize } from '@hediet/linkrpc-infra/console';
import {
    endpointDefinition,
    managedEndpointsInterface,
    type EndpointAddress,
    type EndpointDefinition,
    type EndpointStatus,
    type RunEvent,
    type RunParams,
    type WatchEvent,
} from './endpointInterface';
import { ManagedServiceSchema, type ManagedService } from './config';
import { writePrivateJson } from './discovery';
import { processSignals } from './processIo';
import { ScreenHistory } from './screenHistory';
import { ServiceSupervisor, type ServiceHost } from './supervisor';
import { ConnectionSupervisor } from './connectionSupervisor';

const storedEndpoints = z.array(z.object({ definition: endpointDefinition, desired: z.boolean() }));
const finishedStates = new Set(['failed', 'stopped', 'disabled']);

interface Entry {
    definition: EndpointDefinition;
    desired: boolean;
    readonly instanceId: string;
    /** Owned by a `run` call: it is never persisted or restored. */
    readonly owned: boolean;
    readonly supervisor: ServiceSupervisor | ConnectionSupervisor;
    readonly console: ConsoleHost | undefined;
    readonly listeners: Set<() => void>;
    removed: boolean;
}

export interface ManagedEndpointsOptions {
    readonly file: string;
    /** Published endpoint service IDs: `<servicePrefix>/<sha256(namespace)>/<id>`. */
    readonly servicePrefix: string;
    readonly host: ServiceHost;
}

export class ManagedEndpoints {
    private readonly _entries = new Map<string, Entry>();
    private _ops = Promise.resolve();
    private _closing = false;

    constructor(private readonly _options: ManagedEndpointsOptions) {}

    snapshot(): { definition: EndpointDefinition; desired: boolean }[] {
        return [...this._entries.values()].filter(entry => !entry.owned)
            .map(entry => ({ definition: entry.definition, desired: entry.desired }));
    }

    async restore(snapshot?: ReturnType<ManagedEndpoints['snapshot']>): Promise<void> {
        if (snapshot !== undefined) {
            for (const { definition, desired } of snapshot) await this._restoreEntry(definition, desired);
            return;
        }
        let text: string;
        try { text = fs.readFileSync(this._options.file, 'utf8'); }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
            throw error;
        }
        for (const { definition, desired } of storedEndpoints.parse(JSON.parse(text))) {
            await this._restoreEntry(definition, desired && definition.restart !== 'never');
        }
    }

    private async _restoreEntry(definition: EndpointDefinition, desired: boolean): Promise<void> {
        if (this._entries.has(key(definition))) throw new Error('Duplicate persisted endpoint');
        const entry = this._add(definition, desired, { owned: false });
        if (entry.desired) await entry.supervisor.sync();
    }

    register(connection: LinkRpcConnection, serviceId?: string): { dispose(): void } {
        return connection.register(managedEndpointsInterface, {
            consoles: consoleHandlers(address => {
                const console = this._get(address).console;
                if (!console) throw new Error(`Endpoint "${address.id}" is a connection and has no console`);
                return console;
            }),
            info: () => ({ hostname: os.hostname(), platform: process.platform, cwd: process.cwd(), servicePrefix: this._options.servicePrefix }),
            list: ({ namespace }) => this.list(namespace),
            create: ({ replace, ...definition }) => this._serialize(async () =>
                this._status(await this._create(definition, { owned: false, replace: replace ?? false }))),
            run: (params, _context, stream) => this._run(params, stream),
            watch: async (address, _context, stream) => {
                await this._watch(this._get(address), stream);
                return {};
            },
            start: address => this._serialize(async () => {
                const entry = this._get(address);
                this._setDesired(entry, true);
                await entry.supervisor.update({ ...entry.supervisor.service, enabled: true });
                await entry.supervisor.sync();
                return this._status(entry);
            }),
            stop: address => this._serialize(async () => {
                const entry = this._get(address);
                this._setDesired(entry, false);
                await entry.supervisor.update({ ...entry.supervisor.service, enabled: false });
                if (!entry.definition.persistent) this._removeEntry(entry);
                return {};
            }),
            remove: address => this._serialize(async () => {
                const entry = this._get(address);
                this._entries.delete(key(entry.definition));
                try { this._save(); } catch (error) { this._entries.set(key(entry.definition), entry); throw error; }
                await entry.supervisor.dispose();
                this._removeEntry(entry);
                return {};
            }),
            configure: params => this._serialize(async () => {
                const entry = this._get(params);
                if (entry.owned && params.persistent) throw new Error('A foreground (owned) endpoint cannot be persistent');
                const definition = {
                    ...entry.definition,
                    ...(params.persistent === undefined ? {} : { persistent: params.persistent }),
                    ...(params.restart === undefined ? {} : { restart: params.restart }),
                };
                const previous = entry.definition;
                entry.definition = definition;
                try { this._save(); } catch (error) { entry.definition = previous; throw error; }
                await entry.supervisor.update({ ...entry.supervisor.service, restart: definition.restart });
                this._changed(entry);
                return this._status(entry);
            }),
        }, serviceId === undefined ? undefined : { serviceId });
    }

    list(namespace?: string): EndpointStatus[] {
        return [...this._entries.values()].filter(entry => namespace === undefined || entry.definition.namespace === namespace)
            .map(entry => this._status(entry));
    }

    async dispose(): Promise<void> {
        this._closing = true;
        await this._ops;
        await Promise.all([...this._entries.values()].map(entry => entry.supervisor.dispose()));
        for (const entry of this._entries.values()) entry.console?.close();
    }

    private async _run(
        { definition, owner = false, replace = false, console: attach }: RunParams,
        stream: StreamApi<ConsoleClientMessage, RunEvent>,
    ): Promise<{ exit: ConsoleExit | null }> {
        if (owner && definition.persistent) throw new Error('A foreground (owned) endpoint cannot be persistent');
        const entry = await this._serialize(async () => {
            stream.signal.throwIfAborted();
            return this._create(definition, { owned: owner, replace, ...(attach.size ? { size: attach.size } : {}) });
        });
        const sendStatus = () => { stream.send({ t: 'status', status: this._status(entry) }).catch(() => {}); };
        entry.listeners.add(sendStatus);
        try {
            sendStatus();
            return await entry.console!.attach(attach, stream);
        } finally {
            entry.listeners.delete(sendStatus);
            // Shutdown already disposes every supervisor. Otherwise cleanup owns
            // this exact instance, never a replacement using the same name.
            if (owner && !this._closing) {
                await this._serialize(async () => {
                    await entry.supervisor.dispose();
                    this._removeEntry(entry);
                });
            }
        }
    }

    private async _create(
        definition: EndpointDefinition,
        options: { readonly owned: boolean; readonly replace: boolean; readonly size?: ConsoleSize },
    ): Promise<Entry> {
        const existing = this._entries.get(key(definition));
        if (existing) {
            if (!options.replace) throw new Error(`Endpoint "${definition.id}" already exists in ${definition.namespace}`);
            existing.console?.notice('Replaced by a new launch of the same endpoint.');
            await existing.supervisor.dispose();
            this._removeEntry(existing);
        }
        const entry = this._add(definition, true, options);
        try {
            this._save();
            await entry.supervisor.sync();
            return entry;
        } catch (error) {
            await entry.supervisor.dispose();
            this._removeEntry(entry);
            throw error;
        }
    }

    private async _watch(entry: Entry, stream: Pick<StreamApi<never, WatchEvent>, 'signal' | 'send'>): Promise<void> {
        let dirty = true;
        let wake: (() => void) | undefined;
        const notify = () => { dirty = true; wake?.(); };
        entry.listeners.add(notify);
        stream.signal.addEventListener('abort', notify);
        try {
            while (!stream.signal.aborted) {
                dirty = false;
                if (entry.removed) {
                    await stream.send({ t: 'removed' });
                    return;
                }
                await stream.send({ t: 'status', status: this._status(entry) });
                if (!dirty) await new Promise<void>(resolve => { wake = resolve; if (dirty || stream.signal.aborted) resolve(); });
                wake = undefined;
            }
        } finally {
            entry.listeners.delete(notify);
            stream.signal.removeEventListener('abort', notify);
        }
    }

    private _add(definition: EndpointDefinition, desired: boolean, options: { readonly owned: boolean; readonly size?: ConsoleSize }): Entry {
        const digest = createHash('sha256').update(definition.namespace).digest('hex');
        const name = `${digest.slice(0, 16)}-${definition.id}`;
        const serviceId = `${this._options.servicePrefix}/${digest}/${definition.id}`;
        const source = definition.source;
        const service: ManagedService = {
            ...ManagedServiceSchema.parse({
                ...(source.kind === 'process' ? {
                    command: source.command, env: source.env, cwd: source.cwd,
                    readiness: source.readiness, rpc: source.rpc, tty: source.tty,
                } : { command: ['connection'] }),
                enabled: desired, restart: definition.restart, serviceId,
            }),
            serviceId,
        };
        let entry: Entry;
        const host: ServiceHost = {
            openSocket: (...args) => this._options.host.openSocket(...args),
            log: (...args) => this._options.host.log(...args),
            output: (_name, stream, data) => entry.console?.output(stream, data),
            notice: (_name, text) => entry.console?.notice(text),
            processStarted: (_name, pid) => entry.console?.started(pid),
            processExited: (_name, exit) => entry.console?.exited(exit),
        };
        let supervisor: ServiceSupervisor | ConnectionSupervisor;
        let console: Entry['console'];
        if (source.kind === 'process') {
            const processSupervisor = new ServiceSupervisor(name, service, host, () => this._changed(entry));
            const size = source.tty ? options.size ?? { cols: 80, rows: 24 } : undefined;
            if (size) processSupervisor.resize(size);
            const consoleHost = new ConsoleHost({
                mode: source.tty ? 'tty' : 'pipe',
                signals: processSignals(source.tty),
                backend: processSupervisor,
                ...(size ? { size, history: new ScreenHistory(size) } : {}),
            });
            if (!desired) consoleHost.finish();
            supervisor = processSupervisor;
            console = consoleHost;
        } else {
            supervisor = new ConnectionSupervisor(name, source.endpoint, service, host, () => this._changed(entry));
        }
        entry = { definition, desired, owned: options.owned, supervisor, console, instanceId: randomUUID(), listeners: new Set(), removed: false };
        this._entries.set(key(definition), entry);
        return entry;
    }

    private _changed(entry: Entry): void {
        for (const listener of entry.listeners) listener();
        if (!finishedStates.has(entry.supervisor.status().state)) return;
        entry.console?.finish();
        if (!this._closing && !entry.removed && !entry.definition.persistent) this._removeEntry(entry);
    }

    private _removeEntry(entry: Entry): void {
        if (entry.removed) return;
        if (this._entries.get(key(entry.definition)) === entry) this._entries.delete(key(entry.definition));
        entry.removed = true;
        entry.console?.close();
        for (const listener of entry.listeners) listener();
    }

    private _get(address: EndpointAddress): Entry {
        const entry = this._entries.get(key(address));
        if (!entry) throw new Error(`Endpoint "${address.id}" not found in ${address.namespace}`);
        return entry;
    }

    private _status(entry: Entry): EndpointStatus {
        const source = entry.definition.source;
        return {
            namespace: entry.definition.namespace, id: entry.definition.id, instanceId: entry.instanceId,
            serviceId: entry.supervisor.service.serviceId, persistent: entry.definition.persistent,
            restart: entry.definition.restart, desired: entry.desired, owned: entry.owned, sourceKind: source.kind,
            rpc: source.kind === 'connection' || source.rpc,
            ...(entry.console ? { console: { mode: entry.console.mode } } : {}),
            runtime: entry.supervisor.status(),
        };
    }

    private _save(): void {
        writePrivateJson(this._options.file, [...this._entries.values()].filter(entry => entry.definition.persistent)
            .map(entry => ({ definition: entry.definition, desired: entry.desired })));
    }

    private _setDesired(entry: Entry, desired: boolean): void {
        const previous = entry.desired;
        entry.desired = desired;
        try { this._save(); } catch (error) { entry.desired = previous; throw error; }
    }

    private _serialize<T>(operation: () => Promise<T>): Promise<T> {
        if (this._closing) return Promise.reject(new Error('Daemon is stopping'));
        const result = this._ops.then(operation);
        this._ops = result.then(() => {}, error => this._options.host.log('management', String(error)));
        return result;
    }
}

function key(address: EndpointAddress): string { return JSON.stringify([address.namespace, address.id]); }
