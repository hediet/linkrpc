import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
    LinkRpcConnection,
    type TopologyGraph,
    type TrafficEvent,
    type TrafficTransitEvent,
} from '@hediet/linkrpc';
import {
    HubDirectoryExplorer,
} from '@hediet/linkrpc/hub/common';
import type {
    ParticipantDescriptorSource,
    RouteClaim,
} from '@hediet/linkrpc';
import {
    formatFlowSummary,
    TrafficFlowAggregator,
} from '@hediet/linkrpc-hub';
import { TopologyClient, TrafficClient } from '@hediet/linkrpc/hub/client';
import type { CliChannel } from '@hediet/linkrpc-client';
import { formatJson } from '../output';

export interface ParticipantWatchOptions {
    readonly search?: string;
    readonly nodeId?: string;
    readonly format?: 'pretty' | 'plain' | 'jsonl';
    readonly methodPrefix?: string;
    readonly payloadBytes?: number;
    readonly resume?: string | true;
    readonly stop: Promise<void>;
    readonly emit?: (line: string) => void;
}

export interface ParticipantSummary {
    readonly nodeId: string;
    readonly descriptors: readonly ParticipantDescriptorSource[];
    readonly routeClaims: readonly RouteClaim[];
    readonly serviceIds: readonly string[];
    readonly sourceServices: readonly string[];
}

interface InspectionSource {
    readonly serviceId: string;
    readonly graph: TopologyGraph;
}

const TOPOLOGY_INTERFACE = 'linkrpc.topology';

export async function topologyParticipantsCommand(
    channel: CliChannel,
    search?: string,
): Promise<string> {
    const participants = await discoverParticipants(channel);
    const filtered = filterParticipants(participants, search);
    return formatJson(filtered);
}

export async function trafficWatchCommand(
    channel: CliChannel,
    options: ParticipantWatchOptions,
): Promise<void> {
    const emit = options.emit ?? ((line: string) => process.stdout.write(line + '\n'));
    const connection = new LinkRpcConnection(channel);
    const sources = await discoverTopologySources(channel, connection);
    let participants = summarizeParticipants(sources);
    let search = options.search;
    let nodeId = options.nodeId;
    let methodPrefix = options.methodPrefix;
    let payloadBytes = options.payloadBytes;
    let format = options.format;

    if (options.resume !== undefined) {
        const resumed = await readResume(options.resume);
        search ??= resumed.search;
        nodeId ??= resumed.nodeId;
        methodPrefix ??= resumed.methodPrefix;
        payloadBytes ??= resumed.payloadBytes;
        format ??= resumed.format;
    }

    let selected = selectParticipant(filterParticipants(participants, search), nodeId);
    if (selected === undefined && options.nodeId === undefined && search !== undefined) {
        selected = selectParticipant(filterParticipants(participants, search), undefined);
    }
    if (selected === undefined && process.stdin.isTTY && process.stdout.isTTY) {
        const prompted = await promptForParticipant(participants, search);
        selected = prompted?.participant;
        search = prompted?.search ?? search;
    }
    if (selected === undefined) {
        throw new Error(
            'No participant matched. Use --search <regexp> or --node <nodeId>; '
            + 'interactive selection requires a TTY.',
        );
    }

    const serviceId = serviceForParticipant(sources, selected.nodeId);
    if (serviceId === undefined) {
        throw new Error(`Participant ${selected.nodeId} has no addressable service route.`);
    }

    await writeResume(options.resume, {
        search,
        nodeId: selected.nodeId,
        methodPrefix,
        format,
        payloadBytes,
    });

    format ??= process.stdout.isTTY ? 'pretty' : 'plain';
    const session = {
        type: 'session',
        version: 1,
        nodeId: selected.nodeId,
        serviceId,
        search,
        format,
        methodPrefix,
        payloadBytes,
    };
    if (format === 'jsonl') emit(JSON.stringify(session));
    else emit(`Watching participant ${selected.nodeId} via ${serviceId}`);

    let aggregator: TrafficFlowAggregator | undefined;
    if (format === 'pretty') {
        aggregator = new TrafficFlowAggregator({
            onFlow: (flow) => emit(formatFlowSummary(flow)),
        });
    }

    const traffic = new TrafficClient(connection, serviceId);
    const callbacks = {
        onTransit: (event: TrafficTransitEvent) => {
            if (aggregator !== undefined) {
                aggregator.add(event);
            } else if (format === 'jsonl') {
                emit(JSON.stringify({ type: 'transit', event }));
            } else {
                emit(formatTransit(event));
            }
        },
        onOverflow: (event: Extract<TrafficEvent, { type: 'overflow' }>) => {
            emit(format === 'jsonl'
                ? JSON.stringify({ type: 'overflow', event })
                : `traffic overflow: dropped ${event.dropped} events`);
        },
        onError: (error: unknown) => {
            emit(`traffic watch failed: ${error instanceof Error ? error.message : String(error)}`);
        },
    };
    const watch = payloadBytes === undefined
        ? traffic.watch(
            { methodPrefix },
            callbacks,
        )
        : traffic.watchWithPayloads(
            { methodPrefix, maxPayloadBytes: payloadBytes },
            callbacks,
        );

    try {
        await Promise.race([watch.done, options.stop]);
    } finally {
        await watch.cancel('cli-watch-ended');
        aggregator?.flush();
        aggregator?.dispose();
        if (format === 'jsonl') {
            emit(JSON.stringify({ type: 'end', reason: 'stopped' }));
        }
    }
}

