import type { $ZodType } from 'zod/v4/core';
import type { LinkRpcJsonSchema } from './linkRpcJsonSchema';

export const schemaSources = new WeakMap<$ZodType, {
    readonly schema: LinkRpcJsonSchema;
    readonly components: Record<string, LinkRpcJsonSchema>;
}>();
