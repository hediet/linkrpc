import {
    LinkRpcConnection,
    base64UrlToBytes,
    bytesToBase64Url,
    CapabilityIssuanceError,
    issueCapability,
    getDelegationRootIds,
    jcsCanonicalize,
    prepareCapabilityIssuance,
    signedHash,
    type CapabilityIssuancePlan,
    type Permission,
    type Principal,
    type SignedCapability,
    TransportPair,
    type SigningCallCtx,
    type SigningIdentity,
} from '@hediet/linkrpc';
import {
    HubDirectoryExplorer,
    hubAccessManifestInterface,
    type HubAccessManifestDecision,
    type HubAccessManifestRequest,
    type IHubAccessManifest,
} from '@hediet/linkrpc/hub/common';
import {
    AggregatingHubAccessManifest,
    registerAggregatingManifest,
    type AggregatorSource,
} from './aggregatingManifest';
import { ApproveClient } from './approveClient';
import { buildSlotPermissions } from './permissions';
import { describePermissions, toSignedPermissions, type ConsentPrompt } from './consent';
import { durationToExp, type AccessDurationName, type AccessDirectPermission } from './accessTypes';
import {
    candidatesForSlot,
    type AccessSlotRequest,
    type DirectoryEntry,
} from './accessCandidates';
import { autorun, derived, observableValue, type IObservable } from '@vscode/observables';

/**
 * The only authority an approval command needs for inspecting and updating
 * manifests across a federated Hub.
 */
export const approvalPermissions: readonly Permission[] = [
    {
        target: {
            serviceId: { prefix: '' },
            interfaceId: { exact: 'hubAccessManifest' },
            members: [{ prefix: '' }],
        },
        canInvoke: true,
    },
    {
        target: {
            serviceId: { prefix: '' },
            interfaceId: { exact: 'hubrpc.directory' },
            members: [{ prefix: '' }],
        },
        canInvoke: true,
    },
];

const approvalPermissionsJson = jcsCanonicalize(approvalPermissions);

/**
 * Installs narrow discovery capabilities for direct and delegated authority.
 * Reuses matching grants to avoid growing the bag on every refresh.
 */
export async function bootstrapApprovalCapability(
    principal: Principal,
    log?: (line: string) => void,
): Promise<SignedCapability> {
    let direct = principal.capBag.capabilities.find((capability) =>
        capability.issuer === principal.id
        && capability.audience === principal.id
        && capability.expiresAtMs === undefined
        && capability.parentHash === undefined
        && jcsCanonicalize(capability.permissions) === approvalPermissionsJson
    );
    if (!direct) {
        direct = await issueCapability(principal.identity, {
            audience: principal.identity.publicSigningIdentity,
            permissions: approvalPermissions,
        });
        await principal.capBag.add(direct);
    }
    for (const root of await getDelegationRootIds(principal.identity, principal.capBag.capabilities)) {
        if (root === principal.id) continue;
        let plan: CapabilityIssuancePlan;
        try {
            plan = await prepareCapabilityIssuance(principal.identity, {
                audience: principal.id,
                permissions: approvalPermissions,
                capabilities: principal.capBag.capabilities,
                acceptableRootIds: [root],
            });
        } catch (error) {
            if (!(error instanceof CapabilityIssuanceError) || error.code !== 'insufficientAuthority') throw error;
            log?.(`approval: delegation rooted at '${root}' does not cover discovery: ${error.message}`);
            continue;
        }
        const cached = plan.proposals.every((proposal) => principal.capBag.capabilities.some((capability) =>
            capability.issuer === principal.id
            && capability.audience === principal.id
            && capability.parentHash === proposal.parentHash
            && capability.expiresAtMs === proposal.expiresAtMs
            && jcsCanonicalize(capability.permissions) === jcsCanonicalize(proposal.permissions)
        ));
        if (cached) continue;
        const known = new Set(principal.capBag.capabilities.map((capability) => signedHash('capability', capability)));
        await principal.capBag.add(...(await plan.issue()).filter((capability) =>
            !known.has(signedHash('capability', capability))));
    }
    return direct;
}

const MANIFEST_INTERFACE_ID = hubAccessManifestInterface.info.id;
const AGGREGATE_SERVICE_ID = 'linkrpc-cli.approvals';
const EXTERNAL_ID_PREFIX = 'ar1_';

