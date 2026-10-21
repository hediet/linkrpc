import { randomBytes } from 'node:crypto';
import { HUBRPC_META_KEY, parseMethodName, stripLinkRpcWireMeta } from '@hediet/linkrpc';
import type { InspectionHost } from '@hediet/linkrpc/inspection';
import { type FlowSummary, TrafficFlowAggregator } from '@hediet/linkrpc-hub';
import type { CallLogConfig } from './callLogConfig';
import { type CallPeer, type CallRecord, type CallRecordLevel, isCallLevelEnabled } from './callRecord';
import { payloadBytes, shapePayload } from './payloadPolicy';
import { PortPeers } from './portPeers';
import { serviceNameOf } from '../participantDescriptors';

/** How long an unsettled call (e.g. a watch stream) is tracked before it is forgotten. */
const GIVE_UP_MS = 24 * 60 * 60_000;

export interface CallRecorderOptions {
    readonly inspection: InspectionHost;
    /** Read for every call, so level and payload changes apply immediately. */
    readonly config: () => CallLogConfig;
    readonly onRecord: (record: CallRecord) => void;
    /** Calls to this method prefix (the call log's own `linkrpc.logging`) are recorded without results or stream frames. */
    readonly ownMethodPrefix: string;
}

/**
 * Records the calls routed through a hub: observes its inspection traffic,
 * coalesces transits into flows with {@link TrafficFlowAggregator}, and turns
 * each flow into a {@link CallRecord}. Calls the hub itself originates
 * (peer discovery, ...) are not recorded.
 */
export class CallRecorder {
    private readonly _idPrefix = randomBytes(4).toString('hex');
    private readonly _aggregator: TrafficFlowAggregator;
    private readonly _peers: PortPeers;
    private readonly _observation: { dispose(): void; };

    constructor(private readonly _options: CallRecorderOptions) {
        this._peers = new PortPeers(() => _options.inspection.getGraph(''));
        this._aggregator = new TrafficFlowAggregator({ onFlow: flow => this._onFlow(flow), giveUpMs: GIVE_UP_MS });
        this._observation = _options.inspection.observeTraffic(transit => {
            if (transit.kind === 'request' || transit.kind === 'notification') {
                if (transit.in) this._peers.observe(transit.in.portId);
                if (transit.out) this._peers.observe(transit.out.portId);
            }
            this._aggregator.add(transit);
        });
    }

    public dispose(): void {
        this._observation.dispose();
        this._aggregator.dispose();
    }

    private _onFlow(flow: FlowSummary): void {
        const record = this._toRecord(flow, this._options.config());
        if (record) this._options.onRecord(record);
    }

    private _toRecord(flow: FlowSummary, config: CallLogConfig): CallRecord | undefined {
        if (flow.entryPortId === undefined || flow.method === undefined) return undefined;
        // The log never stores its own content: snapshots would copy earlier records into new ones.
        const ownCall = flow.method.startsWith(this._options.ownMethodPrefix);
        if (ownCall && flow.kind === 'stream') return undefined;
        const parsed = parseMethodName(flow.method);
        const serviceId = parsed?.kind === 'full' ? parsed.serviceId : undefined;
        const level = _levelOf(flow);
        if (!isCallLevelEnabled(level, config.level)) return undefined;

        const frame = flow.kind === 'stream' ? flow.stream?.[0] : undefined;
        const params = frame !== undefined
            ? { dir: frame.dir, ...(frame.control !== undefined ? { control: frame.control } : {}), payload: frame.payload }
            : stripLinkRpcWireMeta(flow.params);
        const principal = _principalOf(flow.params);
        const shapedParams = shapePayload(params, config.payloads);
        const shapedResult = ownCall ? undefined : shapePayload(flow.result, config.payloads);
        const paramsSize = payloadBytes(params);
        const resultSize = payloadBytes(flow.result);
        return {
            v: 1,
            id: `${this._idPrefix}-${flow.id}`,
            at: flow.startTs,
            level,
            kind: flow.kind === 'response' ? 'request' : flow.kind,
            status: flow.status,
            durationMs: flow.durationMs,
            method: flow.method,
            ...(serviceId !== undefined ? { serviceId } : {}),
            from: this._peer(flow.entryPortId),
            ...(flow.exitPortId !== undefined ? { to: this._peer(flow.exitPortId) } : {}),
            ...(principal !== undefined ? { principal } : {}),
            ...(flow.error !== undefined ? { error: { code: flow.error.code, message: flow.error.message } } : {}),
            ...(paramsSize !== undefined ? { paramsBytes: paramsSize } : {}),
            ...(resultSize !== undefined ? { resultBytes: resultSize } : {}),
            ...(shapedParams !== undefined ? { params: shapedParams } : {}),
            ...(shapedResult !== undefined ? { result: shapedResult } : {}),
            ...(frame === undefined && flow.stream !== undefined ? { streamFrames: flow.stream.length } : {}),
        };
    }

    private _peer(portId: string): CallPeer {
        const { transport, descriptor } = this._peers.describe(portId);
        const service = serviceNameOf(descriptor);
        return {
            label: this._aggregator.portLabel(portId),
            ...(transport !== undefined ? { transport } : {}),
            ...(service !== undefined ? { service } : {}),
        };
    }
}

function _levelOf(flow: FlowSummary): CallRecordLevel {
    if (flow.status === 'failed' || flow.status === 'unroutable' || flow.status === 'dropped') return 'error';
    if (flow.kind === 'stream') return 'trace';
    return flow.kind === 'notification' ? 'debug' : 'info';
}

function _principalOf(wireParams: unknown): string | undefined {
    if (wireParams === null || typeof wireParams !== 'object' || !(HUBRPC_META_KEY in wireParams)) return undefined;
    const meta: unknown = (wireParams as Record<string, unknown>)[HUBRPC_META_KEY];
    if (meta === null || typeof meta !== 'object' || !('principal' in meta)) return undefined;
    return typeof meta.principal === 'string' ? meta.principal : undefined;
}
