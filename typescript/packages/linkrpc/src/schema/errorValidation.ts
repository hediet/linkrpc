import { safeParse, type $ZodIssue } from 'zod/v4/core';
import { literal, strictObject, string } from 'zod/mini';
import type { RpcValidationIssue } from '../connection/nonCompliantServerError';
import type { ApplicationErrorDescriptorBase, RpcErrorBody, Schema } from './memberTypes';
import { jsonPointerSegment } from './validationIssue';

type ParsedErrorBody =
    | { readonly success: true; readonly data: RpcErrorBody }
    | { readonly success: false; readonly issues: readonly RpcValidationIssue[] };

const bodySchemas = new WeakMap<ApplicationErrorDescriptorBase, Schema<RpcErrorBody>>();

export function parseDeclaredErrorBody(
    descriptor: ApplicationErrorDescriptorBase, body: RpcErrorBody,
): ParsedErrorBody {
    return parseErrorBody(descriptor.bodySchema ?? errorBodySchema(descriptor), body);
}

function errorBodySchema(descriptor: ApplicationErrorDescriptorBase): Schema<RpcErrorBody> {
    let schema = bodySchemas.get(descriptor);
    if (schema === undefined) {
        const payload = descriptor.dataSchema === undefined ? {} : { data: descriptor.dataSchema };
        schema = descriptor.type === undefined
            ? strictObject({ message: literal(descriptor.message!), ...payload })
            : strictObject({
                message: string(),
                data: strictObject({ type: literal(descriptor.type), ...payload }),
            });
        bodySchemas.set(descriptor, schema);
    }
    return schema;
}

export function parseErrorBody(schema: Schema, body: RpcErrorBody): ParsedErrorBody {
    const parsed = safeParse(schema, body);
    if (!parsed.success) return { success: false, issues: validationIssues(parsed.error.issues) };
    if (typeof parsed.data !== 'object' || parsed.data === null || !('message' in parsed.data)
        || typeof parsed.data.message !== 'string') {
        return { success: false, issues: [{ path: '/message', message: 'Expected a string message' }] };
    }
    return { success: true, data: { ...parsed.data, message: parsed.data.message } };
}

function validationIssues(issues: readonly $ZodIssue[], prefix: readonly PropertyKey[] = []): RpcValidationIssue[] {
    return issues.flatMap((issue) => {
        const path = [...prefix, ...issue.path];
        if (issue.code === 'invalid_union') {
            return issue.errors.flatMap((branch) => validationIssues(branch, path));
        }
        if (issue.code === 'unrecognized_keys') {
            return issue.keys.map((key) => ({ path: pointer([...path, key]), message: 'Unexpected property' }));
        }
        return [{ path: pointer(path), message: issue.message }];
    });
}

function pointer(path: readonly PropertyKey[]): string {
    return path.map(jsonPointerSegment).join('');
}

export function jsonIssues(value: unknown, path: readonly PropertyKey[] = [], ancestors = new Set<object>()): RpcValidationIssue[] {
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))) return [];
    if (typeof value !== 'object' || ancestors.has(value)
        || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
            && Object.getPrototypeOf(value) !== null)) {
        return [{ path: pointer(path), message: 'Expected a JSON value' }];
    }
    ancestors.add(value);
    const issues = (Array.isArray(value) ? Array.from(value.entries()) : Object.entries(value))
        .flatMap(([key, child]) => jsonIssues(child, [...path, key], ancestors));
    ancestors.delete(value);
    return issues;
}
