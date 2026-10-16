import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { z } from 'zod';
import type { LinkRpcConnection } from '@hediet/linkrpc';
import { endpointDefinition, managedEndpointsInterface, type EndpointAddress, type EndpointDefinition, type EndpointEvent, type EndpointStatus } from './endpointInterface';
import { ManagedServiceSchema, type ManagedService } from './config';
import { writePrivateJson } from './discovery';
import { ServiceSupervisor, type ServiceHost } from './supervisor';
import { ConnectionSupervisor } from './connectionSupervisor';

const storedEndpoints = z.array(z.object({ definition: endpointDefinition, desired: z.boolean() }));
interface Entry {
    definition: EndpointDefinition;
    desired: boolean;
    readonly instanceId: string;
    readonly supervisor: ServiceSupervisor | ConnectionSupervisor;
    readonly output: Extract<EndpointEvent, { type: 'output' }>[];
    readonly listeners: Set<() => void>;
    sequence: number;
    removed: boolean;
}

export class ManagedEndpoints {
    private readonly _entries = new Map<string, Entry>();
    private readonly _recent = new Map<string, Entry>();
    private _ops = Promise.resolve();
    private _closing = false;

    constructor(
        private readonly _file: string,
        private readonly _prefix: string,
        private readonly _host: ServiceHost,
    ) {}

    snapshot(): { definition: EndpointDefinition; desired: boolean }[] {
        return [...this._entries.values()].map(entry => ({ definition: entry.definition, desired: entry.desired }));
    }

    async restore(snapshot?: ReturnType<ManagedEndpoints['snapshot']>): Promise<void> {
        if (snapshot !== undefined) {
            for (const { definition, desired } of snapshot) await this._restoreEntry(definition, desired);
            return;
        }
        let text: string;
        try { text = fs.readFileSync(this._file, 'utf8'); }
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
        const entry = this._make(definition, desired);
        this._entries.set(key(definition), entry);
        if (entry.desired) await entry.supervisor.sync();
    }

    register(connection: LinkRpcConnection, serviceId?: string): { dispose(): void } {
        return connection.register(managedEndpointsInterface, {
            info: () => ({ hostname: os.hostname(), platform: process.platform, cwd: process.cwd(), servicePrefix: this._prefix }),
            list: ({ namespace }) => this.list(namespace),
            create: definition => this._serialize(async () => {
                if (this._entries.has(key(definition))) throw new Error(`Endpoint "${definition.id}" already exists in ${definition.namespace}`);
                const entry = this._make(definition, true);
                this._entries.set(key(definition), entry);
                try { this._save(); }
                catch (error) { this._entries.delete(key(definition)); throw error; }
                await entry.supervisor.sync();
                return this._status(entry);
            }),
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
            attach: async (params, _context, stream) => {
                const entry = params.instanceId ? this._recent.get(params.instanceId) : this._entries.get(key(params));
                if (!entry || key(entry.definition) !== key(params)) throw new Error('Endpoint instance not found');
                let after = params.after;
                let dirty = true;
                let wake: (() => void) | undefined;
                const notify = () => { dirty = true; wake?.(); };
                entry.listeners.add(notify);
                stream.signal.addEventListener('abort', notify);
                try {
                    while (!stream.signal.aborted) {
                        dirty = false;
                        for (const output of entry.output.filter(value => value.sequence > after)) {
                            await stream.send(output);
                            after = output.sequence;
                        }
                        const status = this._status(entry);
                        await stream.send({ type: 'status', status });
                        if (entry.removed) { await stream.send({ type: 'removed' }); break; }
                        if (['disabled', 'stopped', 'failed'].includes(status.runtime.state)) break;
                        if (!dirty) await new Promise<void>(resolve => { wake = resolve; if (dirty || stream.signal.aborted) resolve(); });
                        wake = undefined;
                    }
                } finally {
                    entry.listeners.delete(notify);
                    stream.signal.removeEventListener('abort', notify);
                }
                return {};
            },
            input: params => {
                const entry = this._get(params);
                if (entry.instanceId !== params.instanceId) throw new Error('Endpoint instance changed; attach again');
                entry.supervisor.input(params.input);
                return {};
            },
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
    }

    private _make(definition: EndpointDefinition, desired: boolean): Entry {
        const digest = createHash('sha256').update(definition.namespace).digest('hex');
        const name = `${digest.slice(0, 16)}-${definition.id}`;
        const serviceId = `${this._prefix}/${digest}/${definition.id}`;
        const service: ManagedService = {
            ...ManagedServiceSchema.parse({
                ...(definition.source.kind === 'process' ? {
                    command: definition.source.command, env: definition.source.env,
                    cwd: definition.source.cwd, readiness: definition.source.readiness,
                } : { command: ['connection'] }),
                enabled: desired, restart: definition.restart, serviceId,
            }),
            serviceId,
        };
        let entry: Entry;
        const host: ServiceHost = {
            openSocket: (...args) => this._host.openSocket(...args),
            log: (...args) => this._host.log(...args),
            output: (_name, stream, text) => {
                for (let offset = 0; offset < text.length; offset += 8192) {
                    entry.output.push({ type: 'output', sequence: ++entry.sequence, stream, text: text.slice(offset, offset + 8192) });
                }
                if (entry.output.length > 1000) entry.output.splice(0, entry.output.length - 1000);
                for (const listener of entry.listeners) listener();
            },
        };
        const supervisor = definition.source.kind === 'process'
            ? new ServiceSupervisor(name, service, host, () => this._changed(entry))
            : new ConnectionSupervisor(name, definition.source.endpoint, service, host, () => this._changed(entry));
        entry = { definition, desired, supervisor, instanceId: randomUUID(), output: [], listeners: new Set(), sequence: 0, removed: false };
        this._recent.set(entry.instanceId, entry);
        for (const [id, old] of this._recent) {
            if (this._recent.size <= this._entries.size + 64) break;
            if (old.removed && old.listeners.size === 0) this._recent.delete(id);
        }
        return entry;
    }

    private _changed(entry: Entry): void {
        for (const listener of entry.listeners) listener();
        if (this._closing || entry.removed || entry.definition.persistent) return;
        if (['failed', 'stopped', 'disabled'].includes(entry.supervisor.status().state)) {
            this._removeEntry(entry);
        }
    }
    private _removeEntry(entry: Entry): void {
        if (this._entries.get(key(entry.definition)) === entry) this._entries.delete(key(entry.definition));
        entry.removed = true;
        for (const listener of entry.listeners) listener();
    }
    private _get(address: EndpointAddress): Entry {
        const entry = this._entries.get(key(address));
        if (!entry) throw new Error(`Endpoint "${address.id}" not found in ${address.namespace}`);
        return entry;
    }
    private _status(entry: Entry): EndpointStatus {
        return {
            namespace: entry.definition.namespace, id: entry.definition.id, instanceId: entry.instanceId,
            serviceId: entry.supervisor.service.serviceId, persistent: entry.definition.persistent,
            restart: entry.definition.restart, desired: entry.desired, sourceKind: entry.definition.source.kind,
            runtime: entry.supervisor.status(),
        };
    }
    private _save(): void {
        writePrivateJson(this._file, [...this._entries.values()].filter(entry => entry.definition.persistent)
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
        this._ops = result.then(() => {}, error => this._host.log('management', String(error)));
        return result;
    }
}

function key(address: EndpointAddress): string { return JSON.stringify([address.namespace, address.id]); }
