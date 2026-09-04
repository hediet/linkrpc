import type { JsonValue } from '../../protocol/jsonValue';
import type {
    MemberAnnotations,
    MethodSchema,
    LinkRpcInterfaceSchema,
} from '../linkRpcInterfaceSchema';
import type { LinkRpcJsonSchema } from '../linkRpcJsonSchema';
import { CodeWriter } from './utils/codeWriter';

export interface GenerateInterfaceOptions {
    /**
     * Module specifier from which `defineInterface`, `requestType`,
     * `notificationType` are imported. Defaults to `@hediet/linkrpc`.
     */
    linkRpcImport?: string;
    /**
     * Identifier for the exported `InterfaceDefinition` const. Defaults to
     * a sanitized form of the interface id with an `Interface` suffix
     * (e.g. `hubrpc.directory` → `linkRpcDirectoryInterface`).
     */
    exportName?: string;
    /**
     * Preserve the supplied wire schema verbatim instead of reconstructing it
     * from the generated Zod schemas. This permits type-safe generation for
     * wire shapes that Zod represents differently, such as untagged `oneOf`.
     */
    preserveWireSchema?: boolean;
}

/**
 * Render a {@link LinkRpcInterfaceSchema} as a stand-alone TypeScript source
 * file that, when evaluated, reproduces the same canonical schema (and
 * therefore the same `schemaHash`).
 *
 * Components in `components.schemas` are emitted as named `const`
 * declarations referenced from the bodies via `$ref`.
 */
export function generateTsInterface(
    schema: LinkRpcInterfaceSchema,
    options: GenerateInterfaceOptions = {},
): string {
    const linkRpcImport = options.linkRpcImport ?? '@hediet/linkrpc';
    const exportName = options.exportName ?? _deriveExportName(schema.id);
    const preserveWireSchema = options.preserveWireSchema ?? false;

    const w = new CodeWriter();
    const definitionImport = preserveWireSchema ?
        'InterfaceDefinition, notificationType, requestType, type LinkRpcInterfaceSchema' :
        'defineInterface, notificationType, requestType';
    w.writeLine(`import { ${definitionImport} } from "${linkRpcImport}";`);
    w.writeLine(`import { z } from "zod";`);
    w.writeLine();

    const componentSchemas = schema.components?.schemas ?? {};
    const componentNames = new Map<string, string>();
    for (const name of Object.keys(componentSchemas)) {
        componentNames.set(name, _toComponentVar(name));
    }

    for (const [name, sub] of _sortComponents(componentSchemas)) {
        const varName = componentNames.get(name)!;
        _writeJsDoc(w, _schemaDescription(sub));
        w.append(`const ${varName} = `);
        _writeSchema(w, sub, componentNames, preserveWireSchema, name);
        w.append(';');
        w.newline();
        w.writeLine();
    }

    if (preserveWireSchema) {
        w.writeLine(
            `const wireSchema: LinkRpcInterfaceSchema = ${JSON.stringify(schema)};`,
        );
        w.writeLine();
    }

    _writeJsDoc(w, schema.description);
    w.append(
        `export const ${exportName} = ${preserveWireSchema ? 'new InterfaceDefinition' : 'defineInterface'}(`,
    );
    w.newline();
    w.indent();
    _writeInterfaceInfo(w, schema, preserveWireSchema);
    w.append(',');
    w.newline();
    _writeMembers(w, schema.methods, componentNames, componentSchemas, preserveWireSchema);
    w.append(',');
    w.newline();
    if (preserveWireSchema) {
        w.writeLine('{ frozenSchema: wireSchema },');
    }
    w.dedent();
    w.writeLine(');');

    return w.toString();
}

// ---------------------------------------------------------------- info

function _writeInterfaceInfo(
    w: CodeWriter,
    schema: LinkRpcInterfaceSchema,
    includeHash: boolean,
): void {
    w.append('{').newline();
    w.indent();
    w.append(`id: ${JSON.stringify(schema.id)},`).newline();
    if (schema.description !== undefined) {
        w.append(`description: ${JSON.stringify(schema.description)},`).newline();
    }
    if (schema.comment !== undefined) {
        w.append(`comment: ${JSON.stringify(schema.comment)},`).newline();
    }
    if (includeHash) {
        w.append(`hash: ${JSON.stringify(schema.hash)},`).newline();
    }
    w.dedent();
    w.append('}');
}

// ------------------------------------------------------------- members