export interface PendingApprovalRequest {
    readonly id: string;
    readonly request: HubAccessManifestRequest;
    /** Manifest revision containing the request rendered to the operator. */
    readonly revision: number;
    /** Service ID of the hubAccessManifest that supplied this request. */
    readonly sourceServiceId?: string;
}

export type ApprovalDecisionOutcome = 'applied' | 'still-pending';

export interface PreparedApproval {
    readonly pending: PendingApprovalRequest;
    /** Exact permissions that will be signed, including one-shot call binding. */
    readonly permissions: readonly Permission[];
    readonly capabilityProposals?: CapabilityIssuancePlan['proposals'];
    readonly resolvedSlot?: {
        readonly serviceId: string;
        readonly satisfiedInterfaces: readonly string[];
    };
}

export interface ApprovalSnapshot {
    readonly state: 'connecting' | 'live' | 'stale';
    readonly requests: readonly PendingApprovalRequest[];
    readonly error?: string;
}

export interface ApprovalClientOptions {
    readonly manifest: IHubAccessManifest;
    readonly identity: SigningIdentity;
    readonly getCapabilities?: () => readonly SignedCapability[];
    readonly fetchDirectory?: () => Promise<readonly DirectoryEntry[]>;
    readonly log?: (line: string) => void;
    readonly dispose?: () => void;
    readonly timeoutMs?: number;
    readonly sourceErrors?: IObservable<readonly string[]>;
    readonly refreshAuthority?: () => Promise<unknown>;
}

export interface CreateApprovalClientOptions {
    /** A connection signing calls with this principal and its live capability bag. */
    readonly connection: LinkRpcConnection<unknown, SigningCallCtx>;
    readonly principal: Principal;
    readonly log?: (line: string) => void;
}

export async function createApprovalClient(options: CreateApprovalClientOptions): Promise<ApprovalClient> {
    await bootstrapApprovalCapability(options.principal, options.log);
    return createHubApprovalClient(
        options.connection,
        options.principal.identity,
        options.log,
        () => options.principal.capBag.capabilities,
        () => bootstrapApprovalCapability(options.principal, options.log),
    );
}

/**
 * UI-independent approval operations over the hub's shared manifest frontend.
 * The underlying {@link ApproveClient} remains authoritative for snapshots and
 * acknowledgement. Interactive and one-shot commands use the same prepared
 * authority and acknowledged decision path.
 */
export class ApprovalClient {
    private readonly _principalId: string;
    private readonly _manifest: IHubAccessManifest;
    private readonly _client: ApproveClient;
    private readonly _identity: SigningIdentity;
    private readonly _getCapabilities: () => readonly SignedCapability[];
    private readonly _refreshAuthority: ApprovalClientOptions['refreshAuthority'];
    private readonly _prepared = new WeakMap<PreparedApproval, {
        readonly plan: CapabilityIssuancePlan;
        readonly fingerprint: string;
    }>();
    private readonly _fetchDirectory: ApprovalClientOptions['fetchDirectory'];
    private readonly _log: (line: string) => void;
    private readonly _disposeExtra: (() => void) | undefined;
    private readonly _lastClientError = observableValue<string | undefined>(this, undefined);
    private readonly _disposeAbort = new AbortController();
    private _disposed = false;
    public readonly snapshot: IObservable<ApprovalSnapshot>;

    constructor(options: ApprovalClientOptions) {
        this._principalId = options.identity.publicSigningIdentity.principal;
        this._manifest = options.manifest;
        this._identity = options.identity;
        this._getCapabilities = options.getCapabilities ?? (() => []);
        this._refreshAuthority = options.refreshAuthority;
        this._fetchDirectory = options.fetchDirectory;
        this._log = options.log ?? (() => { /* quiet */ });
        this._disposeExtra = options.dispose;
        this._client = new ApproveClient({
            manifest: this._manifest,
            ownPrincipalId: this._principalId,
            getDelegationRootIds: () => getDelegationRootIds(this._identity, this._getCapabilities()),
            timeoutMs: options.timeoutMs,
            log: (line) => {
                this._lastClientError.set(line, undefined);
                this._log(line);
            },
        });
        this.snapshot = derived((reader) => {
            const state = this._client.state.read(reader);
            const error = this._lastClientError.read(reader);
            const sourceErrors = options.sourceErrors?.read(reader) ?? [];
            return {
                state: sourceErrors.length > 0 ? 'stale' : state,
                requests: this._toPendingRequests(this._client.requests.read(reader)),
                ...(sourceErrors.length > 0
                    ? { error: sourceErrors.join('\n') }
                    : state === 'stale' && error !== undefined ? { error } : {}),
            };
        });
    }

