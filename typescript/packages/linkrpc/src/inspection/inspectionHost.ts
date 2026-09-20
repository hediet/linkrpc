import type { LinkRpcConnection, InterfaceRegistration } from '../connection/linkRpcConnection';
import type { StreamApi } from '../connection/interfaceDefinition';
import { bytesToBase64Url } from '../crypto/cryptoProvider';
import { nodeInterface } from './node.interfaces';
import {
    topologyInterface, trafficInterface,
    type ParticipantDescriptorSource, type TopologyGraph, type TopologyNode,
    type TrafficEvent, type TrafficTransitEvent, type TrafficWatchResult,
} from './inspection.interfaces';
import {
    BoundedTrafficSubscription, type TrafficSubscription, type TrafficSubscriptionOptions,
} from './boundedTrafficSubscription';
import { TrafficWatchFlowTracker } from './trafficFlowFilter';
import { EndpointTrafficInspector } from './endpointTrafficInspector';
import { ConnectionInspectionSource, type TrackConnectionOptions } from './connectionInspectionSource';

export interface TopologyFragment {
    readonly nodes: TopologyGraph['nodes'];
    readonly links: TopologyGraph['links'];
    readonly routes: TopologyGraph['routes'];
}

export interface InspectionSource {
    snapshotTopology(): TopologyFragment;
    onTopologyChanged(listener: () => void): InterfaceRegistration;
    /** Includes watch control traffic so self-observation can be excluded. */
    observeTraffic(listener: (event: TrafficTransitEvent) => void): InterfaceRegistration;
}

export interface InspectionHostOptions {
    readonly nodeId: string;
    readonly kind?: 'endpoint' | 'hub';
    readonly label?: string;
    readonly descriptors?: readonly ParticipantDescriptorSource[];
}

export interface InspectionExposureOptions {
    readonly serviceId: string;
    readonly portId?: string;
    readonly descriptors?: readonly ParticipantDescriptorSource[];
    /** False when the source already supplies the service's route. */
    readonly includeRoute?: boolean;
}

export interface InspectionTrafficSource {
    observe(listener: (event: TrafficTransitEvent) => void): InterfaceRegistration;
}

interface LazyTrafficSource {
    readonly source: InspectionTrafficSource;
    observation?: InterfaceRegistration;
}

/** A shared inspection scope, independent of both routing and its RPC connections. */
export class InspectionHost {
    private readonly _sources = new Map<InspectionSource, InterfaceRegistration>();
    private readonly _trackedConnections = new Set<InterfaceRegistration>();
    private readonly _bindings = new Set<InspectionBinding>();
    private readonly _subscribers = new Set<BoundedTrafficSubscription>();
    private readonly _observers = new Set<(event: TrafficTransitEvent) => void>();
    private readonly _topologyListeners = new Set<() => void>();
    private readonly _trafficSources = new Set<LazyTrafficSource>();
    private readonly _trafficWatches = new TrafficWatchFlowTracker();
    private _disposed = false;

    public readonly nodeId: string;

    constructor(private readonly _options: InspectionHostOptions) {
        this.nodeId = _options.nodeId;
    }

    public get observerCount(): number {
        return this._subscribers.size + this._observers.size;
    }

    public addSource(source: InspectionSource): InterfaceRegistration {
        this._assertActive();
        if (this._sources.has(source)) throw new Error('Inspection source is already registered');
        const readPorts = () => new Set(source.snapshotTopology().nodes.flatMap(node =>
            node.ports.map(port => port.portId)));
        let ports = readPorts();
        const topology = source.onTopologyChanged(() => {
            const nextPorts = readPorts();
            const removed = [...ports].filter(port => !nextPorts.has(port));
            ports = nextPorts;
            this._forgetUnusedPorts(removed);
            this._invalidateTopology();
        });
        let traffic: InterfaceRegistration;
        try {
            traffic = source.observeTraffic(event => this.publishTransit(event));
        } catch (error) {
            topology.dispose();
            throw error;
        }
        const registration = {
            dispose: () => {
                if (this._sources.get(source) !== registration) return;
                this._sources.delete(source);
                topology.dispose();
                traffic.dispose();
                this._forgetUnusedPorts([...ports]);
                this._invalidateTopology();
            },
        };
        this._sources.set(source, registration);
        this._invalidateTopology();
        return registration;
    }

    public trackConnection<TIn, TOut>(
        connection: LinkRpcConnection<TIn, TOut>,
        options: TrackConnectionOptions,
    ): InterfaceRegistration {
        this._assertActive();
        if (this.getGraph('').nodes.some(node =>
            node.ports.some(port => port.portId === options.portId))) {
            throw new Error(`Inspection port "${options.portId}" is already registered`);
        }
        const source = new ConnectionInspectionSource(
            connection, this.nodeId, options, () => this.observerCount !== 0,
        );
        const registration = this.addSource(source);
        let close: InterfaceRegistration;
        try {
            close = connection.onDidClose(() => result.dispose());
        } catch (error) {
            registration.dispose();
            throw error;
        }
        const result = {
            dispose: () => {
                this._trackedConnections.delete(result);
                close.dispose();
                registration.dispose();
            },
        };
        this._trackedConnections.add(result);
        return result;
    }

