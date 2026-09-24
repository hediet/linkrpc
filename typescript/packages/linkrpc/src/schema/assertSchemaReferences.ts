import type { LinkRpcJsonSchema } from './linkRpcJsonSchema';
import { SchemaValidationError } from './schemaValidationError';

type SchemaNode = Exclude<LinkRpcJsonSchema, boolean>;
const componentPrefix = '#/components/schemas/';

export function componentSchemaRef(name: string): string {
    return componentPrefix + name.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function componentSchemaName(ref: string): string {
    if (!ref.startsWith(componentPrefix)) {
        throw new SchemaValidationError(`Invalid component reference: ${ref}`);
    }
    const token = ref.slice(componentPrefix.length);
    if (token.includes('/') || /~(?:[^01]|$)/.test(token)) {
        throw new SchemaValidationError(`Invalid component reference token: ${ref}`);
    }
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Check the finite schema graph without interpreting JSON literal payloads.
 * A reference/union-only cycle is invalid; descending into an object member
 * or an array item guards a cycle, but does not imply the schema is nonempty.
 */
export function assertSchemaReferences(
    roots: Iterable<LinkRpcJsonSchema>,
    components: Record<string, LinkRpcJsonSchema> = {},
): void {
    const nodes = new Set<SchemaNode>();
    const pending = [...roots, ...Object.values(components)];
    const unguarded = new Map<SchemaNode, LinkRpcJsonSchema[]>();
    while (pending.length > 0) {
        const node = pending.pop()!;
        if (typeof node === 'boolean' || nodes.has(node)) continue;
        nodes.add(node);
        const edges: LinkRpcJsonSchema[] = [];
        if ('$ref' in node) {
            const name = componentSchemaName(node.$ref);
            if (!Object.hasOwn(components, name)) {
                throw new Error(`Unresolved component reference: ${node.$ref}`);
            }
            edges.push(components[name]);
        }
        if ('anyOf' in node) edges.push(...node.anyOf);
        if ('oneOf' in node) edges.push(...node.oneOf);
        unguarded.set(node, edges);
        pending.push(...edges);
        if ('type' in node && node.type === 'object') {
            pending.push(...Object.values(node.properties ?? {}), node.additionalProperties);
        }
        if ('type' in node && node.type === 'array') {
            if ('prefixItems' in node) pending.push(...node.prefixItems);
            if (node.items !== undefined) pending.push(node.items);
        }
    }

    const visiting = new Set<SchemaNode>();
    const checked = new Set<SchemaNode>();
    const visit = (node: LinkRpcJsonSchema): void => {
        if (typeof node === 'boolean' || checked.has(node)) return;
        if (visiting.has(node)) {
            throw new Error('Unguarded recursive schema: cycle does not descend into a child value');
        }
        visiting.add(node);
        for (const child of unguarded.get(node) ?? []) visit(child);
        visiting.delete(node);
        checked.add(node);
    };
    for (const node of nodes) visit(node);
}
