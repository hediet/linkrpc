import type { JsonRpcError } from '../protocol/jsonRpc';
import type { JsonSchemaValidationIssue } from '../schema/validationIssue';

/** JSON Pointer diagnostics relative to the original wire error. */
export type RpcValidationIssue = JsonSchemaValidationIssue;

export class NonCompliantServerError extends Error {
    readonly kind = 'nonCompliantServer' as const;

    constructor(
        public readonly original: JsonRpcError['error'],
        public readonly issues: readonly RpcValidationIssue[],
    ) {
        super(`Server error ${original.code} does not match its declared schema: ${
            issues.map((issue) => `${issue.path || '/'}: ${issue.message}`).join('; ')
        }`);
        this.name = 'NonCompliantServerError';
    }
}
