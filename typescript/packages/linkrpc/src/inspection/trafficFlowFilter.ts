import type {
    TrafficTransitEndpoint,
    TrafficTransitEvent,
} from './inspection.interfaces';

export interface TrafficRequestRef {
    readonly portId: string;
    readonly requestId: string | number;
}

export interface TrafficFlowFilterOptions {
    readonly focus?: TrafficRequestRef;
}

export class TrafficFlowFilter {
    private readonly _focused: CorrelatedFlow | undefined;

    constructor(options: TrafficFlowFilterOptions) {
        this._focused = options.focus !== undefined
            ? new CorrelatedFlow([options.focus])
            : undefined;
    }

    public shouldInclude(transit: TrafficTransitEvent): boolean {
        const focused = this._focused?.accept(transit).matches ?? true;
        return focused;
    }
}

export class TrafficWatchFlowTracker {
    private readonly _active = new Set<CorrelatedFlow>();
    private readonly _unclaimed = new Map<string, CorrelatedFlow>();

    public accept(transit: TrafficTransitEvent): boolean {
        if (transit.kind === 'request' && isTrafficWatchMethod(transit.method)) {
            const trafficIgnoreKey = readTrafficIgnoreKey(transit.params);
            let flow = this._findFlow(transit);
            if (flow === undefined) {
                flow = new CorrelatedFlow(
                    requestRefsOf(transit),
                    completionRefOf(transit),
                );
                if (!isTerminal(transit)) this._active.add(flow);
            } else {
                flow.accept(transit);
            }
            if (isTerminal(transit)) {
                this._removeFlow(flow);
                return true;
            }
            if (trafficIgnoreKey !== undefined) {
                this._unclaimed.set(trafficIgnoreKey, flow);
            }
            return true;
        }
        for (const flow of this._active) {
            const match = flow.accept(transit);
            if (!match.matches) continue;
            if (match.completed) this._removeFlow(flow);
            return true;
        }
        return false;
    }

    private _findFlow(transit: TrafficTransitEvent): CorrelatedFlow | undefined {
        for (const flow of this._active) {
            if (flow.matches(transit)) return flow;
        }
        return undefined;
    }

    private _removeFlow(flow: CorrelatedFlow): void {
        this._active.delete(flow);
        for (const [key, pending] of this._unclaimed) {
            if (pending === flow) this._unclaimed.delete(key);
        }
    }

    public claim(trafficIgnoreKey: string): boolean {
        return this._unclaimed.delete(trafficIgnoreKey);
    }

    public clear(): void {
        this._active.clear();
        this._unclaimed.clear();
    }
}

class CorrelatedFlow {
    private readonly _endpoints = new Set<string>();
    private readonly _completionEndpoint: string | undefined;

    constructor(
        endpoints: readonly TrafficRequestRef[],
        completionEndpoint: TrafficRequestRef | undefined = endpoints[0],
    ) {
        for (const endpoint of endpoints) this._endpoints.add(endpointKey(endpoint));
        this._completionEndpoint = completionEndpoint === undefined
            ? undefined
            : endpointKey(completionEndpoint);
    }

    public matches(transit: TrafficTransitEvent): boolean {
        return requestRefsOf(transit)
            .some((endpoint) => this._endpoints.has(endpointKey(endpoint)));
    }

    public accept(transit: TrafficTransitEvent): {
        readonly matches: boolean;
        readonly completed: boolean;
    } {
        const endpoints = requestRefsOf(transit);
        if (!this.matches(transit)) {
            return { matches: false, completed: false };
        }
        for (const endpoint of endpoints) this._endpoints.add(endpointKey(endpoint));
        const completed = transit.kind === 'response'
            && (
                isTerminal(transit)
                || (
                    this._completionEndpoint !== undefined
                    && endpoints.some((endpoint) =>
                        endpointKey(endpoint) === this._completionEndpoint)
                )
            );
        if (completed) this._endpoints.clear();
        return { matches: true, completed };
    }

}

function isTerminal(transit: TrafficTransitEvent): boolean {
    return transit.disposition === 'dropped'
        || transit.disposition === 'unroutable';
}

function requestRefsOf(transit: TrafficTransitEvent): TrafficRequestRef[] {
    const result: TrafficRequestRef[] = [];
    if (transit.in?.requestId !== undefined) result.push(requestRef(transit.in));
    if (transit.out?.requestId !== undefined) result.push(requestRef(transit.out));
    return result;
}

function requestRef(endpoint: TrafficTransitEndpoint): TrafficRequestRef {
    return {
        portId: endpoint.portId,
        requestId: endpoint.requestId!,
    };
}

function completionRefOf(transit: TrafficTransitEvent): TrafficRequestRef | undefined {
    if (transit.in?.requestId !== undefined) return requestRef(transit.in);
    if (transit.out?.requestId !== undefined) return requestRef(transit.out);
    return undefined;
}

function endpointKey(endpoint: TrafficRequestRef): string {
    return JSON.stringify([
        endpoint.portId,
        typeof endpoint.requestId,
        endpoint.requestId,
    ]);
}

function isTrafficWatchMethod(method: string | undefined): boolean {
    return method?.endsWith('::hubrpc.traffic::watch') === true
        || method?.endsWith('::hubrpc.traffic::watchWithPayloads') === true
        || method === 'hubrpc.traffic::watch'
        || method === 'hubrpc.traffic::watchWithPayloads';
}

function readTrafficIgnoreKey(params: unknown): string | undefined {
    if (params === null || Array.isArray(params) || typeof params !== 'object' || !('trafficIgnoreKey' in params)) {
        return undefined;
    }
    const value = params.trafficIgnoreKey;
    return typeof value === 'string' ? value : undefined;
}
