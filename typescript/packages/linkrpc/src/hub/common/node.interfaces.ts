import { array, object, optional, string } from "zod/mini";
import type { output as zInfer } from "zod/v4/core";
import { defineInterface } from "../../connection/interfaceDefinition";
import { requestType } from "../../schema/memberTypes";
import { zParticipantDescriptorSource } from "./inspection.interfaces";
import type { ParticipantDescriptorSource } from "./inspection.interfaces";

const zNodeInfo = object({
    /**
     * Random identity of this connection's node. It is a topology-correlation
     * label only and must not be used for authentication or authorization.
     */
    nodeId: string(),
    /** Random identity of this connection's port on its node. */
    portId: string(),
    /** Optional diagnostic descriptors; never used for authorization. */
    descriptors: optional(array(zParticipantDescriptorSource)),
});

export type NodeInfo = zInfer<typeof zNodeInfo>;
export type { ParticipantDescriptorSource };

/**
 * Minimal root service for aligning the independently observed topologies at
 * both ends of a connection.
 */
export const nodeInterface = defineInterface(
    {
        id: "hubrpc.node",
        description:
            "Topology bootstrap: identify the node and port at this end of the direct connection.",
    },
    {
        getNodeId: requestType(object({}), zNodeInfo),
    },
);
