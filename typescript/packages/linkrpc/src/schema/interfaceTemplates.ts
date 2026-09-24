import type {
    ArraySchema,
    LinkRpcJsonSchema,
    ObjectSchema,
    OneOfSchema,
    TupleSchema,
    UnionSchema,
} from "./linkRpcJsonSchema";
import type { LinkRpcInterfaceSchema, MethodSchema } from "./linkRpcInterfaceSchema";
import type { Schema } from "./memberTypes";
import { zodToSvcJsonSchema } from "./memberTypes";
import { componentSchemaName, componentSchemaRef } from "./assertSchemaReferences";
import { computeInterfaceHash } from "./hash";
import { SchemaValidationError } from "./schemaValidationError";

export const INTERFACE_TEMPLATES_EXTENSION = "x-interface-templates";

export interface SchemaParameterReference<TName extends string = string> {
    readonly $parameter: TName;
}

type NonRecursiveJsonSchema = Exclude<
    LinkRpcJsonSchema,
    ArraySchema | TupleSchema | ObjectSchema | UnionSchema | OneOfSchema
>;

export type InterfaceTemplateJsonSchema<TParameter extends string = string> =
    | NonRecursiveJsonSchema
    | SchemaParameterReference<TParameter>
    | (Omit<ArraySchema, "items"> & { readonly items: InterfaceTemplateJsonSchema<TParameter> })
    | (Omit<TupleSchema, "prefixItems" | "items"> & {
        readonly prefixItems: readonly InterfaceTemplateJsonSchema<TParameter>[];
        readonly items?: InterfaceTemplateJsonSchema<TParameter> | false;
    })
    | (Omit<ObjectSchema, "properties" | "additionalProperties"> & {
        readonly properties: Readonly<Record<string, InterfaceTemplateJsonSchema<TParameter>>>;
        readonly additionalProperties: InterfaceTemplateJsonSchema<TParameter> | false;
    })
    | (Omit<UnionSchema, "anyOf"> & {
        readonly anyOf: readonly InterfaceTemplateJsonSchema<TParameter>[];
    })
    | (Omit<OneOfSchema, "oneOf"> & {
        readonly oneOf: readonly InterfaceTemplateJsonSchema<TParameter>[];
    });

export type InterfaceTemplateMethodSchema<TParameter extends string = string> =
    Omit<MethodSchema, "params" | "result" | "clientStream" | "serverStream" | "errors"> & {
        readonly params: InterfaceTemplateJsonSchema<TParameter>;
        readonly result?: InterfaceTemplateJsonSchema<TParameter>;
        readonly clientStream?: InterfaceTemplateJsonSchema<TParameter>;
        readonly serverStream?: InterfaceTemplateJsonSchema<TParameter>;
        readonly errors?: readonly InterfaceTemplateErrorSchema<TParameter>[];
    };

export type InterfaceTemplateErrorSchema<TParameter extends string = string> =
    | {
        readonly code: number;
        readonly schema: InterfaceTemplateJsonSchema<TParameter>;
        readonly type?: never;
        readonly message?: never;
        readonly data?: never;
    }
    | {
        readonly schema?: never;
        readonly type?: string;
        readonly code: number;
        readonly message: string;
        readonly data?: InterfaceTemplateJsonSchema<TParameter>;
    };

export interface InterfaceTemplateSchema<TParameter extends string = string> {
    readonly id: string;
    readonly parameters: readonly TParameter[];
    readonly methods: Readonly<Record<string, InterfaceTemplateMethodSchema<TParameter>>>;
    readonly components?: {
        readonly schemas?: Readonly<Record<string, InterfaceTemplateJsonSchema<TParameter>>>;
    };
}

export interface InterfaceTemplateArgument {
    readonly schema: LinkRpcJsonSchema;
    readonly components?: {
        readonly schemas?: Readonly<Record<string, LinkRpcJsonSchema>>;
    };
}

