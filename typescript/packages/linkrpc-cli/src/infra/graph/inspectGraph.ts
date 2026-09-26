import { stdout } from "node:process";
import {
    createSchemaToZod,
    interfaceTemplateMemberName,
    INTERFACE_TEMPLATES_EXTENSION,
    type JsonValue,
    type LinkRpcInterfaceSchema,
    type InterfaceTemplateArgument,
    type InterfaceTemplatesMetadata,
} from "@hediet/linkrpc";
import {
    IMMUTABLE_GRAPH_INTERFACE_ID,
    ROOT_WATCH_INTERFACE_ID,
    validateGraphInterfaceSchema,
    graphPresentationSchema,
} from "@hediet/linkrpc-infra/graph";
import type { DiscoveredListing } from "@hediet/linkrpc/hub/common";
import type { CliChannel } from "@hediet/linkrpc-client";
import { GraphTerminal } from "./inspectGraphTerminal";
import { GraphTimings, type GraphTiming } from "./inspectGraphTiming";
import {
    GraphLoader,
    GraphObjectCache,
    graphRefKey,
    parseGraphRef,
    withTimeout,
    type GraphBatchFetch,
    type GraphRef,
} from "./inspectGraphModel";
import {
    GraphExplorerModel,
    loadGraphDepth,
    renderGraphJson,
    renderGraphTree,
} from "./inspectGraphView";

export interface GraphTarget {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash: string;
    readonly graphInterfaceId: string;
    readonly root: string;
    readonly watchMethod: string;
    readonly batchMethod: string;
    readonly paramsArgument: InterfaceTemplateArgument;
    readonly refArgument: InterfaceTemplateArgument;
    readonly valueArgument: InterfaceTemplateArgument;
    readonly presentationMethod?: string;
}

export interface InspectGraphOptions {
    readonly targets: readonly GraphTarget[];
    readonly onModel?: (model: GraphExplorerModel, version: number) => void | Promise<void>;
    readonly onUpdating?: () => void | Promise<void>;
    readonly logTiming?: boolean;
    readonly onTiming?: (timing: GraphTiming) => void;
    readonly serviceId?: string;
    readonly interfaceId?: string;
    readonly root?: string;
    readonly params?: unknown;
    readonly depth?: number;
    readonly path?: string;
    readonly watch?: boolean;
    readonly json?: boolean;
    readonly maxObjects?: number;
    readonly maxBytes?: number;
    readonly maxRounds?: number;
    readonly timeoutMs?: number;
    readonly interactive?: boolean;
    readonly stop?: Promise<void>;
    readonly emit?: (text: string) => void;
    readonly repaint?: (text: string) => void;
}

export interface GraphDiscovery {
    readonly targets: readonly GraphTarget[];
    readonly warnings: readonly string[];
}

interface GraphRootDescriptor {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash: string;
    readonly root: string;
    readonly watchMethod: string;
    readonly paramsArgument: InterfaceTemplateArgument;
    readonly refArgument: InterfaceTemplateArgument;
}

interface GraphStoreDescriptor {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash: string;
    readonly batchMethod: string;
    readonly refArgument: InterfaceTemplateArgument;
    readonly valueArgument: InterfaceTemplateArgument;
}