    public get principalId(): string {
        return this._principalId;
    }

    public async requests(): Promise<readonly PendingApprovalRequest[]> {
        return this._toPendingRequests(await this._currentRequests());
    }

    /** Force an immediate manifest reconciliation. */
    public async refresh(): Promise<void> {
        await this._currentRequests();
    }

    public async deny(
        externalId: string,
        reason?: string,
        expected?: PendingApprovalRequest,
    ): Promise<ApprovalDecisionOutcome> {
        const internalId = decodeApprovalRequestId(externalId);
        const pending = await this._requirePending(internalId, externalId);
        if (expected !== undefined) this._requireUnchanged(pending, expected);
        const result = await this._client.decide(internalId, {
            status: 'denied',
            ...(reason !== undefined ? { reason } : {}),
        });
        if (result === 'gone') {
            throw new Error(`approval request '${externalId}' is no longer pending`);
        }
        return result;
    }

    public async approve(externalId: string): Promise<ApprovalDecisionOutcome> {
        return this.approvePrepared(await this.prepareApproval(externalId));
    }

    /**
     * Resolve the exact authority that an approval will mint. Interactive
     * surfaces render this result before asking for confirmation.
     */
    public async prepareApproval(externalId: string): Promise<PreparedApproval> {
        const internalId = decodeApprovalRequestId(externalId);
        const pending = await this._requirePending(internalId, externalId);
        const resolved = await this._resolveRequest(pending.request);
        if ('denied' in resolved) {
            throw new Error(`approval request '${externalId}' cannot be granted: ${resolved.denied}`);
        }
        const sourceServiceId = approvalRequestSource(internalId);
        const permissions = await toSignedPermissions(
            resolved.permissions,
            pending.request.consumer.principal,
            pending.request.duration,
        );
        const plan = await prepareCapabilityIssuance(this._identity, {
            audience: pending.request.consumer.principal,
            permissions,
            capabilities: this._getCapabilities(),
            acceptableRootIds: pending.request.acceptableRootIds,
            expiresAtMs: durationToExp(pending.request.duration as AccessDurationName | undefined),
        });
        const prepared: PreparedApproval = {
            pending: {
                id: externalId,
                request: pending.request,
                revision: pending.revision,
                ...(sourceServiceId === undefined ? {} : { sourceServiceId }),
            },
            permissions,
            capabilityProposals: plan.proposals,
            ...(resolved.resolvedSlot === undefined ? {} : { resolvedSlot: resolved.resolvedSlot }),
        };
        this._prepared.set(prepared, { plan, fingerprint: jcsCanonicalize(prepared) });
        return prepared;
    }

    /** Approve only if the request is still exactly the one that was reviewed. */
    public async approvePrepared(prepared: PreparedApproval): Promise<ApprovalDecisionOutcome> {
        return this._approvePrepared(prepared);
    }

    private async _approvePrepared(
        prepared: PreparedApproval,
        capabilities?: readonly SignedCapability[],
    ): Promise<ApprovalDecisionOutcome> {
        const externalId = prepared.pending.id;
        const internalId = decodeApprovalRequestId(externalId);
        const pending = await this._requirePending(internalId, externalId);
        this._requireUnchanged(pending, prepared.pending);
        const decision = await this._grantDecision(prepared, capabilities);
        // Await the authoritative post-write snapshot before the CLI prints success.
        const result = await this._client.decide(internalId, decision);
        if (result === 'gone') {
            throw new Error(`approval request '${externalId}' is no longer pending`);
        }
        if (decision.status !== 'granted') {
            throw new Error(
                `approval request '${externalId}' could not be granted`
                + (decision.reason !== undefined ? `: ${decision.reason}` : ''),
            );
        }
        return result;
    }