export interface InterfaceTemplateInstance {
    readonly name: string;
    readonly template: string;
    readonly members: Readonly<Record<string, string>>;
    readonly arguments: Readonly<Record<string, InterfaceTemplateArgument>>;
}

export interface InterfaceTemplatesMetadata {
    readonly templates: Readonly<Record<string, InterfaceTemplateSchema>>;
    readonly instances: readonly InterfaceTemplateInstance[];
}

export interface MappedInterfaceTemplate {
    readonly template: InterfaceTemplateSchema;
    readonly schema: Omit<InterfaceTemplateInstance, "name">;
}

/** Reflect concrete schema arguments without importing interface constructors. */
export function bindTemplateArguments(
    template: InterfaceTemplateSchema,
    parameters: Readonly<Record<string, Schema>>,
): Readonly<Record<string, InterfaceTemplateArgument>> {
    validateInterfaceTemplate(template);
    const expectedParameters = new Set<string>(template.parameters);
    const suppliedParameters = Object.keys(parameters);
    for (const name of suppliedParameters) {
        if (!expectedParameters.has(name)) {
            throw new Error(`Interface template "${template.id}" supplies unknown parameter "${name}"`);
        }
    }
    for (const name of expectedParameters) {
        if (!Object.hasOwn(parameters, name)) {
            throw new Error(`Interface template "${template.id}" is missing parameter "${name}"`);
        }
    }

    const arguments_: Record<string, InterfaceTemplateArgument> = {};
    for (const name of template.parameters) {
        const components: Record<string, LinkRpcJsonSchema> = {};
        const parameterSchema = parameters[name];
        if (parameterSchema === undefined) {
            throw new Error(`Interface template "${template.id}" is missing parameter "${name}"`);
        }
        const schema = zodToSvcJsonSchema(parameterSchema, {
            methodName: `template=${template.id}`,
            schemaPosition: `parameter=${name}`,
            components,
        });
        arguments_[name] = {
            schema,
            ...(Object.keys(components).length === 0
                ? {}
                : { components: { schemas: components } }),
        };
    }

    return arguments_;
}

/** Attach structural metadata to an already lowered schema, without rebuilding a definition. */
export function attachInterfaceTemplates(
    schema: LinkRpcInterfaceSchema,
    mapped: Readonly<Record<string, MappedInterfaceTemplate>>,
): LinkRpcInterfaceSchema {
    const templates: Record<string, InterfaceTemplateSchema> = Object.create(null);
    const instances: InterfaceTemplateInstance[] = [];
    for (const [name, instance] of Object.entries(mapped)) {
        const priorTemplate = templates[instance.template.id];
        if (priorTemplate !== undefined && !_jsonEqual(priorTemplate, instance.template)) {
            throw new Error(
                `Conflicting definitions for interface template "${instance.template.id}"`,
            );
        }
        templates[instance.template.id] = instance.template;
        instances.push({ ...instance.schema, name });
    }

    return {
        ...schema,
        [INTERFACE_TEMPLATES_EXTENSION]: { templates, instances } satisfies InterfaceTemplatesMetadata,
    };
}