export function graphDescriptorsFromSchema(
    listing: DiscoveredListing,
    schema: LinkRpcInterfaceSchema,
): {
    readonly roots: readonly GraphRootDescriptor[];
    readonly stores: readonly GraphStoreDescriptor[];
} {
    const metadata = schema[INTERFACE_TEMPLATES_EXTENSION] as InterfaceTemplatesMetadata | undefined;
    if (metadata === undefined) return { roots: [], stores: [] };
    validateGraphInterfaceSchema(schema);
    const graphInstances = metadata.instances.filter((instance) =>
        metadata.templates[instance.template]?.id === IMMUTABLE_GRAPH_INTERFACE_ID);
    const rootInstances = metadata.instances.filter((instance) =>
        metadata.templates[instance.template]?.id === ROOT_WATCH_INTERFACE_ID);
    return {
        roots: rootInstances.map((root) => ({
            serviceId: listing.serviceId,
            interfaceId: listing.interfaceId,
            hash: listing.hash,
            root: root.name,
            watchMethod: wireMethod(listing.serviceId, listing.interfaceId, interfaceTemplateMemberName(root, 'watch')),
            paramsArgument: requiredArgument(root.arguments, "params", root.name),
            refArgument: requiredArgument(root.arguments, "ref", root.name),
        })),
        stores: graphInstances.map((graph) => ({
            serviceId: listing.serviceId,
            interfaceId: listing.interfaceId,
            hash: listing.hash,
            batchMethod: wireMethod(listing.serviceId, listing.interfaceId, interfaceTemplateMemberName(graph, 'batchObjGet')),
            refArgument: requiredArgument(graph.arguments, "ref", graph.name),
            valueArgument: requiredArgument(graph.arguments, "value", graph.name),
        })),
    };
}

export async function inspectGraphCommand(
    channel: CliChannel,
    options: InspectGraphOptions,
): Promise<string> {
    const discovery: GraphDiscovery = { targets: options.targets, warnings: [] };
    const target = selectGraphTarget(discovery.targets, options);
    if (target === undefined) {
        return renderGraphTargetList(discovery);
    }
    const params = validateSchemaValue(options.params === undefined ? {} : options.params, target.paramsArgument, "root params");
    const refValidator = schemaValidator(target.refArgument);
    const valueValidator = schemaValidator(target.valueArgument);
    const timings = options.onTiming !== undefined || options.logTiming
        ? new GraphTimings(options.onTiming ?? (timing => {
            process.stderr.write(`linkrpc: timing ${JSON.stringify(timing)}\n`);
        }))
        : undefined;
    const fetch: GraphBatchFetch = async (request, signal) => {
        const call = channel.sendRequestWithStream(target.batchMethod, {
            needs: request.needs.map(({ ref, paths }) => ({ ref, paths: [...paths] })),
            have: request.have.map(item => ({ ...item })),
            limits: { ...request.limits },
        });
        const cancel = (): void => {
            call.cancel("graph batch cancelled");
            call.dispose?.();
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
            const result = await call.result;
            validateBatchPayload(result, refValidator, valueValidator);
            return result;
        } finally {
            signal.removeEventListener("abort", cancel);
            call.dispose?.();
        }
    };
    const cancellation = new AbortController();
    const loader = new GraphLoader(fetch, new GraphObjectCache(), { ...options, timings, signal: cancellation.signal });
    const emit = options.emit ?? ((text) => stdout.write(`${text}\n`));
    const interactive = options.interactive === true;
    const navigable = interactive || options.onModel !== undefined;
    let firstOutput = "";
    let currentModel: GraphExplorerModel | undefined;
    const terminal = interactive
        ? new GraphTerminal(`${target.serviceId || "local"} / ${target.interfaceId} / ${target.root}`, JSON.stringify(params), options.repaint, timings)
        : undefined;
    const stopRequested = terminal !== undefined
        ? options.stop === undefined ? terminal.result : Promise.race([terminal.result, options.stop])
        : options.stop;
    const stop = stopRequested?.then(() => { cancellation.abort(); });
    try {
        await watchRoots(channel, target, params as JsonValue, stop, options.timeoutMs ?? 5_000, async ({ version, ref }, call) => {
            const refresh = async () => {
                await terminal?.beginUpdate();
                await options.onUpdating?.();
                cancellation.signal.throwIfAborted();
                validateWith(refValidator, ref, "root watch ref");
                if (options.path !== undefined) {
                    await loader.load([{ ref, paths: [normalizeGraphPath(options.path)] }]);
                } else {
                    if (navigable && currentModel !== undefined) await currentModel.prefetchExpanded(ref);
                    await loadGraphDepth(ref, loader, options.depth ?? (navigable ? 0 : 2));
                }
                const presentation = options.json || target.presentationMethod === undefined ? undefined
                    : await withTimeout(async signal => {
                        const call = channel.sendRequestWithStream(target.presentationMethod!, {});
                        const cancel = () => { call.cancel("graph presentation cancelled"); call.dispose?.(); };
                        signal.addEventListener("abort", cancel, { once: true });
                        try { return graphPresentationSchema.parse(await call.result); }
                        finally { signal.removeEventListener("abort", cancel); call.dispose?.(); }
                    }, options.timeoutMs ?? 5_000, "graph presentation", cancellation.signal);
                const model = new GraphExplorerModel(ref, loader, navigable ? undefined : options.depth, navigable
                    ? currentModel === undefined ? undefined : {
                        selectedKey: currentModel.selectedKey,
                        expanded: currentModel.expandedKeys,
                        expandedPaths: currentModel.expandedPaths,
                    }
                    : { expanded: new Set(loader.cache.have().map((item) => graphRefKey(item.ref))) }, timings, presentation);
                await model.loadPresentation();
                cancellation.signal.throwIfAborted();
                if (options.onModel !== undefined) {
                    await options.onModel(model, version);
                } else if (terminal !== undefined) {
                    const restore = () => terminal.finishUpdate(model, version, cancellation.signal);
                    await (timings?.measureAsync("restore", restore, { version }) ?? restore());
                } else {
                    const render = () => options.json === true
                        ? renderGraphJson(ref, loader)
                        : renderGraphTree(model);
                    const rendered = timings?.measureSync("output", render, { version }) ?? render();
                    if (options.watch === true) emit(options.json === true ? JSON.stringify(JSON.parse(rendered)) : rendered);
                    else firstOutput = rendered;
                }
                await call.send({ accept: version });
                currentModel = model;
                return interactive || options.watch === true;
            };
            return timings?.measureAsync("refresh", refresh, { version }) ?? refresh();
        });
    } catch (error) {
        if (!cancellation.signal.aborted) throw error;
    } finally {
        cancellation.abort();
        terminal?.dispose();
    }
    for (const warning of discovery.warnings) {
        process.stderr.write(`linkrpc: ${warning}\n`);
    }
    return firstOutput;
}