    public expose<TIn, TOut>(
        connection: LinkRpcConnection<TIn, TOut>,
        options: InspectionExposureOptions,
    ): InterfaceRegistration {
        this._assertActive();
        const portId = options.portId ?? createPortId();
        const binding = new InspectionBinding(portId);
        const registrations: InterfaceRegistration[] = [];
        this._bindings.add(binding);
        const registerOptions = { serviceId: options.serviceId };
        try {
            // An exposure observes only watch-control flows, not frontend business traffic.
            const controls = new EndpointTrafficInspector(
                this.nodeId, portId, event => this._trafficWatches.accept(event), () => false,
            );
            registrations.push(connection.observeWireMessages(controls.observe));
            registrations.push({ dispose: () => controls.dispose() });
            registrations.push(connection.registerInspection(nodeInterface, {
                getNodeId: () => ({
                    nodeId: this.nodeId,
                    portId,
                    ...((options.descriptors ?? this._options.descriptors) === undefined ? {} : {
                        descriptors: [...(options.descriptors ?? this._options.descriptors ?? [])],
                    }),
                }),
            }, registerOptions));
            registrations.push(connection.registerInspection(topologyInterface, {
                getGraph: () => this.getGraph(
                    options.serviceId, options.includeRoute === false ? undefined : portId,
                ),
                watchGraph: (_params, _ctx, stream) => this._watchGraph(binding, stream),
            }, registerOptions));
            registrations.push(connection.registerInspection(trafficInterface, {
                watch: (params, _ctx, stream) => this._watchTraffic(binding, params, stream),
                watchWithPayloads: (params, _ctx, stream) => this._watchTraffic(binding, params, stream),
            }, registerOptions));
        } catch (error) {
            for (const registration of registrations.reverse()) registration.dispose();
            this._bindings.delete(binding);
            throw error;
        }
        binding.onDispose = () => {
            this._bindings.delete(binding);
            for (const registration of registrations.reverse()) registration.dispose();
            this._forgetUnusedPorts([portId]);
            this._invalidateTopology();
        };
        registrations.push(connection.onDidClose(() => binding.dispose()));
        this._invalidateTopology();
        return binding;
    }

    public getGraph(observerServiceId: string, routePortId?: string): TopologyGraph {
        this._assertActive();
        const nodes = new Map<string, TopologyNode>();
        const mergeNode = (node: TopologyNode): void => {
            const previous = nodes.get(node.nodeId);
            const ports = new Map(previous?.ports.map(port => [port.portId, port]));
            for (const port of node.ports) ports.set(port.portId, { ...ports.get(port.portId), ...port });
            nodes.set(node.nodeId, { ...previous, ...node, ports: [...ports.values()] });
        };
        mergeNode({
            nodeId: this.nodeId,
            kind: this._options.kind ?? 'endpoint',
            ...(this._options.label === undefined ? {} : { label: this._options.label }),
            ...(this._options.descriptors === undefined ? {} : { descriptors: [...this._options.descriptors] }),
            ports: [],
        });
        const links: TopologyGraph['links'] = [];
        const routes: TopologyGraph['routes'] = [];
        for (const source of this._sources.keys()) {
            const fragment = source.snapshotTopology();
            for (const node of fragment.nodes) mergeNode(node);
            links.push(...fragment.links);
            routes.push(...fragment.routes);
        }
        for (const binding of this._bindings) {
            mergeNode({ nodeId: this.nodeId, ports: [{ portId: binding.portId }] });
        }
        if (routePortId !== undefined) {
            routes.push({
                serviceId: observerServiceId, nodeId: this.nodeId,
                portId: routePortId, match: 'exact',
            });
        }
        return {
            observerServiceId, entryNodeId: this.nodeId,
            nodes: [...nodes.values()], links, routes,
        };
    }

    public publishTransit(event: TrafficTransitEvent): void {
        if (this._disposed || this._trafficWatches.accept(event)) return;
        for (const observer of [...this._observers]) {
            try {
                observer(event);
            } catch {
                // Diagnostic observers must not interrupt the observed connection.
            }
        }
        for (const subscriber of this._subscribers) subscriber.enqueue(event);
    }