function _writeMembers(
    w: CodeWriter,
    methods: Record<string, MethodSchema>,
    components: Map<string, string>,
    componentSchemas: Record<string, LinkRpcJsonSchema>,
    preserveWireSchema: boolean,
): void {
    w.append('{').newline();
    w.indent();
    for (const [name, method] of Object.entries(methods)) {
        _writeJsDoc(w, _methodDescription(method, componentSchemas));
        w.append(`${_propKey(name)}: `);
        _writeMethod(w, method, components, preserveWireSchema);
        w.append(',');
        w.newline();
    }
    w.dedent();
    w.append('}');
}

function _writeMethod(
    w: CodeWriter,
    method: MethodSchema,
    components: Map<string, string>,
    preserveWireSchema: boolean,
): void {
    const docs = _collectMemberDocs(method);

    if (method.result === undefined) {
        w.append('notificationType(').newline();
        w.indent();
        _writeSchema(w, method.params, components, preserveWireSchema);
        w.append(',').newline();
        if (docs !== undefined) {
            _writeDocs(w, docs);
            w.append(',').newline();
        }
        w.dedent();
        w.append(')');
        return;
    }

    w.append('requestType(').newline();
    w.indent();
    _writeSchema(w, method.params, components, preserveWireSchema);
    w.append(',').newline();
    _writeSchema(w, method.result, components, preserveWireSchema);
    w.append(',').newline();
    if (docs !== undefined) {
        _writeDocs(w, docs);
        w.append(',').newline();
    }
    w.dedent();
    w.append(')');

    // Streams attach through `withStream({ client?, server? })`.
    if (method.clientStream !== undefined || method.serverStream !== undefined) {
        w.append('.withStream({').newline();
        w.indent();
        if (method.clientStream !== undefined) {
            w.append('client: ');
            _writeSchema(w, method.clientStream, components, preserveWireSchema);
            w.append(',').newline();
        }
        if (method.serverStream !== undefined) {
            w.append('server: ');
            _writeSchema(w, method.serverStream, components, preserveWireSchema);
            w.append(',').newline();
        }
        w.dedent();
        w.append('})');
    }
}

interface CollectedDocs {
    description?: string;
    comment?: string;
    annotations?: MemberAnnotations;
}

function _collectMemberDocs(method: MethodSchema): CollectedDocs | undefined {
    const docs: CollectedDocs = {};
    if (method.description !== undefined) docs.description = method.description;
    if (method.comment !== undefined) docs.comment = method.comment;
    if (method.annotations !== undefined && Object.keys(method.annotations).length > 0) {
        docs.annotations = method.annotations;
    }
    return docs.description === undefined && docs.comment === undefined && docs.annotations === undefined ?
        undefined :
        docs;
}

function _writeDocs(w: CodeWriter, docs: CollectedDocs): void {
    w.append('{').newline();
    w.indent();
    if (docs.description !== undefined) {
        w.append(`description: ${JSON.stringify(docs.description)},`).newline();
    }
    if (docs.comment !== undefined) {
        w.append(`comment: ${JSON.stringify(docs.comment)},`).newline();
    }
    if (docs.annotations !== undefined) {
        w.append(`annotations: ${JSON.stringify(docs.annotations)},`).newline();
    }
    w.dedent();
    w.append('}');
}

// ------------------------------------------------------------- schemas

/**
 * Emit a zod expression equivalent to `schema`. The expression begins at
 * the writer's current line position and may span multiple lines; it
 * ends without a trailing newline so the caller can append punctuation.
 */