    public async runInteractive(signal: AbortSignal, prompt: ConsentPrompt): Promise<void> {
        signal = AbortSignal.any([signal, this._disposeAbort.signal]);
        if (signal.aborted) return;
        await this._currentRequests();
        const ask = prompt;
        const inFlight = new Map<string, { abort: AbortController; request: string }>();
        let tail = Promise.resolve();
        const subscription = autorun((reader) => {
            const snapshot = this.snapshot.read(reader);
            if (signal.aborted || this._disposed) return;
            const present = new Map(snapshot.requests.map((item) => [item.id, jcsCanonicalize(item.request)]));
            for (const [id, running] of inFlight) {
                if (present.get(id) !== running.request) {
                    running.abort.abort();
                    inFlight.delete(id);
                }
            }
            if (snapshot.state !== 'live') return;
            for (const pending of snapshot.requests) {
                if (inFlight.has(pending.id)) continue;
                const running = { abort: new AbortController(), request: jcsCanonicalize(pending.request) };
                inFlight.set(pending.id, running);
                tail = tail.then(async () => {
                    if (running.abort.signal.aborted) return;
                    try {
                        const prepared = await this.prepareApproval(pending.id);
                        if (running.abort.signal.aborted) return;
                        const decision = await ask({
                            requestId: pending.id,
                            kind: pending.request.kind === 'discover' ? 'request' : 'requestAccess',
                            consumer: pending.request.consumer,
                            consumerPrincipalId: pending.request.consumer.principal,
                            permissions: prepared.permissions,
                            grants: describePermissions(prepared.permissions),
                            duration: pending.request.duration,
                            signal: running.abort.signal,
                        });
                        if (running.abort.signal.aborted) return;
                        if (decision.grant) {
                            await this._approvePrepared(prepared, decision.capabilities);
                        } else {
                            await this.deny(pending.id, decision.reason, prepared.pending);
                        }
                    } catch (error) {
                        if (!running.abort.signal.aborted) {
                            this._log(`approval: failed to decide '${pending.id}': ${error instanceof Error ? error.message : String(error)}`);
                        }
                    } finally {
                        if (inFlight.get(pending.id) === running) inFlight.delete(pending.id);
                    }
                });
            }
        });
        try {
            await waitForAbort(signal);
        } finally {
            subscription.dispose();
            for (const running of inFlight.values()) running.abort.abort();
        }
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._disposeAbort.abort();
        this._client.dispose();
        this._disposeExtra?.();
    }

    private async _currentRequests() {
        await this._refreshAuthority?.();
        await this._client.refresh();
        const snapshot = this.snapshot.get();
        if (snapshot.state === 'stale') {
            throw new Error(snapshot.error ?? 'could not read pending approval requests');
        }
        return this._client.requests.get();
    }