export function validateInterfaceTemplates(schema: LinkRpcInterfaceSchema): void {
    const raw = schema[INTERFACE_TEMPLATES_EXTENSION];
    if (raw === undefined) return;
    if (!_isRecord(raw) || !_isRecord(raw.templates) || !Array.isArray(raw.instances)) {
        throw new SchemaValidationError(`${INTERFACE_TEMPLATES_EXTENSION} must contain templates and instances`);
    }

    const templates = raw.templates as Record<string, InterfaceTemplateSchema>;
    for (const [id, template] of Object.entries(templates)) {
        if (!_isRecord(template) || template.id !== id) {
            throw new SchemaValidationError(`Interface template key "${id}" must match its id`);
        }
        validateInterfaceTemplate(template);
    }

    const occupied = new Map<string, string>();
    const names = new Set<string>();
    for (const value of raw.instances) {
        if (!_isRecord(value)) throw new SchemaValidationError("Interface template instance must be an object");
        if (typeof value.name !== "string") throw new SchemaValidationError("Interface template instance name must be a string");
        if (typeof value.template !== "string") throw new SchemaValidationError("Interface template reference must be a string");
        if (value.prefix !== undefined) throw new SchemaValidationError("Interface template instances require explicit member mappings, not prefixes");
        if (!_isRecord(value.members)) throw new SchemaValidationError("Interface template members must be an object");
        if (!_isRecord(value.arguments)) throw new SchemaValidationError("Interface template arguments must be an object");
        const instance: InterfaceTemplateInstance = {
            name: value.name,
            template: value.template,
            members: value.members as Readonly<Record<string, string>>,
            arguments: value.arguments as Record<string, InterfaceTemplateArgument>,
        };
        _assertSegment(instance.name, "interface template instance name");
        if (names.has(instance.name)) {
            throw new SchemaValidationError(`Interface template instance name collision at "${instance.name}"`);
        }
        names.add(instance.name);
        const template = templates[instance.template];
        if (!Object.hasOwn(templates, instance.template)) {
            throw new SchemaValidationError(
                `Interface template instance "${instance.name}" references unknown template "${instance.template}"`,
            );
        }
        _validateArguments(instance, template);
        if (instance.members !== undefined) {
            for (const name of Object.keys(instance.members)) {
                if (!Object.hasOwn(template.methods, name)) throw new SchemaValidationError(`Unknown mapped member "${name}"`);
            }
            for (const name of Object.keys(template.methods)) {
                const target = instance.members[name];
                if (!Object.hasOwn(instance.members, name) || typeof target !== "string") {
                    throw new SchemaValidationError(`Missing mapped member "${name}"`);
                }
            }
        }
        _validateInstanceMethods(schema, instance, template, occupied);
    }
}

/**
 * Best-effort reflection selection, not template consumption or RPC validation.
 * Keep a whole document; incompatible explanations and ties retain the first.
 * Malformed optional metadata is unranked, while template-aware consumers still
 * use validateInterfaceTemplates and report its errors normally.
 */
export function preferRicherInterfaceSchema(
    existing: LinkRpcInterfaceSchema,
    candidate: LinkRpcInterfaceSchema,
): LinkRpcInterfaceSchema {
    if (existing.id !== candidate.id || existing.hash !== candidate.hash) return existing;
    if (computeInterfaceHash(existing) !== existing.hash || computeInterfaceHash(candidate) !== candidate.hash) {
        return existing;
    }
    const next = _rankingMetadata(candidate);
    if (next === undefined) return existing;
    const prior = _rankingMetadata(existing);
    if (prior === undefined) return candidate;
    for (const [id, template] of Object.entries(prior.templates)) {
        if (!Object.hasOwn(next.templates, id) || !_jsonEqual(template, next.templates[id])) return existing;
    }
    for (const instance of prior.instances) {
        if (!next.instances.some(value => _jsonEqual(instance, value))) return existing;
    }
    for (const [key, value] of Object.entries(prior)) {
        if (key !== 'templates' && key !== 'instances' && !_jsonEqual(value, (next as unknown as Record<string, unknown>)[key])) {
            return existing;
        }
    }
    return Object.keys(next.templates).length > Object.keys(prior.templates).length
        || next.instances.length > prior.instances.length ? candidate : existing;
}

function _rankingMetadata(schema: LinkRpcInterfaceSchema): InterfaceTemplatesMetadata | undefined {
    if (schema[INTERFACE_TEMPLATES_EXTENSION] === undefined) return undefined;
    try {
        validateInterfaceTemplates(schema);
    } catch (error) {
        if (!(error instanceof SchemaValidationError)) throw error;
        // Optional explanations must not turn otherwise valid reflection into a failure.
        return undefined;
    }
    return schema[INTERFACE_TEMPLATES_EXTENSION] as InterfaceTemplatesMetadata;
}

