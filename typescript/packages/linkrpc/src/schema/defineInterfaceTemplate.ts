import { never } from 'zod/mini';
import { defineInterface, toMethodSchema, type MemberMap } from '../connection/interfaceDefinition';
import { zodToSvcJsonSchema, type Schema } from './memberTypes';
import type { LinkRpcJsonSchema } from './linkRpcJsonSchema';
import { interfaceTemplateGroup, type InterfaceTemplateGroup } from './interfaceTemplateGroup';
import {
    bindTemplateArguments, validateInterfaceTemplate,
    type InterfaceTemplateSchema, type MappedInterfaceTemplate,
} from './interfaceTemplates';

export interface BoundInterfaceTemplate<M extends MemberMap> extends InterfaceTemplateGroup<M, undefined> {
    mapMembers<const Map extends { readonly [K in keyof M]: string }>(
        mapping: Map & Record<Exclude<keyof Map, keyof M>, never>,
    ): MappedInterfaceTemplate & InterfaceTemplateGroup<M, Map>;
}

/**
 * Wrap an explicitly generic, declarative, side-effect-free schema factory.
 * It runs once with symbolic schemas for reflection, then once per call with
 * the original concrete schemas. Never branch on the schema arguments.
 * The bare callable return preserves TypeScript's higher-order generic inference.
 */
export function defineInterfaceTemplate<A extends Record<string, Schema>, M extends MemberMap>(
    // Infer A from the generic factory, not prematurely from metadata's keys.
    info: { readonly id: string; readonly parameters: readonly (keyof NoInfer<A> & string)[] },
    factory: (args: A) => M,
): (args: A) => BoundInterfaceTemplate<M> {
    const snapshot = { id: info.id, parameters: [...info.parameters] };
    const markers = new WeakMap<Schema, string>();
    const symbolic = Object.fromEntries(snapshot.parameters.map(name => {
        const schema = never();
        markers.set(schema, name);
        return [name, schema];
    }));
    // Symbolic schemas are used only for reflection, never for parsing values.
    const members = factory(symbolic as unknown as A);
    const components: Record<string, LinkRpcJsonSchema> = {};
    const methods = Object.fromEntries(Object.entries(members).map(([name, member]) => [
        name, toMethodSchema(name, member, components, (schema, position) =>
            zodToSvcJsonSchema(schema, {
                methodName: name, schemaPosition: position, components, parameterNames: markers,
            })),
    ]));
    const replace = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(replace);
        if (value !== null && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            if (typeof record.$ref === 'string' && record.$ref.startsWith('linkrpc-parameter:')) {
                return { $parameter: decodeURIComponent(record.$ref.slice('linkrpc-parameter:'.length)) };
            }
            return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, replace(child)]));
        }
        return value;
    };
    const template = replace({
        ...snapshot, methods,
        ...(Object.keys(components).length === 0 ? {} : { components: { schemas: components } }),
    }) as InterfaceTemplateSchema;
    validateInterfaceTemplate(template);
    freezeMetadata(template);

    return args => {
        if (args === null || typeof args !== 'object' || Array.isArray(args)) {
            throw new Error('Interface template arguments must be a schema argument object');
        }
        for (const key of Reflect.ownKeys(args)) {
            if (typeof key !== 'string' || !snapshot.parameters.includes(key)) {
                throw new Error(`Interface template "${snapshot.id}" supplies unknown parameter "${String(key)}"`);
            }
        }
        for (const name of snapshot.parameters) {
            if (!Object.hasOwn(args, name)) throw new Error(`Interface template "${snapshot.id}" is missing parameter "${name}"`);
            const schema = args[name];
            if (schema === null || typeof schema !== 'object' || !('_zod' in schema)) {
                throw new Error(`Interface template parameter "${name}" must be a Zod schema`);
            }
            if (schema._zod.optout === 'optional') {
                throw new Error('Generic schema arguments must not be optional; wrap the parameter with optional() in the template');
            }
        }
        const arguments_ = structuredClone(bindTemplateArguments(template, args));
        freezeMetadata(arguments_);
        const concrete = factory(args);
        const bound: BoundInterfaceTemplate<M> = {
            [interfaceTemplateGroup]: true,
            template, arguments: arguments_, mapping: undefined, members: concrete,
            mapMembers(mapping) {
                const targets = new Set<string>();
                for (const key of Object.keys(mapping)) {
                    if (!Object.hasOwn(concrete, key)) throw new Error(`Unknown mapped member "${key}"`);
                }
                for (const key of Object.keys(concrete)) {
                    const target = mapping[key];
                    if (!Object.hasOwn(mapping, key) || typeof target !== 'string') throw new Error(`Missing mapped member "${key}"`);
                    if (targets.has(target)) throw new Error(`Interface template member collision at "${target}"`);
                    targets.add(target);
                }
                const frozenMapping = Object.freeze({ ...mapping });
                return {
                    [interfaceTemplateGroup]: true,
                    template, arguments: arguments_, members: concrete, mapping: frozenMapping,
                    schema: Object.freeze({ template: template.id, arguments: arguments_, members: frozenMapping }),
                };
            },
        };
        // Reuse grouped contract validation, including concrete errors and streams.
        defineInterface({ id: snapshot.id }, { instance: bound });
        return bound;
    };
}

function freezeMetadata(value: unknown): void {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
}
