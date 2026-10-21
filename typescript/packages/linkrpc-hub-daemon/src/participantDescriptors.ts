/**
 * How the daemon describes the participants it connects to its hub: an
 * `attacher` descriptor on their topology node. Diagnostic only; the call log
 * and UIs use it to attribute traffic to configured services.
 */
import type { ParticipantDescriptor } from '@hediet/linkrpc/inspection';

const SERVICE_TYPE = 'linkrpc.hubDaemon.service';
const ENDPOINT_TYPE = 'linkrpc.hubDaemon.endpoint';

/** A service configured under `services` in the daemon config. */
export function serviceDescriptor(name: string, serviceId: string): ParticipantDescriptor {
    return { type: SERVICE_TYPE, label: name, metadata: { serviceId } };
}

/** An endpoint managed through `linkrpc.managedEndpoints` (e.g. started by the CLI). */
export function endpointDescriptor(id: string, namespace: string, serviceId: string): ParticipantDescriptor {
    return { type: ENDPOINT_TYPE, label: id, metadata: { namespace, serviceId } };
}

/** The configured service a descriptor names, if it is one of ours. */
export function serviceNameOf(descriptor: ParticipantDescriptor | undefined): string | undefined {
    return descriptor?.type === SERVICE_TYPE ? descriptor.label : undefined;
}