function _writeSchema(
    w: CodeWriter,
    schema: LinkRpcJsonSchema,
    components: Map<string, string>,
    preserveWireSchema = false,
    currentComponent?: string,
): void {
    if (schema === true) {
        _writeMetaWrapped(w, 'z.unknown()', undefined);
        return;
    }
    if (schema === false) {
        _writeMetaWrapped(w, 'z.never()', undefined);
        return;
    }

    const s = schema as unknown as Record<string, unknown>;

    // $ref -> component variable
    if (typeof s['$ref'] === 'string') {
        const refName = _parseRef(s['$ref']);
        const varName = components.get(refName);
        if (varName === undefined) {
            throw new Error(`generateInterface: dangling $ref "${s['$ref']}"`);
        }
        _writeMetaWrapped(w, varName, _metaOf(s));
        return;
    }

    // const / enum
    if ('const' in s) {
        _writeMetaWrapped(w, `z.literal(${_jsonLiteral(s['const'] as JsonValue)})`, _metaOf(s));
        return;
    }
    if (Array.isArray(s['enum'])) {
        const values = s['enum'] as JsonValue[];
        if (values.every((v) => typeof v === 'string')) {
            const tuple = (values as string[]).map((v) => JSON.stringify(v)).join(', ');
            _writeMetaWrapped(w, `z.enum([${tuple}])`, _metaOf(s));
            return;
        }
        // Heterogeneous enums become a union of literals.
        const branches = values.map((v) => `z.literal(${_jsonLiteral(v)})`).join(', ');
        _writeMetaWrapped(w, `z.union([${branches}])`, _metaOf(s));
        return;
    }

    // anyOf / oneOf
    if (Array.isArray(s['oneOf'])) {
        const branches = s['oneOf'] as LinkRpcJsonSchema[];
        const disc = s['discriminator'] as { propertyName?: string; } | undefined;
        if (disc?.propertyName !== undefined) {
            _writeUnion(
                w,
                'z.discriminatedUnion',
                branches,
                components,
                preserveWireSchema,
                currentComponent,
                disc.propertyName,
            );
        } else if (preserveWireSchema) {
            _writeUnion(w, 'z.union', branches, components, preserveWireSchema, currentComponent);
        } else {
            // No usable discriminator: fall back to `z.union`. The
            // resulting JSON schema will say `anyOf` instead of `oneOf`,
            // which changes structurally — we surface that loudly.
            throw new Error(
                'generateInterface: `oneOf` without a `discriminator` is not representable.',
            );
        }
        _writeMetaSuffix(w, _metaOf(s));
        return;
    }
    if (Array.isArray(s['anyOf'])) {
        _writeUnion(
            w,
            'z.union',
            s['anyOf'] as LinkRpcJsonSchema[],
            components,
            preserveWireSchema,
            currentComponent,
        );
        _writeMetaSuffix(w, _metaOf(s));
        return;
    }

    // object
    if (s['type'] === 'object') {
        _writeObject(w, s, components, preserveWireSchema, currentComponent);
        _writeMetaSuffix(w, _metaOf(s));
        return;
    }

    // tuple
    if (s['type'] === 'array' && Array.isArray(s['prefixItems'])) {
        _writeTuple(w, s, components, preserveWireSchema, currentComponent);
        _writeMetaSuffix(w, _metaOf(s));
        return;
    }

    // array
    if (s['type'] === 'array') {
        const items = (s['items'] as LinkRpcJsonSchema | undefined) ?? true;
        w.append('z.array(');
        _writeSchema(w, items, components, preserveWireSchema, currentComponent);
        w.append(')');
        _writeMetaSuffix(w, _metaOf(s));
        return;
    }

    // primitives
    const primitive = _primitiveExpr(s);
    if (primitive !== undefined) {
        _writeMetaWrapped(w, primitive, _metaOf(s));
        return;
    }

    throw new Error(`generateInterface: unsupported schema: ${JSON.stringify(schema)}`);
}

function _writeObject(
    w: CodeWriter,
    s: Record<string, unknown>,
    components: Map<string, string>,
    preserveWireSchema: boolean,
    currentComponent?: string,
): void {
    const properties = (s['properties'] as Record<string, LinkRpcJsonSchema> | undefined) ?? {};
    const required = new Set((s['required'] as string[] | undefined) ?? []);
    const additional = s['additionalProperties'];

    const constructor = additional === false || additional === undefined ?
        'z.object' :
        'z.looseObject';

    const keys = Object.keys(properties);
    if (keys.length === 0) {
        w.append(`${constructor}({})`);
    } else {
        w.append(`${constructor}({`).newline();
        w.indent();
        for (const key of keys) {
            const property = properties[key]!;
            _writeJsDoc(w, _schemaDescription(property));
            const recursive = currentComponent !== undefined &&
                _containsRef(property, currentComponent);
            if (recursive) {
                w.append(`get ${_propKey(key)}() {`).newline();
                w.indent();
                w.append('return ');
                _writeSchema(w, property, components, preserveWireSchema, currentComponent);
                if (!required.has(key)) w.append('.optional()');
                w.append(';').newline();
                w.dedent();
                w.append('},').newline();
            } else {
                w.append(`${_propKey(key)}: `);
                _writeSchema(w, property, components, preserveWireSchema, currentComponent);
                if (!required.has(key)) w.append('.optional()');
                w.append(',').newline();
            }
        }
        w.dedent();
        w.append('})');
    }

    // `additionalProperties: <schema>` (not `false`, not `true`/missing) lowers
    // through `.catchall(...)`.
    if (additional !== false && additional !== undefined && additional !== true) {
        w.append('.catchall(');
        _writeSchema(w, additional as LinkRpcJsonSchema, components, preserveWireSchema, currentComponent);
        w.append(')');
    }
}

