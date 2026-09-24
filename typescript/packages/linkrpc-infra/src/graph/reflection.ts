import {
    validateInterfaceTemplates, interfaceTemplateArgumentsEquivalent, interfaceTemplatesEqual,
    type InterfaceTemplatesMetadata, type LinkRpcInterfaceSchema,
} from '@hediet/linkrpc';
import { unknown } from 'zod/mini';
import { GraphObjects, GraphRoot } from './interfaces';

const graphTemplates = [
    GraphObjects({ ref: unknown(), value: unknown() }).template,
    GraphRoot({ params: unknown(), ref: unknown() }).template,
];

/** Graph discovery policy is independent of generic interface authoring. */
export function validateGraphInterfaceSchema(schema: LinkRpcInterfaceSchema): void {
    validateInterfaceTemplates(schema);
    const metadata = schema['x-interface-templates'] as InterfaceTemplatesMetadata | undefined;
    if (metadata === undefined) return;
    for (const template of graphTemplates) {
        const actual = metadata.templates[template.id];
        if (actual !== undefined && !interfaceTemplatesEqual(actual, template)) {
            throw new Error(`Unsupported graph template contract "${template.id}"`);
        }
    }
    const stores = metadata.instances.filter(instance => instance.template === graphTemplates[0]!.id);
    if (stores.length > 1) throw new Error('A containing interface may declare at most one graph objects instance');
    const store = stores[0];
    for (const root of metadata.instances.filter(instance => instance.template === graphTemplates[1]!.id)) {
        if (store === undefined || !interfaceTemplateArgumentsEquivalent(root.arguments.ref!, store.arguments.ref!)) {
            throw new Error(`Root "${root.name}" requires a compatible objects instance in the same interface`);
        }
    }
}
