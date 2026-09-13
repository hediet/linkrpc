/**
 * linkrpc hub — **common** entry.
 *
 * Transport-agnostic primitives shared by both the hub {@link ../server server}
 * and its {@link ../client clients}: service-id addressing, the transport seam
 * (`Transport` / `ITransportServer`), and the on-the-wire interface shapes.
 */
export {
    isServiceIdUnder,
    isValidServiceId,
    ROOT_SERVICE_ID,
    SERVICE_ID_SEPARATOR,
    splitServiceId,
} from './serviceId';
export type { ServiceId } from './serviceId';
export { mapTransport } from './transportServer';
export type { ITransportServer, Transport } from './transportServer';
export {
    hubAccessInterface,
    hubAccessManifestInterface,
    hubGrantedServiceIdInterface,
    hubServiceIdRegistryInterface,
} from './hub.interfaces';
export type {
    HubAccessManifestDecision,
    HubAccessManifestRequest,
    IHubAccessManifest,
} from './hub.interfaces';
export type {
    HubAccessDuration,
    HubAccessPattern,
    HubAccessPermission,
    HubAccessRequest,
    HubAccessResult,
} from './hubAccess';
export { findCoveringCapabilities } from './hubAccess';
export { nodeInterface } from './node.interfaces';
export type { NodeInfo, ParticipantDescriptorSource, TopologyIdGenerator } from './node.interfaces';
export {
    topologyInterface,
    trafficInterface,
    zParticipantDescriptor,
    zParticipantDescriptorSource,
    zRouteClaim,
    zTopologyGraph,
    zTopologyLink,
    zTopologyLinkEndpoint,
    zTopologyNode,
    zTopologyPort,
    zTopologyTransportEndpoint,
    zTopologyTransportInfo,
    zTrafficEvent,
    zTrafficOverflowEvent,
    zTrafficTransitEndpoint,
    zTrafficTransitEvent,
    zTrafficWatchResult,
} from './inspection.interfaces';
export type {
    ParticipantDescriptor,
    RouteClaim,
    TopologyGraph,
    TopologyLink,
    TopologyLinkEndpoint,
    TopologyNode,
    TopologyPort,
    TopologyTransportEndpoint,
    TopologyTransportInfo,
    TrafficEvent,
    TrafficOverflowEvent,
    TrafficTransitEndpoint,
    TrafficTransitEvent,
    TrafficWatchResult,
} from './inspection.interfaces';
export { BoundedTrafficSubscription } from './boundedTrafficSubscription';
export type {
    TrafficSubscription,
    TrafficSubscriptionOptions,
} from './boundedTrafficSubscription';
export {
    TrafficFlowFilter,
    TrafficWatchFlowTracker,
} from './trafficFlowFilter';
export type {
    TrafficFlowFilterOptions,
    TrafficRequestRef,
} from './trafficFlowFilter';
export {
    registerGrantedServiceId,
} from './baseCapabilities';
export {
    createAutoNegotiatingCapProvider,
    createManagedSigningChannel,
} from './managedSigning';
export type {
    AutoNegotiateConsumer,
    ManagedSigningOptions,
} from './managedSigning';
export {
    DEFAULT_WALK_DEPTH,
    HubDirectoryExplorer,
    fetchDirectory,
    fetchSchema,
    findMethodInSchema,
    intersectServiceIdScopes,
    normalizeServiceIdScopes,
    serviceIdMatchesPattern,
    serviceIdMatchesScopes,
    walkHub,
    walkHubDetailed,
} from './directoryWalk';
export type {
    DiscoveredListing,
    HubDirectoryChange,
    HubDirectoryGraphEvent,
    HubDirectoryGraphSnapshot,
    HubDirectoryGraphTarget,
    HubDirectoryNodeReport,
    HubDirectoryNodeState,
    HubDirectoryParentReport,
    InaccessibleDirectory,
    ListOptions,
    ReflectionChannel,
    ServiceListing,
    WalkHubOptions,
    WalkHubResult,
} from './directoryWalk';