function _writeTuple(
    w: CodeWriter,
    s: Record<string, unknown>,
    components: Map<string, string>,
    preserveWireSchema: boolean,
    currentComponent?: string,
): void {
    const prefix = s['prefixItems'] as LinkRpcJsonSchema[];
    w.append('z.tuple([').newline();
    w.indent();
    for (const item of prefix) {
        _writeSchema(w, item, components, preserveWireSchema, currentComponent);
        w.append(',').newline();
    }
    w.dedent();
    w.append('])');

    const rest = s['items'];
    if (rest !== undefined && rest !== false) {
        w.append('.rest(');
        _writeSchema(w, rest as LinkRpcJsonSchema, components, preserveWireSchema, currentComponent);
        w.append(')');
    }
}

function _writeUnion(
    w: CodeWriter,
    constructor: 'z.union' | 'z.discriminatedUnion',
    branches: LinkRpcJsonSchema[],
    components: Map<string, string>,
    preserveWireSchema: boolean,
    currentComponent?: string,
    discriminator?: string,
): void {
    if (constructor === 'z.discriminatedUnion' && discriminator !== undefined) {
        w.append(`${constructor}(${JSON.stringify(discriminator)}, [`).newline();
    } else {
        w.append(`${constructor}([`).newline();
    }
    w.indent();
    for (const branch of branches) {
        _writeSchema(w, branch, components, preserveWireSchema, currentComponent);
        w.append(',').newline();
    }
    w.dedent();
    w.append('])');
}

function _primitiveExpr(s: Record<string, unknown>): string | undefined {
    const type = s['type'];
    const format = s['format'] as string | undefined;
    switch (type) {
        case 'null':
            return 'z.null()';
        case 'boolean':
            return 'z.boolean()';
        case 'string':
            return _stringExpr(format);
        case 'integer':
            return _integerExpr(format);
        case 'number':
            return _numberExpr(format);
        default:
            return undefined;
    }
}

function _stringExpr(format: string | undefined): string {
    if (format === undefined) return 'z.string()';
    // Well-known formats supported by zod 4. Unknown formats fall back to
    // a plain string — `format` is opaque in our subset.
    switch (format) {
        case 'email':
            return 'z.email()';
        case 'uri':
        case 'url':
            return 'z.url()';
        case 'uuid':
            return 'z.uuid()';
        case 'date-time':
            return 'z.iso.datetime()';
        case 'date':
            return 'z.iso.date()';
        case 'time':
            return 'z.iso.time()';
        case 'duration':
            return 'z.iso.duration()';
        case 'ipv4':
            return 'z.ipv4()';
        case 'ipv6':
            return 'z.ipv6()';
        case 'base64':
            return 'z.base64()';
        case 'base64url':
            return 'z.base64url()';
        case 'nanoid':
            return 'z.nanoid()';
        case 'cuid':
            return 'z.cuid()';
        case 'cuid2':
            return 'z.cuid2()';
        case 'ulid':
            return 'z.ulid()';
        default:
            return 'z.string()';
    }
}

function _integerExpr(format: string | undefined): string {
    switch (format) {
        case 'int32':
            return 'z.int32()';
        case 'uint32':
            return 'z.uint32()';
        case 'int64':
            return 'z.int64()';
        case 'uint64':
            return 'z.uint64()';
        case undefined:
            return 'z.int()';
        default:
            return 'z.int()';
    }
}

function _numberExpr(format: string | undefined): string {
    switch (format) {
        case 'float32':
            return 'z.float32()';
        case 'float64':
            return 'z.float64()';
        case undefined:
            return 'z.number()';
        default:
            return 'z.number()';
    }
}

// ----------------------------------------------------------- meta wrapping

interface SchemaMeta {
    title?: string;
    description?: string;
}