    private _toPendingRequests(
        requests: readonly {
            readonly id: string;
            readonly request: HubAccessManifestRequest;
            readonly revision: number;
        }[],
    ): readonly PendingApprovalRequest[] {
        return requests
            .map(({ id, request, revision }) => {
                const sourceServiceId = approvalRequestSource(id);
                return {
                    id: encodeApprovalRequestId(id),
                    request,
                    revision,
                    ...(sourceServiceId === undefined ? {} : { sourceServiceId }),
                };
            })
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    private async _requirePending(
        internalId: string,
        externalId: string,
    ): Promise<{ readonly id: string; readonly request: HubAccessManifestRequest; readonly revision: number; }> {
        const requests = await this._currentRequests();
        const pending = requests.find((request) => request.id === internalId);
        if (!pending) {
            throw new Error(
                `approval request '${externalId}' is not pending for principal '${this._principalId}'`,
            );
        }
        return pending;
    }

    private _requireUnchanged(
        actual: { readonly request: HubAccessManifestRequest; readonly revision: number; },
        expected: PendingApprovalRequest,
    ): void {
        if (jcsCanonicalize(actual.request) !== jcsCanonicalize(expected.request)) {
            throw new Error(
                `approval request '${expected.id}' changed after it was reviewed; review it again`,
            );
        }
    }

    private async _resolveRequest(
        request: HubAccessManifestRequest,
    ): Promise<
        | {
            readonly permissions: readonly AccessDirectPermission[];
            readonly resolvedSlot?: {
                readonly serviceId: string;
                readonly satisfiedInterfaces: readonly string[];
            };
        }
        | { readonly denied: string; }
    > {
        let permissions: readonly AccessDirectPermission[];
        let resolvedSlot:
            | { readonly serviceId: string; readonly satisfiedInterfaces: readonly string[]; }
            | undefined;
        if (request.kind === 'direct') {
            permissions = request.permissions as readonly AccessDirectPermission[];
        } else {
            if (this._fetchDirectory === undefined) {
                return { denied: 'no directory available to resolve discover candidates' };
            }
            const slot: AccessSlotRequest = {
                interfaces: request.interfaces.map((item) => ({
                    id: item.id,
                    required: item.required !== false,
                    ...(item.hash !== undefined ? { hash: item.hash } : {}),
                })),
                members: (request.members ?? []).map((item) => ({
                    interfaceId: item.interfaceId,
                    member: item.member,
                    required: item.required !== false,
                })),
            };
            const candidate = candidatesForSlot(slot, await this._fetchDirectory())[0];
            if (!candidate) {
                return { denied: 'no candidate service satisfies the requested interfaces' };
            }
            const present = new Set(candidate.satisfiedInterfaces.map((item) => item.id));
            permissions = buildSlotPermissions(
                candidate.serviceId,
                slot.interfaces,
                slot.members,
                present,
            ) as AccessDirectPermission[];
            resolvedSlot = {
                serviceId: candidate.serviceId,
                satisfiedInterfaces: candidate.satisfiedInterfaces.map((item) => item.id),
            };
        }
        return {
            permissions,
            ...(resolvedSlot === undefined ? {} : { resolvedSlot }),
        };
    }

    private async _grantDecision(
        prepared: PreparedApproval,
        overrideCapabilities?: readonly SignedCapability[],
    ): Promise<HubAccessManifestDecision> {
        const recorded = this._prepared.get(prepared);
        if (!recorded || recorded.fingerprint !== jcsCanonicalize(prepared)) {
            throw new Error('Prepared approval was modified or belongs to a different client; review it again');
        }
        const capabilities = overrideCapabilities?.length
            ? [...overrideCapabilities]
            : await recorded.plan.issue();
        return {
            status: 'granted',
            granted: prepared.resolvedSlot === undefined
                ? { kind: 'direct', capabilities }
                : {
                    kind: 'discover',
                    serviceId: prepared.resolvedSlot.serviceId,
                    satisfiedInterfaces: [...prepared.resolvedSlot.satisfiedInterfaces],
                    capabilities,
                },
        };
    }
}

/**
 * Discover every manifest in the connected hub and expose it through one
 * validated, namespaced aggregate. This is the same discovery/validation path
 * used by the hub's approval UI.
 */
export function createHubApprovalClient(
    connection: LinkRpcConnection<unknown, SigningCallCtx>,
    identity: SigningIdentity,
    log?: (line: string) => void,
    getCapabilities?: () => readonly SignedCapability[],
    refreshAuthority?: () => Promise<unknown>,
): ApprovalClient {
    const explorer = new HubDirectoryExplorer(connection.channel);
    const sourceCache = new Map<string, AggregatorSource>();
    const errorsBySource = new Map<string, string>();
    const sourceErrors = observableValue<readonly string[]>('approvalSourceErrors', []);
    const directoryErrors = observableValue<readonly string[]>('approvalDirectoryErrors', []);
    const discoveryErrors = derived((reader) => [
        ...directoryErrors.read(reader), ...sourceErrors.read(reader),
    ]);
    const updateDirectoryHealth = () => {
        const graph = explorer.graphSnapshot;
        directoryErrors.set([graph.root, ...graph.directories].flatMap((node) =>
            node.inaccessibleReason === undefined ? [] : [
                `approval: directory discovery failed: ${node.inaccessibleReason}`,
            ]), undefined);
    };
    let directoryChanged: (() => void) | undefined;
    const watchStarted = explorer.watch(() => {
        updateDirectoryHealth();
        directoryChanged?.();
    });
    const fetchDirectory = async (): Promise<readonly DirectoryEntry[]> => {
        await watchStarted;
        updateDirectoryHealth();
        return explorer.result.listings.map((entry) => ({
            serviceId: entry.serviceId,
            interfaceId: entry.interfaceId,
            hash: entry.hash,
            ...(entry.serviceDescription === undefined
                ? {}
                : { serviceDescription: entry.serviceDescription }),
            ...(entry.rootPrincipalSets === undefined
                ? {}
                : { rootPrincipalSets: entry.rootPrincipalSets }),
        }));
    };
    const resolveSources = async () => {
        const directory = await fetchDirectory();
        const serviceIds = [...new Set(
            directory
                .filter((entry) => entry.interfaceId === MANIFEST_INTERFACE_ID)
                .map((entry) => entry.serviceId),
        )].sort();
        log?.(
            `approval: discovered ${serviceIds.length} manifest source`
            + `${serviceIds.length === 1 ? '' : 's'}`
            + `${serviceIds.length > 0 ? `: ${serviceIds.join(', ')}` : ''}`,
        );
        const active = new Set(serviceIds);
        for (const serviceId of sourceCache.keys()) {
            if (!active.has(serviceId)) sourceCache.delete(serviceId);
        }
        return serviceIds.map((serviceId) => {
            const cached = sourceCache.get(serviceId);
            if (cached !== undefined) return cached;
            const manifest = serviceId === ''
                ? connection.get(hubAccessManifestInterface)
                : connection.service(serviceId).get(hubAccessManifestInterface);
            const source: AggregatorSource = {
                tag: serviceId,
                manifest: withApprovalSourceLogging(manifest, serviceId, log),
                preserveOrigin: false,
            };
            sourceCache.set(serviceId, source);
            return source;
        });
    };

    const aggregate = new AggregatingHubAccessManifest({
        resolveSources,
        watchSources: (onChange) => {
            directoryChanged = onChange;
            return () => {
                if (directoryChanged === onChange) directoryChanged = undefined;
            };
        },
        log,
        onSourceError: (tag, error) => {
            if (error === undefined) errorsBySource.delete(tag);
            else errorsBySource.set(tag, error);
            sourceErrors.set([...errorsBySource.values()], undefined);
        },
    });
    const pair = new TransportPair();
    const aggregateServer = LinkRpcConnection.fromTransport(pair.a);
    const aggregateClient = LinkRpcConnection.fromTransport(pair.b);
    registerAggregatingManifest(aggregateServer, aggregate, { serviceId: AGGREGATE_SERVICE_ID });

    return new ApprovalClient({
        manifest: aggregateClient.service(AGGREGATE_SERVICE_ID).get(hubAccessManifestInterface),
        identity,
        getCapabilities,
        refreshAuthority,
        sourceErrors: discoveryErrors,
        fetchDirectory,
        log,
        dispose: () => {
            aggregate.dispose();
            void watchStarted.then((stop) => stop(), () => undefined);
            explorer.dispose();
            aggregateClient.close();
            aggregateServer.close();
        },
    });
}

function withApprovalSourceLogging(
    manifest: IHubAccessManifest,
    serviceId: string,
    log: ((line: string) => void) | undefined,
): IHubAccessManifest {
    if (!log) return manifest;
    const getDesired = manifest.getDesired.bind(manifest);
    return new Proxy(manifest, {
        get: (target, property, receiver) => {
            if (property !== 'getDesired') return Reflect.get(target, property, receiver);
            return async (...args: Parameters<typeof getDesired>) => {
                const result = await getDesired(...args);
                const count = Object.keys(result.requested).length;
                log(
                    `approval: source '${serviceId || '<root>'}' has ${count} pending request`
                    + (count === 1 ? '' : 's'),
                );
                return result;
            };
        },
    });
}

export function encodeApprovalRequestId(internalId: string): string {
    if (internalId.length === 0) throw new Error('cannot encode an empty approval request id');
    return `${EXTERNAL_ID_PREFIX}${bytesToBase64Url(new TextEncoder().encode(internalId))}`;
}

export function decodeApprovalRequestId(externalId: string): string {
    if (!new RegExp(`^${EXTERNAL_ID_PREFIX}[A-Za-z0-9_-]+$`).test(externalId)) {
        throw new Error(`invalid approval request id '${externalId}'`);
    }

    const encoded = externalId.slice(EXTERNAL_ID_PREFIX.length);
    const decoded = new TextDecoder().decode(base64UrlToBytes(encoded));
    if (decoded.length === 0 || encodeApprovalRequestId(decoded) !== externalId) {
        throw new Error(`invalid approval request id '${externalId}'`);
    }
    return decoded;
}

function approvalRequestSource(internalId: string): string | undefined {
    const separator = internalId.indexOf('\u0000');
    return separator < 0 ? undefined : internalId.slice(0, separator);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