export function validateInterfaceTemplate(template: InterfaceTemplateSchema): void {
    if (!_isRecord(template) || typeof template.id !== "string" || template.id.length === 0) {
        throw new SchemaValidationError("Interface template id must be a non-empty string");
    }
    if (!Array.isArray(template.parameters) || !_isRecord(template.methods)) {
        throw new SchemaValidationError(`Interface template "${template.id}" must contain parameters and methods`);
    }
    const parameters = new Set<string>();
    for (const parameter of template.parameters) {
        if (typeof parameter !== "string" || parameter.length === 0) {
            throw new SchemaValidationError(`Interface template "${template.id}" has an invalid parameter name`);
        }
        if (parameters.has(parameter)) {
            throw new SchemaValidationError(`Interface template "${template.id}" repeats parameter "${parameter}"`);
        }
        parameters.add(parameter);
    }
    const components = _componentSchemas(template.components);
    for (const [name, method] of Object.entries(template.methods)) {
        _assertSegment(name, `member of interface template "${template.id}"`);
        if (!_isRecord(method) || !Object.hasOwn(method, "params")) {
            throw new SchemaValidationError(`Interface template "${template.id}" member "${name}" has no params`);
        }
        for (const field of _methodSchemaFields) {
            const value = method[field];
            if (field === "params" || value !== undefined) _validateTemplateSchema(value, parameters, components, new Set());
        }
        if (method.errors !== undefined && !Array.isArray(method.errors)) {
            throw new SchemaValidationError("Interface template method errors must be an array");
        }
        for (const error of method.errors ?? []) {
            if (!_isRecord(error)) {
                throw new SchemaValidationError("Interface template method error must be an object");
            }
            if (error.schema !== undefined) {
                _validateTemplateSchema(error.schema, parameters, components, new Set());
            }
            if (error.data !== undefined) {
                _validateTemplateSchema(error.data, parameters, components, new Set());
            }
        }
    }
    for (const component of Object.values(components)) {
        _validateTemplateSchema(component, parameters, components, new Set());
    }
}

function _validateTemplateSchema(
    schema: unknown,
    parameters: ReadonlySet<string>,
    components: Readonly<Record<string, InterfaceTemplateJsonSchema>>,
    seen: Set<object>,
): void {
    if (typeof schema === "boolean") return;
    if (!_isRecord(schema)) throw new SchemaValidationError("Interface template schema must be an object or boolean");
    if (seen.has(schema)) return;
    seen.add(schema);
    if ("$parameter" in schema) {
        if (Object.keys(schema).length !== 1 || typeof schema.$parameter !== "string") {
            throw new SchemaValidationError("A schema parameter reference must contain only $parameter");
        }
        if (!parameters.has(schema.$parameter)) {
            throw new SchemaValidationError(`Unknown schema parameter "${schema.$parameter}"`);
        }
        return;
    }
    if ("$ref" in schema) {
        if (typeof schema.$ref !== "string") throw new SchemaValidationError("Component reference must be a string");
        const name = componentSchemaName(schema.$ref);
        if (!Object.hasOwn(components, name)) {
            throw new SchemaValidationError(`Unknown interface template component "${name}"`);
        }
    }
    for (const child of _schemaChildren(schema)) {
        _validateTemplateSchema(child, parameters, components, seen);
    }
}

function _validateArguments(
    instance: InterfaceTemplateInstance,
    template: InterfaceTemplateSchema,
): void {
    const expected = new Set<string>(template.parameters);
    for (const name of Object.keys(instance.arguments)) {
        if (!expected.has(name)) {
            throw new SchemaValidationError(`Interface template instance "${instance.name}" supplies unknown parameter "${name}"`);
        }
    }
    for (const name of expected) {
        const argument = instance.arguments[name];
        if (!_isRecord(argument) || !Object.hasOwn(argument, "schema")) {
            throw new SchemaValidationError(`Interface template instance "${instance.name}" is missing parameter "${name}"`);
        }
        const components = _componentSchemas(argument.components);
        _validateConcreteSchema(argument.schema, components, new Set());
        for (const component of Object.values(components)) {
            _validateConcreteSchema(component, components, new Set());
        }
    }
}

