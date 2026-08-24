import {
    HubRpcConnection,
    jcsCanonicalize,
    type Permission,
    type Principal,
    type SignedCapability,
    TransportPair,
    type SigningCallCtx,
    type SigningIdentity,
} from '@vscode/hubrpc';
import {
    HubDirectoryExplorer,
    hubAccessManifestInterface,
    type HubAccessManifestDecision,
    type HubAccessManifestRequest,
    type IHubAccessManifest,
} from '@vscode/hubrpc/hub/common';
import {
    AggregatingHubAccessManifest,
    ApproveClient,
    buildSlotPermissions,
    registerAggregatingManifest,
    runManifestApprover,
    toSignedPermissions,
    type AggregatorSource,
    type ConsentPrompt,
} from '@vscode/hubrpc-hub';
import {
    CapabilityProposalIssuer,
    candidatesForSlot,
    durationToExp,
    type AccessDirectPermission,
    type AccessDurationName,
    type AccessSlotRequest,
    type DirectoryEntry,
} from '@vscode/hubrpc-hub/hub/server';
import { autorun } from '@vscode/observables';
import { createApprovalPresentation } from '../approvalPresentation';
import { formatJson } from '../output';

/**
 * The only authority an approval command needs for inspecting and updating
 * manifests across a federated Hub.
 */
