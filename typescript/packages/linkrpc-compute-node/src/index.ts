import { hostParticipant, type ParticipantHostHandle } from '@hediet/linkrpc-hub/participant-host';
import { registerComputeNode } from '@hediet/linkrpc-infra/compute-node/node';

/**
 * Serve the compute-node interfaces under the service ID the hub granted this
 * process (e.g. `<hubServiceId>/compute` for a daemon service named
 * `compute`). Dials `LINKRPC_ENDPOINT`.
 */
export function hostComputeNode(): Promise<ParticipantHostHandle> {
    return hostParticipant({
        registrationMode: 'grantedServiceId',
        setup: ({ connection, services, serviceId }) => {
            registerComputeNode(services);
            // The hub directory lists a participant's services through `<serviceId>::hubrpc.directory`
            // entries in its root directory, so reflection is needed at both places.
            connection.enableReflection();
            if (serviceId !== undefined) connection.enableReflection({ serviceId });
        },
    });
}