function _validateConcreteSchema(
    schema: unknown,
    components: Readonly<Record<string, LinkRpcJsonSchema>>,
    seen: Set<object>,
): void {
    if (typeof schema === "boolean") return;
    if (!_isRecord(schema)) throw new SchemaValidationError("Concrete schema argument must be an object or boolean");
    if (seen.has(schema)) return;
    seen.add(schema);
    if ("$parameter" in schema) {
        throw new SchemaValidationError("Concrete schema arguments cannot contain $parameter");
    }
    if ("$ref" in schema) {
        if (typeof schema.$ref !== "string") throw new SchemaValidationError("Component reference must be a string");
        const name = componentSchemaName(schema.$ref);
        if (!Object.hasOwn(components, name)) {
            throw new SchemaValidationError(`Unknown schema argument component "${name}"`);
        }
    }
    for (const child of _schemaChildren(schema)) {
        _validateConcreteSchema(child, components, seen);
    }
}

function _validateInstanceMethods(
    schema: LinkRpcInterfaceSchema,
    instance: InterfaceTemplateInstance,
    template: InterfaceTemplateSchema,
    occupied: Map<string, string>,
): void {
    const expectedComponents: Record<string, LinkRpcJsonSchema> = {};
    const instantiatedMethods = Object.fromEntries(
        Object.entries(template.methods).map(([name, method]) => [
            name,
            _instantiateMethod(method, template, instance, expectedComponents),
        ]),
    );
    const actualComponents = schema.components?.schemas ?? {};
    for (const [name, expected] of Object.entries(instantiatedMethods)) {
        const flattenedName = interfaceTemplateMemberName(instance, name);
        _assertSegment(flattenedName, `mapped member of interface template instance "${instance.name}"`);
        const prior = occupied.get(flattenedName);
        if (prior !== undefined) {
            throw new SchemaValidationError(
                `Interface template member collision at "${flattenedName}" between "${prior}" and "${instance.name}"`,
            );
        }

        occupied.set(flattenedName, instance.name);
        const actual = schema.methods[flattenedName];
        if (actual === undefined) {
            throw new SchemaValidationError(`Interface template instance "${instance.name}" is missing mapped member "${flattenedName}"`);
        }
        if (!_methodsEquivalent(expected, actual, expectedComponents, actualComponents)) {
            throw new SchemaValidationError(
                `Interface template instance "${instance.name}" member "${flattenedName}" does not match its instantiated template`,
            );
        }
    }
}

export function interfaceTemplateMemberName(instance: InterfaceTemplateInstance, member: string): string {
    const mapped = instance.members[member];
    if (mapped !== undefined) return mapped;
    throw new Error(`Missing mapped member "${member}"`);
}

function _instantiateMethod(
    method: InterfaceTemplateMethodSchema,
    template: InterfaceTemplateSchema,
    instance: InterfaceTemplateInstance,
    components: Record<string, LinkRpcJsonSchema>,
): MethodSchema {
    const instantiate = (value: InterfaceTemplateJsonSchema): LinkRpcJsonSchema =>
        _instantiateSchema(value, template, instance, components, new Map());
    const result: MethodSchema = { ...method, params: instantiate(method.params) } as MethodSchema;
    for (const field of _methodSchemaFields.slice(1)) {
        const value = method[field];
        if (value !== undefined) result[field] = instantiate(value);
    }
    if (method.errors !== undefined) {
        result.errors = method.errors.map((error) => error.schema !== undefined
            ? { code: error.code, schema: instantiate(error.schema) }
            : {
                code: error.code,
                message: error.message,
                ...(error.type === undefined ? {} : { type: error.type }),
                ...(error.data === undefined ? {} : { data: instantiate(error.data) }),
            });
    }
    return result;
}