function _metaOf(s: Record<string, unknown>): SchemaMeta | undefined {
    const meta: SchemaMeta = {};
    if (typeof s['description'] === 'string') meta.description = s['description'];
    if (typeof s['title'] === 'string') meta.title = s['title'];
    return meta.description === undefined && meta.title === undefined ? undefined : meta;
}

/** Wrap a single-line zod expression with `.describe()` / `.meta()`. */
function _writeMetaWrapped(w: CodeWriter, expr: string, meta: SchemaMeta | undefined): void {
    w.append(expr);
    _writeMetaSuffix(w, meta);
}

function _writeMetaSuffix(w: CodeWriter, meta: SchemaMeta | undefined): void {
    if (meta === undefined) return;
    if (meta.title === undefined && meta.description !== undefined) {
        w.append(`.describe(${JSON.stringify(meta.description)})`);
        return;
    }
    const entries: string[] = [];
    if (meta.title !== undefined) entries.push(`title: ${JSON.stringify(meta.title)}`);
    if (meta.description !== undefined) entries.push(`description: ${JSON.stringify(meta.description)}`);
    w.append(`.meta({ ${entries.join(', ')} })`);
}

// ----------------------------------------------------------------- utils

function _methodDescription(
    method: MethodSchema,
    components: Record<string, LinkRpcJsonSchema>,
): string | undefined {
    if (method.description !== undefined) return method.description;
    if (method.params === true || method.params === false) return undefined;
    const params = method.params as unknown as Record<string, unknown>;
    if (typeof params['$ref'] !== 'string') return _schemaDescription(method.params);
    return _schemaDescription(components[_parseRef(params['$ref'])]);
}

function _schemaDescription(schema: LinkRpcJsonSchema | undefined): string | undefined {
    if (schema === undefined || schema === true || schema === false) return undefined;
    const value = schema as unknown as Record<string, unknown>;
    if (typeof value['description'] === 'string') return value['description'];
    return typeof value['title'] === 'string' ? value['title'] : undefined;
}

function _writeJsDoc(w: CodeWriter, description: string | undefined): void {
    if (description === undefined || description.length === 0) return;
    w.writeLine('/**');
    for (const line of description.replaceAll('*/', '*\\/').split(/\r?\n/)) {
        w.writeLine(line.length === 0 ? ' *' : ` * ${line}`);
    }
    w.writeLine(' */');
}

function _sortComponents(
    schemas: Record<string, LinkRpcJsonSchema>,
): [string, LinkRpcJsonSchema][] {
    const result: [string, LinkRpcJsonSchema][] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (name: string): void => {
        if (visited.has(name)) return;
        if (visiting.has(name)) {
            throw new Error(
                `generateInterface: mutually recursive component schemas are not supported (cycle at "${name}").`,
            );
        }

        const schema = schemas[name];
        if (schema === undefined) return;
        visiting.add(name);
        for (const dependency of _collectRefs(schema)) {
            if (dependency !== name && schemas[dependency] !== undefined) {
                visit(dependency);
            }
        }
        visiting.delete(name);
        visited.add(name);
        result.push([name, schema]);
    };

    for (const name of Object.keys(schemas)) visit(name);
    return result;
}

function _collectRefs(value: unknown, refs = new Set<string>()): Set<string> {
    if (value === null || typeof value !== 'object') return refs;
    if (Array.isArray(value)) {
        for (const item of value) _collectRefs(item, refs);
        return refs;
    }
    const record = value as Record<string, unknown>;
    if (typeof record['$ref'] === 'string') {
        refs.add(_parseRef(record['$ref']));
    }
    for (const child of Object.values(record)) _collectRefs(child, refs);
    return refs;
}

function _containsRef(schema: LinkRpcJsonSchema, name: string): boolean {
    return _collectRefs(schema).has(name);
}

function _propKey(name: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function _jsonLiteral(value: JsonValue): string {
    return JSON.stringify(value);
}

function _parseRef(ref: string): string {
    const prefix = '#/components/schemas/';
    if (!ref.startsWith(prefix)) {
        throw new Error(`generateInterface: unsupported $ref "${ref}"`);
    }
    return ref.slice(prefix.length);
}

function _toComponentVar(name: string): string {
    const sanitized = name.replace(/[^A-Za-z0-9_$]/g, '_');
    const base = /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
    return base + 'Schema';
}

function _deriveExportName(id: string): string {
    const parts = id.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0);
    if (parts.length === 0) return 'iface';
    const camel = parts[0]!.toLowerCase() +
        parts.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join('');
    return camel + 'Interface';
}
