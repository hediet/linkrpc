import type { LinkRpcInterfaceSchema } from './linkRpcInterfaceSchema';

export function validateInterfaceErrors(schema: Pick<LinkRpcInterfaceSchema, 'methods'> | undefined): void {
    if (schema === undefined) return;
    for (const [methodName, method] of Object.entries(schema.methods)) {
        if (method.result === undefined && method.errors !== undefined) {
            throw new Error(`Notification "${methodName}" cannot declare application errors.`);
        }
        const seen = new Set<string>();
        const errors = method.errors ?? [];
        for (const error of errors) {
            if (!Number.isInteger(error.code) || error.code < -2147483648 || error.code > 2147483647) {
                throw new Error(`Application error code ${error.code} on "${methodName}" must be a signed 32-bit integer.`);
            }
            if (errors.some((other) => other !== error && other.code === error.code
                && (other.schema !== undefined || error.schema !== undefined))) {
                throw new Error(`Raw error code ${error.code} on "${methodName}" cannot be shared.`);
            }
            if (error.schema !== undefined) {
                if (['message', 'type', 'data'].some((key) => Object.hasOwn(error, key))) {
                    throw new Error(`Raw error ${error.code} on "${methodName}" must contain only code and schema.`);
                }
            } else {
                if (typeof error.message !== 'string') {
                    throw new Error(`Application error message on "${methodName}" must be a string.`);
                }
                if ((error.code >= -32768 && error.code <= -32000) || error.code === -32800) {
                    throw new Error(`Application error code ${error.code} on "${methodName}" is reserved by JSON-RPC or LinkRPC.`);
                }
                if (error.type !== undefined && (typeof error.type !== 'string' || error.type.length === 0)) {
                    throw new Error(`Application error type on "${methodName}" must be a nonempty string.`);
                }
            }
            const key = error.type === undefined ? `code:${error.code}` : `type:${error.type}`;
            if (seen.has(key)) throw new Error(`Duplicate application error ${key} on "${methodName}".`);
            seen.add(key);
        }
    }
}
