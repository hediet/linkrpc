/**
 * hubrpc hub — **server** entry: routing plus topology/traffic inspection.
 *
 * The entire model is **one noun**: the {@link Hub}. A hub is a longest-
 * prefix message router with three link-shaped parts (forwarding table,
 * optional loopback for local root services, optional uplink for nesting).
 * Everything else is built from hubs:
 *
 * - {@link RootOverlay} — a per-participant front door that is itself a hub.
 * - {@link installHubServices} — the global directory/schema services a hub
 *   exposes under the `hub::` prefix.
 *
 * Addressing primitives, the transport seam and wire shapes live in
 * {@link ../common}. See `hub-routing-design.md` for the full rationale.
 */
export { ForwardingTable, validatePrefix } from './routing/forwardingTable';
export { Hub } from './routing/routingHub';
export type { AttachedLink, HubOptions, IDisposable, IHubLogger, PendingRequestInfo } from './routing/routingHub';
export { TrafficFlowAggregator, TransitAggregator, formatFlowSummary } from './nodeTransit';
export { createFlowLogger, tapTransport } from './nodeTransit';
export type {
    FlowLogger,
    FlowLoggerOptions,
    FlowStatus,
    FlowStreamMessage,
    FlowSummary,
    NodeTransit,
    NodeTransitObserver,
    TransitAggregatorOptions,
    TransitDisposition,
    TransitEndpoint,
    TransitError,
    TransitKind,
    WireTapOptions,
} from './nodeTransit';
export {
    HubInspector,
    type HubTrafficSource,
} from './hubInspector';
export type {
    HubTrafficSubscription,
    HubTrafficWatchOptions,
} from './hubInspector';
export { OverlaySplitter } from './routing/overlaySplitter';
export type { OverlaySplitterInspection } from './routing/overlaySplitter';
export { RootOverlay } from './routing/rootOverlay';
export type { RootOverlayOptions } from './routing/rootOverlay';
export { registerHubServices, registerIdentityServices } from './rootServices';
export type { RegisterHubServicesOptions, RegisterIdentityServicesOptions } from './rootServices';
export { createHubServiceInterfaces } from './hubServices';
export type { HubServices, HubServicesOptions } from './hubServices';
export { hubRegisterServiceId, RegisteredServiceId } from './hubRegisterServiceId';
export {
    candidatesForSlot,
    fetchFullDirectory,
    resolveAccessCandidates,
} from './accessCandidates';
export type {
    AccessInterfaceRequirement,
    AccessMemberRequirement,
    AccessSlotCandidate,
    AccessSlotRequest,
    DirectoryEntry,
    ResolvedAccessSlot,
    ResolvedCandidates,
} from './accessCandidates';
export { mintCapability } from './mintCapability';
export type { MintCapabilityOptions } from './mintCapability';
export {
    CapabilityProposalIssuer,
    durationToExp,
} from './capabilityProposal';
export type { CapabilityProposal, ProposeArgs, AccessDurationName } from './capabilityProposal';
export { registerHubAccessService } from './hubAccessService';
export { registerConnectionTokenBinderService } from './connectionTokenBinderService';
export type { RegisterConnectionTokenBinderOptions } from './connectionTokenBinderService';
export { connectionTokenBinderInterface } from './connectionTokenBinder.interfaces';
export {
    anonymousHandler,
    boundTokenHandler,
    fixedProvisionHandler,
    provisionRoot,
    resolveConnectionHandler,
    staticTokenHandler,
} from './connectionHandler';
export type {
    ConnectionContext,
    ConnectionHandler,
    ConnectionHandlerFactory,
    RootProvision,
} from './connectionHandler';
export { TokenIdentityStore } from './tokenIdentityStore';
export type {
    MintedToken,
    TokenIdentityBinding,
    TokenIdentityStoreOptions,
} from './tokenIdentityStore';
export type {
    AccessConsumer,
    AccessDecision,
    AccessCallIntent,
    AccessDirectArgs,
    AccessDirectPermission,
    AccessDirectDecision,
    AccessDuration,
    AccessExtendArgs,
    AccessExtendDecision,
    AccessExtendMember,
    AccessRequestArgs,
    AccessSlotBinding,
    HubAccessHandlers,
    RegisterHubAccessOptions,
} from './hubAccessService';
export { registerHubServiceIdRegistry, withRequestIdContext } from './hubRegister';
export type { HubRegisterOptions, RegisterCallContext } from './hubRegister';
export { withVerifiedSignature } from './verifiedSignature';
export { withForwardedCallGate, withFullyQualifiedCallGate } from './forwardedCallGate';
export type { ForwardedCallGateOptions } from './forwardedCallGate';
export { withProvenance } from './provenance';
export type {
    ConnectionProvenance,
    ConnectionProvenanceProvider,
    ITransportWithProvenance,
    WithProvenance,
    WithProvenanceOptions,
} from './provenance';
export { PrincipalIdPrefixPolicy } from './prefixPolicy';
export type { ClaimContext, PrincipalIdPrefixPolicyOptions, PrefixPolicy } from './prefixPolicy';
export { HubConnectionAcceptor } from './hubConnectionAcceptor';
export type { HubConnectionAcceptorOptions, HubAccessConfig } from './hubConnectionAcceptor';
export { createSqliteIdentityKeystore } from './sqliteIdentityKeystore';
export type {
    SqliteIdentityKeystore,
    SqliteIdentityKeystoreOptions,
    SqliteIdentitySlot,
} from './sqliteIdentityKeystore';
export { createIdentityKeystore } from './identityKeystore';
export type {
    IdentityKeystore,
    IdentityKeystoreOptions,
    IdentitySlot,
    IdentitySnooze,
    SlotAccessKey,
    SlotByIdAndKeyResult,
    SlotByIdAndTimeResult,
    SlotId,
} from './identityKeystore';