export function selectGraphTarget(
    targets: readonly GraphTarget[],
    options: Pick<InspectGraphOptions, "serviceId" | "interfaceId" | "root">,
): GraphTarget | undefined {
    if (
        options.serviceId === undefined
        && options.interfaceId === undefined
        && options.root === undefined
    ) {
        return undefined;
    }
    const matches = targets.filter((target) =>
        (options.serviceId === undefined || target.serviceId === options.serviceId)
        && (options.interfaceId === undefined || target.interfaceId === options.interfaceId)
        && (options.root === undefined || target.root === options.root));
    if (matches.length === 0) {
        if (options.serviceId !== undefined || options.interfaceId !== undefined || options.root !== undefined) {
            throw new Error("No graph root matches the requested service, interface, and root selectors");
        }
        return undefined;
    }
    if (matches.length > 1) {
        throw new Error(
            `Graph selection is ambiguous (${matches.length} roots); specify --service, --interface, and --root`,
        );
    }
    return matches[0];
}

export function renderGraphTargetList(discovery: GraphDiscovery): string {
    if (discovery.targets.length === 0) {
        const suffix = discovery.warnings.length === 0
            ? ""
            : `\n${discovery.warnings.map((warning) => `warning: ${warning}`).join("\n")}`;
        return `No graph-capable reflected interface templates found.${suffix}`;
    }
    return [
        "Available graph roots:",
        ...discovery.targets.map((target) =>
            `  ${target.serviceId || "<root>"}::${target.interfaceId} root=${target.root} `
            + `objects=${target.graphInterfaceId}`),
        ...discovery.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n");
}

interface RootOffer {
    readonly version: number;
    readonly ref: GraphRef;
}

export async function watchRoots(
    channel: Pick<CliChannel, "sendRequestWithStream">,
    target: GraphTarget,
    params: JsonValue,
    stop: Promise<void> | undefined,
    timeoutMs: number,
    onOffer: (
        offer: RootOffer,
        call: ReturnType<CliChannel["sendRequestWithStream"]>,
    ) => Promise<boolean>,
): Promise<void> {
    let queue = Promise.resolve(true);
    let received = false;
    let resolveFirst!: () => void;
    let rejectFirst!: (error: unknown) => void;
    const first = new Promise<void>((resolve, reject) => {
        resolveFirst = resolve;
        rejectFirst = reject;
    });
    let fail!: (error: unknown) => void;
    const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
    const timer = setTimeout(() => {
        if (!received) fail(new Error(`Graph root watch produced no root within ${timeoutMs}ms`));
    }, timeoutMs);
    let call!: ReturnType<CliChannel["sendRequestWithStream"]>;
    call = channel.sendRequestWithStream(target.watchMethod, params, {
        onStreamMessage: (payload) => {
            queue = queue.then(async (keepWatching) => {
                if (!keepWatching) return false;
                const offer = parseRootOffer(payload);
                received = true;
                const keep = await onOffer(offer, call);
                resolveFirst();
                return keep;
            }).catch((error: unknown) => {
                rejectFirst(error);
                fail(error);
                return false;
            });
        },
    });
    const stopped = stop?.then(() => "stop" as const);
    try {
        const outcome = await Promise.race([
            first.then(() => "first" as const),
            call.result.then(() => "result" as const),
            failed,
            ...(stopped === undefined ? [] : [stopped]),
        ]);
        if (outcome === "result" && !received) {
            throw new Error("Graph root watch ended before offering a root");
        }
        if (outcome === "first" && await queue) {
            await Promise.race([call.result, failed, ...(stopped === undefined ? [] : [stopped])]);
        }
        await queue;
    } finally {
        clearTimeout(timer);
        call.cancel("graph explorer finished");
        call.dispose?.();
    }
}

function validateBatchPayload(
    value: JsonValue,
    refValidator: ReturnType<typeof schemaValidator>,
    valueValidator: ReturnType<typeof schemaValidator>,
): void {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new Error("graph batch result must be an object");
    }
    if (!Array.isArray(value.objects)) return;
    value.objects.forEach((object, index) => {
        if (object === null || Array.isArray(object) || typeof object !== "object") return;
        validateWith(refValidator, object.ref, `graph batch objects[${index}].ref`);
        validateWith(valueValidator, object.value, `graph batch objects[${index}].value`);
    });
}

