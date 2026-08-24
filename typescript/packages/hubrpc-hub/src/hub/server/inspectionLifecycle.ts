import {
    getLocalMessageContext,
    type JsonRpcMessage,
    type LocalMessageContext,
    setLocalMessageContext,
} from '@vscode/hubrpc';
import { topologyInterface, trafficInterface } from '@vscode/hubrpc/hub/common';

export function isReservedInspectionInterface(interfaceId: string): boolean {
    return interfaceId === topologyInterface.info.id
        || interfaceId === trafficInterface.info.id;
}

export function markInspectionLifecycle(message: JsonRpcMessage): void {
    setLocalMessageContext(message, {
        ...getLocalMessageContext(message),
        inspection: true,
    } satisfies LocalMessageContext);
}

export function isInspectionLifecycle(message: JsonRpcMessage): boolean {
    return getLocalMessageContext(message)?.inspection === true;
}