async function discoverTopologySources(
    channel: CliChannel,
    connection: LinkRpcConnection,
): Promise<readonly InspectionSource[]> {
    const explorer = new HubDirectoryExplorer(channel, { maxDepth: 5 });
    const result = await explorer.explore();
    const serviceIds = unique(
        result.listings
            .filter((listing) => listing.interfaceId === TOPOLOGY_INTERFACE)
            .map((listing) => listing.serviceId),
    );
    const sources: InspectionSource[] = [];
    for (const serviceId of serviceIds) {
        const graph = await new TopologyClient(connection, serviceId).getGraph();
        sources.push({ serviceId, graph });
    }
    explorer.dispose();
    return sources;
}

async function discoverParticipants(channel: CliChannel): Promise<readonly ParticipantSummary[]> {
    return summarizeParticipants(await discoverTopologySources(channel, new LinkRpcConnection(channel)));
}

function summarizeParticipants(sources: readonly InspectionSource[]): ParticipantSummary[] {
    const byNode = new Map<string, {
        descriptors: unknown[];
        routeClaims: unknown[];
        serviceIds: Set<string>;
        sourceServices: Set<string>;
    }>();
    for (const source of sources) {
        for (const node of source.graph.nodes) {
            const current = byNode.get(node.nodeId) ?? {
                descriptors: [],
                routeClaims: [],
                serviceIds: new Set<string>(),
                sourceServices: new Set<string>(),
            };
            current.descriptors.push(...(node.descriptors ?? []));
            byNode.set(node.nodeId, current);
            current.sourceServices.add(source.serviceId);
        }
        for (const route of source.graph.routes) {
            const current = byNode.get(route.nodeId) ?? {
                descriptors: [],
                routeClaims: [],
                serviceIds: new Set<string>(),
                sourceServices: new Set<string>(),
            };
            current.routeClaims.push(route);
            current.serviceIds.add(route.serviceId);
            byNode.set(route.nodeId, current);
        }
    }
    return [...byNode].map(([nodeId, value]) => ({
        nodeId,
        descriptors: value.descriptors,
        routeClaims: value.routeClaims,
        serviceIds: [...value.serviceIds].sort(),
        sourceServices: [...value.sourceServices].sort(),
    }));
}

function filterParticipants(
    participants: readonly ParticipantSummary[],
    search: string | undefined,
): ParticipantSummary[] {
    if (search === undefined || search.length === 0) return [...participants];
    let expression: RegExp;
    try {
        expression = new RegExp(search, 'i');
    } catch (error) {
        throw new Error(`Invalid participant search regexp: ${error instanceof Error ? error.message : String(error)}`);
    }
    return participants.filter((participant) => expression.test(JSON.stringify(participant)));
}

function selectParticipant(
    participants: readonly ParticipantSummary[],
    nodeId: string | undefined,
): ParticipantSummary | undefined {
    if (nodeId !== undefined) {
        return participants.find((participant) => participant.nodeId === nodeId);
    }
    return participants.length === 1 ? participants[0] : undefined;
}

async function promptForParticipant(
    participants: readonly ParticipantSummary[],
    search: string | undefined,
): Promise<{ participant: ParticipantSummary; search: string } | undefined> {
    const readline = createInterface({ input, output });
    try {
        const query = search ?? await readline.question('Search participants (regexp): ');
        const matches = filterParticipants(participants, query);
        if (matches.length === 0) return undefined;
        for (let i = 0; i < matches.length; i++) {
            output.write(`${i + 1}. ${participantLabel(matches[i])}\n`);
        }
        const answer = await readline.question('Select participant: ');
        const index = Number.parseInt(answer, 10) - 1;
        return Number.isInteger(index) && index >= 0 && matches[index] !== undefined
            ? { participant: matches[index], search: query }
            : undefined;
    } finally {
        readline.close();
    }
}

function participantLabel(participant: ParticipantSummary): string {
    const labels = participant.descriptors
        .flatMap((value) => {
            if (typeof value !== 'object' || value === null) return [];
            const descriptor = (value as { descriptor?: { label?: unknown } }).descriptor;
            return typeof descriptor?.label === 'string' ? [descriptor.label] : [];
        });
    return `${labels[0] ?? participant.nodeId} (${participant.serviceIds.join(', ') || 'no routes'})`;
}

function serviceForParticipant(
    sources: readonly InspectionSource[],
    nodeId: string,
): string | undefined {
    for (const source of sources) {
        const route = source.graph.routes.find((candidate) => candidate.nodeId === nodeId);
        if (route !== undefined) return route.serviceId;
        if (source.graph.entryNodeId === nodeId) return source.serviceId;
    }
    return undefined;
}

function formatTransit(event: TrafficTransitEvent): string {
    const direction = event.in !== undefined && event.out !== undefined
        ? 'forward'
        : event.in !== undefined ? 'in' : 'out';
    return `${event.ts} ${direction} ${event.kind} ${event.method ?? '(unknown)'}`;
}

interface ResumeState {
    readonly search?: string;
    readonly nodeId?: string;
    readonly methodPrefix?: string;
    readonly format?: 'pretty' | 'plain' | 'jsonl';
    readonly payloadBytes?: number;
}

async function readResume(value: string | true): Promise<ResumeState> {
    const { readFile } = await import('node:fs/promises');
    const path = value === true ? '.linkrpc-watch.json' : value;
    try {
        return JSON.parse(await readFile(path, 'utf8')) as ResumeState;
    } catch (error) {
        throw new Error(`Cannot resume from ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function writeResume(value: string | true | undefined, state: ResumeState): Promise<void> {
    if (value === undefined) return;
    const { writeFile } = await import('node:fs/promises');
    const path = value === true ? '.linkrpc-watch.json' : value;
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}
