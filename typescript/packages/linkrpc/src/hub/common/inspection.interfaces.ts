import {
    array,
    boolean,
    enum as zEnum,
    int,
    literal,
    nonnegative,
    number,
    object,
    optional,
    record,
    string,
    union,
    unknown,
} from "zod/mini";
import type { output as zInfer } from "zod/v4/core";
import { defineInterface } from "../../connection/interfaceDefinition";
import { requestType } from "../../schema/memberTypes";

export const zTopologyPort = object({
    portId: string(),
    label: optional(string()),
});

export const zParticipantDescriptor = object({
    type: optional(string()),
    label: optional(string()),
    processId: optional(number()),
    processType: optional(string()),
    nodeStatusServiceId: optional(string()),
    metadata: optional(record(string(), union([string(), number(), boolean()]))),
});

export const zParticipantDescriptorSource = object({
    source: zEnum(["self", "attacher"]),
    descriptor: zParticipantDescriptor,
});

export const zTopologyNode = object({
    nodeId: string(),
    kind: optional(zEnum(["endpoint", "hub"])),
    label: optional(string()),
    descriptors: optional(array(zParticipantDescriptorSource)),
    ports: array(zTopologyPort),
});

export const zTopologyLinkEndpoint = object({
    nodeId: string(),
    portId: string(),
});

export const zTopologyTransportEndpoint = object({
    address: optional(string()),
    port: optional(number().check(int(), nonnegative())),
});

/**
 * Transport details as observed at a topology link. `local` corresponds to the
 * link's `from` endpoint and `remote` to its `to` endpoint.
 */
export const zTopologyTransportInfo = object({
    type: string(),
    local: optional(zTopologyTransportEndpoint),
    remote: optional(zTopologyTransportEndpoint),
    path: optional(string()),
    metadata: optional(record(string(), union([string(), number(), boolean()]))),
});

export const zTopologyLink = object({
    from: zTopologyLinkEndpoint,
    to: zTopologyLinkEndpoint,
    label: optional(string()),
    peerState: optional(zEnum(["identified", "pending", "unsupported", "error"])),
    transport: optional(zTopologyTransportInfo),
});

export const zRouteClaim = object({
    serviceId: string(),
    nodeId: string(),
    portId: string(),
    match: zEnum(["exact", "prefix"]),
});

export const zTopologyGraph = object({
    observerServiceId: string(),
    entryNodeId: string(),
    nodes: array(zTopologyNode),
    links: array(zTopologyLink),
    routes: array(zRouteClaim),
});

export type TopologyPort = zInfer<typeof zTopologyPort>;
export type ParticipantDescriptor = zInfer<typeof zParticipantDescriptor>;
export type ParticipantDescriptorSource = zInfer<typeof zParticipantDescriptorSource>;
export type TopologyNode = zInfer<typeof zTopologyNode>;
export type TopologyLinkEndpoint = zInfer<typeof zTopologyLinkEndpoint>;
export type TopologyTransportEndpoint = zInfer<typeof zTopologyTransportEndpoint>;
export type TopologyTransportInfo = zInfer<typeof zTopologyTransportInfo>;
export type TopologyLink = zInfer<typeof zTopologyLink>;
export type RouteClaim = zInfer<typeof zRouteClaim>;
export type TopologyGraph = zInfer<typeof zTopologyGraph>;

export const topologyInterface = defineInterface(
    {
        id: "hubrpc.topology",
        description:
            "Inspect the transport graph visible from a service. A watch emits invalidation "
            + "ticks; consumers re-fetch getGraph after each tick.",
    },
    {
        getGraph: requestType(object({}), zTopologyGraph).withStream({ client: object({}) }),
        watchGraph: requestType(object({}), object({})).withStream({
            server: object({}),
        }),
    },
);

export const zTrafficTransitEndpoint = object({
    edgeId: string(),
    portId: string(),
    requestId: optional(union([number(), string()])),
});

export const zTrafficTransitEvent = object({
    type: literal("transit"),
    ts: number(),
    nodeId: string(),
    in: optional(zTrafficTransitEndpoint),
    out: optional(zTrafficTransitEndpoint),
    disposition: zEnum(["forwarded", "consumed", "dropped", "unroutable"]),
    kind: zEnum(["request", "notification", "response", "stream"]),
    method: optional(string()),
    params: optional(unknown()),
    result: optional(unknown()),
    error: optional(object({
        code: number(),
        message: string(),
        data: optional(unknown()),
    })),
});

export const zTrafficOverflowEvent = object({
    type: literal("overflow"),
    dropped: number().check(int(), nonnegative()),
});

export const zTrafficEvent = union([zTrafficTransitEvent, zTrafficOverflowEvent]);

export type TrafficTransitEndpoint = zInfer<typeof zTrafficTransitEndpoint>;
export type TrafficTransitEvent = zInfer<typeof zTrafficTransitEvent>;
export type TrafficOverflowEvent = zInfer<typeof zTrafficOverflowEvent>;
export type TrafficEvent = zInfer<typeof zTrafficEvent>;

export const zTrafficWatchResult = object({
    delivered: number().check(int(), nonnegative()),
    dropped: number().check(int(), nonnegative()),
});

export type TrafficWatchResult = zInfer<typeof zTrafficWatchResult>;

const zTrafficWatchParams = object({
    methodPrefix: optional(string()),
});

const zTrafficWatchWithPayloadsParams = object({
    methodPrefix: optional(string()),
    maxPayloadBytes: number().check(int(), nonnegative()),
});

/**
 * Observe raw message transits at the node hosting the addressed service.
 * Consumers may correlate adjacent transits by shared `(portId, requestId)`.
 */
export const trafficInterface = defineInterface(
    {
        id: "hubrpc.traffic",
        description:
            "Stream raw message transits for the entire node hosting the addressed service. "
            + "Payload-free and explicitly payload-bearing variants keep disclosure opt-in.",
    },
    {
        watch: requestType(zTrafficWatchParams, zTrafficWatchResult).withStream({
            server: zTrafficEvent,
        }),
        watchWithPayloads: requestType(
            zTrafficWatchWithPayloadsParams,
            zTrafficWatchResult,
        ).withStream({
            server: zTrafficEvent,
        }),
    },
);