function _instantiateSchema(
    schema: InterfaceTemplateJsonSchema,
    template: InterfaceTemplateSchema,
    instance: InterfaceTemplateInstance,
    destination: Record<string, LinkRpcJsonSchema>,
    copied: Map<string, string>,
): LinkRpcJsonSchema {
    if (typeof schema === "boolean") return schema;
    if ("$parameter" in schema) {
        return _copyArgumentSchema(schema.$parameter, instance, destination, copied);
    }
    return _rewriteSchema(schema, (name) => {
        const key = `template:${template.id}:${name}`;
        if (!Object.hasOwn(destination, key)) {
            const component = template.components?.schemas?.[name];
            if (component === undefined) throw new Error(`Unknown interface template component "${name}"`);
            destination[key] = false;
            destination[key] = _instantiateSchema(component, template, instance, destination, copied);
        }
        return key;
    }, (child) => _instantiateSchema(child, template, instance, destination, copied));
}

function _copyArgumentSchema(
    parameter: string,
    instance: InterfaceTemplateInstance,
    destination: Record<string, LinkRpcJsonSchema>,
    copied: Map<string, string>,
): LinkRpcJsonSchema {
    const argument = instance.arguments[parameter];
    if (argument === undefined) throw new Error(`Missing schema argument "${parameter}"`);
    const rewrite = (schema: LinkRpcJsonSchema): LinkRpcJsonSchema =>
        _rewriteSchema(schema, (name) => {
            const sourceKey = `${parameter}:${name}`;
            const existing = copied.get(sourceKey);
            if (existing !== undefined) return existing;
            const target = `argument:${instance.name}:${parameter}:${name}`;
            copied.set(sourceKey, target);
            const component = argument.components?.schemas?.[name];
            if (component === undefined) throw new Error(`Unknown schema argument component "${name}"`);
            destination[target] = false;
            destination[target] = rewrite(component);
            return target;
        }, (child) => rewrite(child as LinkRpcJsonSchema));
    return rewrite(argument.schema);
}

function _rewriteSchema(
    schema: InterfaceTemplateJsonSchema | LinkRpcJsonSchema,
    rewriteRef: (name: string) => string,
    rewriteChild: (schema: InterfaceTemplateJsonSchema) => LinkRpcJsonSchema,
): LinkRpcJsonSchema {
    if (typeof schema === "boolean") return schema;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === "$ref" && typeof value === "string") {
            result.$ref = componentSchemaRef(rewriteRef(componentSchemaName(value)));
        } else if (key === "properties" && _isRecord(value)) {
            result.properties = Object.fromEntries(
                Object.entries(value).map(([name, child]) => [
                    name,
                    rewriteChild(child as InterfaceTemplateJsonSchema),
                ]),
            );
        } else if (key === "additionalProperties" || key === "items") {
            result[key] = typeof value === "boolean"
                ? value
                : rewriteChild(value as InterfaceTemplateJsonSchema);
        } else if (key === "prefixItems" || key === "anyOf" || key === "oneOf") {
            result[key] = (value as InterfaceTemplateJsonSchema[]).map(rewriteChild);
        } else {
            result[key] = value;
        }
    }
    return result as unknown as LinkRpcJsonSchema;
}

