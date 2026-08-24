import type { HubRpcInterfaceSchema } from '@vscode/hubrpc';
import {
    type CliChannel,
    fetchDefaults,
    fetchSchema,
} from '@vscode/hubrpc-client';
import type { MethodRefWithOptHash } from './methodRef';

/**
 * Fetch the schema addressed by a method reference. Form-1 references use the
 * connection preset for lookup, but remain bare when sent on the wire.
 */
export async function fetchSchemaForMethodRef(
    channel: CliChannel,
    ref: MethodRefWithOptHash,
): Promise<HubRpcInterfaceSchema | undefined> {
    if (ref.interfaceId !== undefined) {
        return fetchSchema(channel, ref.interfaceId, ref.hash, ref.serviceId);
    }

    const defaults = await fetchDefaults(channel);
    if (defaults.interfaceId === undefined) {
        return undefined;
    }
    return fetchSchema(
        channel,
        defaults.interfaceId,
        ref.hash ?? defaults.hash,
        defaults.serviceId,
    );
}