    public subscribe(
        options: TrafficSubscriptionOptions,
        send: (event: TrafficEvent) => Promise<void>,
    ): TrafficSubscription {
        this._assertActive();
        if (options.trafficIgnoreKey !== undefined && !this._trafficWatches.claim(options.trafficIgnoreKey)) {
            throw new Error('Traffic watch request was not observed before subscription');
        }
        const subscriber = new BoundedTrafficSubscription(options, send, () => {
            this._subscribers.delete(subscriber);
            this._stopUnusedTrafficSources();
        });
        this._subscribers.add(subscriber);
        try {
            this._startTrafficSources();
        } catch (error) {
            subscriber.dispose();
            throw error;
        }
        return subscriber;
    }

    public observeTraffic(observer: (event: TrafficTransitEvent) => void): InterfaceRegistration {
        this._assertActive();
        this._observers.add(observer);
        const registration = { dispose: () => {
            this._observers.delete(observer);
            this._stopUnusedTrafficSources();
        } };
        try {
            this._startTrafficSources();
        } catch (error) {
            registration.dispose();
            throw error;
        }
        return registration;
    }

    public addTrafficSource(source: InspectionTrafficSource): InterfaceRegistration {
        this._assertActive();
        const entry: LazyTrafficSource = { source };
        this._trafficSources.add(entry);
        try {
            this._startTrafficSources();
        } catch (error) {
            this._trafficSources.delete(entry);
            throw error;
        }
        return { dispose: () => {
            this._trafficSources.delete(entry);
            entry.observation?.dispose();
            entry.observation = undefined;
        } };
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        for (const binding of [...this._bindings]) binding.dispose();
        for (const subscriber of [...this._subscribers]) subscriber.dispose();
        this._observers.clear();
        this._stopUnusedTrafficSources();
        this._trafficSources.clear();
        for (const connection of [...this._trackedConnections]) connection.dispose();
        for (const source of [...this._sources.values()]) source.dispose();
        this._topologyListeners.clear();
        this._trafficWatches.clear();
    }

    private _startTrafficSources(): void {
        if (this.observerCount === 0) return;
        for (const entry of this._trafficSources) {
            entry.observation ??= entry.source.observe(event => this.publishTransit(event));
        }
    }

    private _stopUnusedTrafficSources(): void {
        if (this.observerCount !== 0) return;
        for (const entry of this._trafficSources) {
            entry.observation?.dispose();
            entry.observation = undefined;
        }
    }

    private _invalidateTopology(): void {
        if (this._disposed) return;
        for (const listener of this._topologyListeners) listener();
    }

    private _forgetUnusedPorts(portIds: readonly string[]): void {
        if (this._disposed) return;
        const remaining = new Set(this.getGraph('').nodes.flatMap(node => node.ports.map(port => port.portId)));
        for (const portId of portIds) {
            if (!remaining.has(portId)) this._trafficWatches.forgetPort(portId);
        }
    }

    private _watchGraph<T>(
        binding: InspectionBinding,
        stream: StreamApi<T, Record<string, never>>,
    ): Promise<Record<string, never>> {
        return new Promise((resolve, reject) => {
            let pending = false;
            let active = true;
            const finish = () => {
                active = false;
                this._topologyListeners.delete(invalidate);
                stream.signal.removeEventListener('abort', finish);
                binding.abort.signal.removeEventListener('abort', finish);
                resolve({});
            };
            const invalidate = () => {
                if (pending || !active) return;
                pending = true;
                queueMicrotask(() => {
                    pending = false;
                    if (!active) return;
                    void stream.send({}).catch(error => {
                        reject(error);
                        finish();
                    });
                });
            };
            this._topologyListeners.add(invalidate);
            stream.signal.addEventListener('abort', finish, { once: true });
            binding.abort.signal.addEventListener('abort', finish, { once: true });
            if (stream.signal.aborted || binding.abort.signal.aborted) finish();
        });
    }

    private async _watchTraffic<T>(
        binding: InspectionBinding,
        options: TrafficSubscriptionOptions,
        stream: StreamApi<T, TrafficEvent>,
    ): Promise<TrafficWatchResult> {
        const subscription = this.subscribe(options, event => stream.send(event));
        const dispose = () => subscription.dispose();
        stream.signal.addEventListener('abort', dispose, { once: true });
        binding.abort.signal.addEventListener('abort', dispose, { once: true });
        if (stream.signal.aborted || binding.abort.signal.aborted) dispose();
        try {
            return await subscription.closed;
        } finally {
            stream.signal.removeEventListener('abort', dispose);
            binding.abort.signal.removeEventListener('abort', dispose);
            subscription.dispose();
        }
    }

    private _assertActive(): void {
        if (this._disposed) throw new Error('Inspection host is disposed');
    }
}

class InspectionBinding implements InterfaceRegistration {
    public readonly abort = new AbortController();
    public onDispose: () => void = () => {};
    constructor(public readonly portId: string) {}
    public dispose(): void {
        if (this.abort.signal.aborted) return;
        this.abort.abort();
        this.onDispose();
    }
}

function createPortId(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `port:${bytesToBase64Url(bytes)}`;
}