function schemaValidator(argument: InterfaceTemplateArgument) {
    return createSchemaToZod(argument.components?.schemas ?? {}).toZod(argument.schema);
}

function validateSchemaValue(
    value: unknown,
    argument: InterfaceTemplateArgument,
    location: string,
): unknown {
    const validator = schemaValidator(argument);
    validateWith(validator, value, location);
    return value;
}

function validateWith(
    validator: ReturnType<typeof schemaValidator>,
    value: unknown,
    location: string,
): void {
    const result = validator.safeParse(value);
    if (!result.success) {
        throw new Error(`${location} does not match its reflected schema: ${result.error.message}`);
    }
}

function parseRootOffer(value: JsonValue): RootOffer {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new Error("root watch event must be an object");
    }
    if (typeof value.version !== "number" || !Number.isSafeInteger(value.version)) {
        throw new Error("root watch event.version must be a safe integer");
    }
    return { version: value.version, ref: parseGraphRef(value.ref, "root watch event.ref") };
}

function requiredArgument(
    args: Readonly<Record<string, InterfaceTemplateArgument>>,
    name: string,
    instance: string,
): InterfaceTemplateArgument {
    const argument = args[name];
    if (argument === undefined) {
        throw new Error(`Graph template instance "${instance}" is missing schema argument "${name}"`);
    }
    return argument;
}

function wireMethod(serviceId: string, interfaceId: string, member: string): string {
    return serviceId.length === 0
        ? `${interfaceId}::${member}`
        : `${serviceId}::${interfaceId}::${member}`;
}

function normalizeGraphPath(path: string): string {
    if (path === "/") return path;
    if (!path.startsWith("/")) throw new Error("--path must be a JSON pointer beginning with '/'");
    return path;
}