export const approvalCommandPermissions: readonly Permission[] = [
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

const approvalCommandPermissionsJson = jcsCanonicalize(approvalCommandPermissions);

/**
 * Installs the root identity's narrowly scoped self-capability used by the
 * approval scanner. Reusing the non-expiring exact grant prevents repeated
 * commands from growing the principal's durable capability bag.
 */
export async function bootstrapApprovalCommandCapability(
    principal: Principal,
): Promise<SignedCapability> {
    const existing = principal.capBag.capabilities.find((capability) =>
        capability.issuer === principal.id
        && capability.audience === principal.id
        && capability.expiresAtMs === undefined
        && capability.parentHash === undefined
        && jcsCanonicalize(capability.permissions) === approvalCommandPermissionsJson
    );
    if (existing) {
        return existing;
    }

    const issuer = new CapabilityProposalIssuer(principal.identity);
    const capability = await issuer.mint({
        audience: principal.id,
        permissions: approvalCommandPermissions,
    });
    await principal.capBag.add(capability);
    return capability;
}

const MANIFEST_INTERFACE_ID = hubAccessManifestInterface.info.id;
const AGGREGATE_SERVICE_ID = 'hubrpc-cli.approvals';
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

export interface ApprovalSubscription {
    dispose(): void;
}

export interface ApprovalCommandClientOptions {
    readonly manifest: IHubAccessManifest;
    readonly identity: SigningIdentity;
    readonly fetchDirectory?: () => Promise<readonly DirectoryEntry[]>;
    readonly log?: (line: string) => void;
    readonly dispose?: () => void;
}

/**
 * CLI-facing approval operations over the hub's shared manifest frontend.
 * The underlying {@link ApproveClient} remains authoritative for snapshots and
 * acknowledgement. One-shot commands mint before calling its acknowledged
 * decision path; {@link runManifestApprover} drives the interactive UI.
 */
export class ApprovalCommandClient {
    private readonly _principalId: string;
    private readonly _manifest: IHubAccessManifest;
    private readonly _client: ApproveClient;
    private readonly _issuer: CapabilityProposalIssuer;
    private readonly _fetchDirectory: ApprovalCommandClientOptions['fetchDirectory'];
    private readonly _log: (line: string) => void;
    private readonly _disposeExtra: (() => void) | undefined;
    private _lastClientError: string | undefined;
    private _disposed = false;

    constructor(options: ApprovalCommandClientOptions) {
        this._principalId = options.identity.publicSigningIdentity.principal;
        this._manifest = options.manifest;
        this._issuer = new CapabilityProposalIssuer(options.identity);
        this._fetchDirectory = options.fetchDirectory;
        this._log = options.log ?? (() => { /* quiet */ });
        this._disposeExtra = options.dispose;
        this._client = new ApproveClient({
            manifest: this._manifest,
            ownPrincipalId: this._principalId,
            log: (line) => {
                this._lastClientError = line;
                this._log(line);
            },
        });
    }

    public get principalId(): string {
        return this._principalId;
    }

    public async requests(): Promise<readonly PendingApprovalRequest[]> {
        return this._toPendingRequests(await this._currentRequests());
    }

    /**
     * Subscribe to the authoritative manifest snapshot. The callback is invoked
     * immediately and whenever the watch reconnects or the request set changes.
     */
    public watch(listener: (snapshot: ApprovalSnapshot) => void): ApprovalSubscription {
        return autorun((reader) => {
            const state = this._client.state.read(reader);
            const requests = this._toPendingRequests(this._client.requests.read(reader));
            listener({
                state,
                requests,
                ...(state === 'stale' && this._lastClientError !== undefined
                    ? { error: this._lastClientError }
                    : {}),
            });
        });
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
        return {
            pending: {
                id: externalId,
                request: pending.request,
                revision: pending.revision,
                ...(sourceServiceId === undefined ? {} : { sourceServiceId }),
            },
            permissions: await toSignedPermissions(
                resolved.permissions,
                pending.request.consumer.principal,
                pending.request.duration,
            ),
            ...(resolved.resolvedSlot === undefined ? {} : { resolvedSlot: resolved.resolvedSlot }),
        };
    }

    /** Approve only if the request is still exactly the one that was reviewed. */
    public async approvePrepared(prepared: PreparedApproval): Promise<ApprovalDecisionOutcome> {
        const externalId = prepared.pending.id;
        const internalId = decodeApprovalRequestId(externalId);
        const pending = await this._requirePending(internalId, externalId);
        this._requireUnchanged(pending, prepared.pending);
        const decision = await this._grantDecision(prepared);
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

    public async runInteractive(signal: AbortSignal, prompt?: ConsentPrompt): Promise<void> {
        await this._currentRequests();
        const approver = runManifestApprover({
            manifest: this._manifest,
            issuer: this._issuer,
            ownPrincipalId: this._principalId,
            ...(this._fetchDirectory !== undefined ? { fetchDirectory: this._fetchDirectory } : {}),
            ...(prompt !== undefined ? { prompt } : {}),
            log: this._log,
        });
        try {
            await waitForAbort(signal);
        } finally {
            approver.dispose();
        }
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._client.dispose();
        this._disposeExtra?.();
    }

    private async _currentRequests() {
        await this._client.refresh();
        if (this._client.state.get() === 'stale') {
            throw new Error(this._lastClientError ?? 'could not read pending approval requests');
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
                members: request.members.map((item) => ({
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

    private async _grantDecision(prepared: PreparedApproval): Promise<HubAccessManifestDecision> {
        const request = prepared.pending.request;
        const capability = await this._issuer.mint({
            audience: request.consumer.principal,
            permissions: prepared.permissions,
            expiresAtMs: durationToExp(request.duration as AccessDurationName | undefined),
        });
        return {
            status: 'granted',
            granted: prepared.resolvedSlot === undefined
                ? { kind: 'direct', capabilities: [capability] }
                : {
                    kind: 'discover',
                    serviceId: prepared.resolvedSlot.serviceId,
                    satisfiedInterfaces: [...prepared.resolvedSlot.satisfiedInterfaces],
                    capabilities: [capability],
                },
        };
    }
}

/**
 * Discover every manifest in the connected hub and expose it through one
 * validated, namespaced aggregate. This is the same discovery/validation path
 * used by the hub's approval UI.
 */
export function createHubApprovalCommandClient(
    connection: HubRpcConnection<unknown, SigningCallCtx>,
    identity: SigningIdentity,
    log?: (line: string) => void,
): ApprovalCommandClient {
    const hubConnection = connection as unknown as HubRpcConnection;
    const explorer = new HubDirectoryExplorer(hubConnection.channel);
    const sourceCache = new Map<string, AggregatorSource>();
    let directoryChanged: (() => void) | undefined;
    const watchStarted = explorer.watch(() => directoryChanged?.());
    const fetchDirectory = async (): Promise<readonly DirectoryEntry[]> => {
        await watchStarted;
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
    });
    const pair = new TransportPair();
    const aggregateServer = HubRpcConnection.fromTransport(pair.a);
    const aggregateClient = HubRpcConnection.fromTransport(pair.b);
    registerAggregatingManifest(aggregateServer, aggregate, { serviceId: AGGREGATE_SERVICE_ID });

    return new ApprovalCommandClient({
        manifest: aggregateClient.service(AGGREGATE_SERVICE_ID).get(hubAccessManifestInterface),
        identity,
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
    return `${EXTERNAL_ID_PREFIX}${Buffer.from(internalId, 'utf8').toString('base64url')}`;
}

export function decodeApprovalRequestId(externalId: string): string {
    if (!new RegExp(`^${EXTERNAL_ID_PREFIX}[A-Za-z0-9_-]+$`).test(externalId)) {
        throw new Error(`invalid approval request id '${externalId}'`);
    }

    const encoded = externalId.slice(EXTERNAL_ID_PREFIX.length);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (decoded.length === 0 || encodeApprovalRequestId(decoded) !== externalId) {
        throw new Error(`invalid approval request id '${externalId}'`);
    }
    return decoded;
}

function approvalRequestSource(internalId: string): string | undefined {
    const separator = internalId.indexOf('\u0000');
    return separator < 0 ? undefined : internalId.slice(0, separator);
}

export function formatApprovalRequests(
    requests: readonly PendingApprovalRequest[],
    principalId: string,
    json = false,
): string {
    if (json) {
        return formatJson({
            version: 1,
            principal: principalId,
            requests: requests.map(({ id, request }) => ({ id, request })),
        });
    }
    if (requests.length === 0) {
        return `No pending approval requests for ${principalId}.`;
    }
    const lines: string[] = [];
    for (const request of requests) {
        const presentation = createApprovalPresentation(request);
        lines.push(presentation.heading);
        for (const detail of presentation.details) {
            lines.push(`  ${detail.label === undefined ? '' : `${detail.label}: `}${detail.text}`);
        }
    }
    return lines.join('\n');
}

export function formatApprovalDecision(
    action: 'approved' | 'denied',
    id: string,
    principalId: string,
    json = false,
    outcome: ApprovalDecisionOutcome = 'applied',
): string {
    if (json) {
        return formatJson({
            version: 1,
            action,
            id,
            principal: principalId,
            ...(outcome === 'still-pending' ? { requestStillPending: true } : {}),
        });
    }
    return outcome === 'applied'
        ? `${action === 'approved' ? 'Approved' : 'Denied'} ${id}.`
        : `${action === 'approved' ? 'Approval' : 'Denial'} decision accepted for ${id}, `
            + 'but a matching request is still pending; the consumer may have retried.';
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