function _methodsEquivalent(
    expected: MethodSchema,
    actual: MethodSchema,
    expectedComponents: Readonly<Record<string, LinkRpcJsonSchema>>,
    actualComponents: Readonly<Record<string, LinkRpcJsonSchema>>,
): boolean {
    const expectedRest = { ...expected };
    const actualRest = { ...actual };
    for (const field of _methodSchemaFields) {
        const expectedSchema = expected[field];
        const actualSchema = actual[field];
        delete expectedRest[field];
        delete actualRest[field];
        if (expectedSchema === undefined || actualSchema === undefined) {
            if (expectedSchema !== actualSchema) return false;
        } else if (!_schemasEquivalent(expectedSchema, actualSchema, expectedComponents, actualComponents)) {
            return false;
        }
    }
    const expectedErrors = expectedRest.errors;
    const actualErrors = actualRest.errors;
    delete expectedRest.errors;
    delete actualRest.errors;
    if (!_jsonEqual(expectedRest, actualRest)) return false;
    if (expectedErrors === undefined || actualErrors === undefined) {
        return expectedErrors === actualErrors;
    }
    if (expectedErrors.length !== actualErrors.length) return false;
    return expectedErrors.every((error, index) => {
        const candidate = actualErrors[index];
        if (error.schema !== undefined || candidate.schema !== undefined) {
            return error.schema !== undefined
                && candidate.schema !== undefined
                && error.code === candidate.code
                && _schemasEquivalent(error.schema, candidate.schema, expectedComponents, actualComponents);
        }
        return error.code === candidate.code
            && error.type === candidate.type
            && error.message === candidate.message
            && (error.data === undefined || candidate.data === undefined
                ? error.data === candidate.data
                : _schemasEquivalent(error.data, candidate.data, expectedComponents, actualComponents));
    });
}

export function interfaceTemplateArgumentsEquivalent(
    left: InterfaceTemplateArgument,
    right: InterfaceTemplateArgument,
): boolean {
    return _schemasEquivalent(left.schema, right.schema, left.components?.schemas ?? {}, right.components?.schemas ?? {});
}

export function interfaceTemplatesEqual(left: InterfaceTemplateSchema, right: InterfaceTemplateSchema): boolean {
    return _jsonEqual(left, right);
}

function _schemasEquivalent(
    left: LinkRpcJsonSchema,
    right: LinkRpcJsonSchema,
    leftComponents: Readonly<Record<string, LinkRpcJsonSchema>>,
    rightComponents: Readonly<Record<string, LinkRpcJsonSchema>>,
    seen = new WeakMap<object, WeakSet<object>>(),
): boolean {
    if (typeof left === "boolean" || typeof right === "boolean") return left === right;
    let rights = seen.get(left);
    if (rights?.has(right)) return true;
    if (rights === undefined) {
        rights = new WeakSet();
        seen.set(left, rights);
    }
    rights.add(right);

    const leftRef = "$ref" in left ? left.$ref : undefined;
    const rightRef = "$ref" in right ? right.$ref : undefined;
    const leftOwn = leftRef === undefined ? _toRecord(left) : _withoutRef(left);
    const rightOwn = rightRef === undefined ? _toRecord(right) : _withoutRef(right);
    if (leftRef !== undefined && Object.keys(leftOwn).length === 0) {
        const resolved = leftComponents[componentSchemaName(leftRef)];
        return resolved !== undefined
            && _schemasEquivalent(resolved, right, leftComponents, rightComponents, seen);
    }
    if (rightRef !== undefined && Object.keys(rightOwn).length === 0) {
        const resolved = rightComponents[componentSchemaName(rightRef)];
        return resolved !== undefined
            && _schemasEquivalent(left, resolved, leftComponents, rightComponents, seen);
    }
    if (!_schemaObjectsEquivalent(leftOwn, rightOwn, leftComponents, rightComponents, seen)) return false;
    if (leftRef === undefined || rightRef === undefined) {
        if (leftRef === rightRef) return true;
        const ref = leftRef ?? rightRef!;
        const components = leftRef === undefined ? rightComponents : leftComponents;
        const resolved = components[componentSchemaName(ref)];
        if (resolved === undefined) return false;
        return leftRef === undefined
            ? _schemasEquivalent(left, resolved, leftComponents, components, seen)
            : _schemasEquivalent(resolved, right, components, rightComponents, seen);
    }
    const leftResolved = leftComponents[componentSchemaName(leftRef)];
    const rightResolved = rightComponents[componentSchemaName(rightRef)];
    return leftResolved !== undefined
        && rightResolved !== undefined
        && _schemasEquivalent(leftResolved, rightResolved, leftComponents, rightComponents, seen);
}

function _schemaObjectsEquivalent(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    leftComponents: Readonly<Record<string, LinkRpcJsonSchema>>,
    rightComponents: Readonly<Record<string, LinkRpcJsonSchema>>,
    seen: WeakMap<object, WeakSet<object>>,
): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (!_jsonEqual(leftKeys, rightKeys)) return false;
    for (const key of leftKeys) {
        const l = left[key];
        const r = right[key];
        if (key === "properties" && _isRecord(l) && _isRecord(r)) {
            const names = Object.keys(l).sort();
            if (!_jsonEqual(names, Object.keys(r).sort())) return false;
            if (!names.every((name) => _schemasEquivalent(
                l[name] as LinkRpcJsonSchema,
                r[name] as LinkRpcJsonSchema,
                leftComponents,
                rightComponents,
                seen,
            ))) return false;
        } else if ((key === "items" || key === "additionalProperties")
            && _isSchema(l) && _isSchema(r)) {
            if (!_schemasEquivalent(l, r, leftComponents, rightComponents, seen)) return false;
        } else if ((key === "prefixItems" || key === "anyOf" || key === "oneOf")
            && Array.isArray(l) && Array.isArray(r)) {
            if (l.length !== r.length || !l.every((value, index) =>
                _schemasEquivalent(
                    value as LinkRpcJsonSchema,
                    r[index] as LinkRpcJsonSchema,
                    leftComponents,
                    rightComponents,
                    seen,
                ))) return false;
        } else if (!_jsonEqual(l, r)) {
            return false;
        }
    }
    return true;
}

function _componentSchemas<T>(components: { readonly schemas?: Readonly<Record<string, T>> } | undefined): Readonly<Record<string, T>> {
    if (components === undefined) return {};
    if (!_isRecord(components) || (components.schemas !== undefined && !_isRecord(components.schemas))) {
        throw new SchemaValidationError("Schema components and component schemas must be objects");
    }
    return components.schemas ?? {};
}

function _schemaChildren(schema: Record<string, unknown>): unknown[] {
    const result: unknown[] = [];
    if (schema.properties !== undefined) {
        if (!_isRecord(schema.properties)) throw new SchemaValidationError("Schema properties must be an object");
        result.push(...Object.values(schema.properties));
    }
    for (const key of ["items", "additionalProperties"] as const) {
        const child = schema[key];
        if (child !== undefined) {
            if (!_isSchema(child)) throw new SchemaValidationError(`Schema ${key} must be an object or boolean`);
            result.push(child);
        }
    }
    for (const key of ["prefixItems", "anyOf", "oneOf"] as const) {
        const children = schema[key];
        if (children !== undefined) {
            if (!Array.isArray(children)) throw new SchemaValidationError(`Schema ${key} must be an array`);
            result.push(...children);
        }
    }
    return result;
}

const _methodSchemaFields = [
    "params",
    "result",
    "clientStream",
    "serverStream",
] as const;

const _segmentPattern = /^[A-Za-z0-9!#$%&'()*+,\-;=?@\[\]^_`{|}~]+$/;

function _assertSegment(value: string, label: string): void {
    if (!_segmentPattern.test(value)) {
        throw new SchemaValidationError(`Invalid ${label} "${value}"`);
    }
}

function _withoutRef(schema: object): Record<string, unknown> {
    const result = _toRecord(schema);
    delete result.$ref;
    return result;
}

function _toRecord(value: object): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value));
}

function _isSchema(value: unknown): value is LinkRpcJsonSchema {
    return typeof value === "boolean" || _isRecord(value);
}

function _isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _jsonEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left)
            && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => _jsonEqual(value, right[index]));
    }
    if (!_isRecord(left) || !_isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) =>
            key === rightKeys[index] && _jsonEqual(left[key], right[key]));
}
