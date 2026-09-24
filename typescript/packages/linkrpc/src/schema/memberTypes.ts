import { object as zObject, string as zString, void as zVoid } from 'zod/mini';
import { toJSONSchema, type $ZodType, type output } from 'zod/v4/core';
import { normalizeJsonSchema } from './normalize';
import type { MemberAnnotations } from './linkRpcInterfaceSchema';
import type { LinkRpcJsonSchema } from './linkRpcJsonSchema';
import { isRpcFailure, type RpcFailure } from '../connection/rpcFailure';
import { ErrorCode } from '../protocol/jsonRpc';
import { applicationErrorBrand, brandApplicationError } from './applicationErrorBrand';
import { schemaSources } from './schemaSource';
import { parseDeclaredErrorBody, parseErrorBody } from './errorValidation';

/**
 * The schema type linkrpc accepts everywhere: the zod *core* base shared by
 * both classic `zod` and `zod/mini`. Typing against it (instead of classic
 * `z.ZodType`) lets callers author interfaces with either flavour — classic
 * for ergonomics, mini for minimal bundle size — while linkrpc's own internal
 * interfaces use mini. `O` is the validated output type.
 */
export type Schema<O = unknown> = $ZodType<O>;

/**
 * Marker base for a typed method member. Carries enough metadata to:
 *  - validate / parse params at runtime (via the zod schemas),
 *  - emit a JSON schema for reflection,
 *  - propagate TS types up to the interface definition.
 */
export type MemberType = RequestType<any, any, any, any, any, any, any> | NotificationType<any>;

export type ApplicationErrorValue<
    TCode extends number = number,
    TMessage extends string = string,
    TData = never,
    TType extends string | undefined = undefined,
> = {
    readonly kind: 'application';
    readonly code: TCode;
    readonly message: TMessage;
} & ([TData] extends [never] ? { readonly data?: never; } : { readonly data: TData; })
    & (TType extends string ? { readonly type: TType } : { readonly type?: never });

export type CreatedApplicationErrorValue<
    TCode extends number = number,
    TMessage extends string = string,
    TData = never,
    TType extends string | undefined = undefined,
> = ApplicationErrorValue<TCode, TMessage, TData, TType> & {
    readonly [applicationErrorBrand]: true;
    // Keep the branded base visible even while generic data/type conditionals are deferred.
    readonly kind: 'application';
    readonly code: TCode;
    readonly message: TMessage;
    readonly data?: TData;
    readonly type?: TType;
};

export interface ApplicationErrorDescriptor<
    TCode extends number = number,
    TMessage extends string = string,
    TData = never,
    TType extends string | undefined = undefined,
> {
    readonly code: TCode;
    readonly message: TMessage;
    readonly dataSchema?: Schema<TData>;
    readonly type: TType;
    /** Match a validated application payload or its failure wrapper. */
    is(value: RpcFailure<unknown>): value is RpcFailure<ApplicationErrorValue<TCode, string, TData, TType>>;
    is(value: { readonly kind: 'application' }): value is ApplicationErrorValue<TCode, string, TData, TType>;
    is(value: unknown): value is ApplicationErrorValue<TCode, string, TData, TType>
        | RpcFailure<ApplicationErrorValue<TCode, string, TData, TType>>;
    readonly create: [TData] extends [never]
        ? () => CreatedApplicationErrorValue<TCode, TMessage, TData, TType>
        : (data: TData) => CreatedApplicationErrorValue<TCode, TMessage, TData, TType>;
}

export interface ApplicationErrorDescriptorBase {
    readonly type?: string;
    readonly code: number;
    readonly message?: string;
    readonly bodySchema?: Schema;
    readonly dataSchema?: Schema<any>;
    readonly create: (...args: any[]) => {
        readonly kind: 'application';
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
        readonly type?: string;
        readonly [applicationErrorBrand]: true;
    };
}

export type ApplicationErrorOf<T> =
    T extends RpcErrorDescriptor<infer C, infer B>
        ? CreatedRpcErrorValue<C, B>
        : T extends ApplicationErrorDescriptor<infer C, infer M, infer D, infer N>
        ? CreatedApplicationErrorValue<C, M, D, N>
        : never;

// Legacy schemas can infer `any`; they must neither declare checked errors nor erase result types.
export type PublicApplicationErrorOf<T> =
    0 extends (1 & T) ? never :
    T extends { readonly [rawErrorBrand]: true }
        ? Omit<T, typeof applicationErrorBrand | typeof rawErrorBrand>
        : T extends CreatedApplicationErrorValue<infer C, infer M, infer D, infer N>
        ? ApplicationErrorValue<C, N extends string ? string : M, D, N>
        : never;

export type DeclaredApplicationErrorOf<T> = 0 extends (1 & T)
    ? never
    : Extract<T, ReturnType<ApplicationErrorDescriptorBase['create']>>;

export type ApplicationErrorsOf<T extends readonly ApplicationErrorDescriptorBase[]> =
    ApplicationErrorOf<T[number]>;

declare const rawErrorBrand: unique symbol;

export type RpcErrorBody = { readonly message: string; readonly data?: unknown };
export type RpcErrorValue<C extends number, B extends RpcErrorBody> =
    B & { readonly kind: 'application'; readonly code: C; readonly type?: never };
export type CreatedRpcErrorValue<C extends number, B extends RpcErrorBody> =
    RpcErrorValue<C, B> & { readonly [applicationErrorBrand]: true; readonly [rawErrorBrand]: true };

export interface RpcErrorDescriptor<C extends number = number, B extends RpcErrorBody = RpcErrorBody> {
    readonly code: C;
    readonly bodySchema: Schema<B>;
    readonly type?: never;
    readonly message?: never;
    readonly dataSchema?: never;
    create(body: B): CreatedRpcErrorValue<C, B>;
    is(value: RpcFailure<unknown>): value is RpcFailure<RpcErrorValue<C, B>>;
    is(value: { readonly kind: 'application' }): value is RpcErrorValue<C, B>;
    is(value: unknown): value is RpcErrorValue<C, B> | RpcFailure<RpcErrorValue<C, B>>;
}

type RawBody<M extends string, D extends Schema> = { message: M }
    & (D['_zod']['optout'] extends 'optional' ? { data?: output<D> } : { data: output<D> });

/** Declare an error selected by numeric code; its schema validates the body afterwards. */
export function rpcError<const C extends number, B>(
    code: C, schema: Schema<B>,
): RpcErrorDescriptor<C, unknown extends B ? RpcErrorBody : B & RpcErrorBody>;
export function rpcError<const C extends number, M extends string = string, D extends Schema = Schema>(
    code: C, shape: { message?: Schema<M>; data: D },
): RpcErrorDescriptor<C, RawBody<M, D>>;
export function rpcError<const C extends number, M extends string = string>(
    code: C, shape: { message?: Schema<M> },
): RpcErrorDescriptor<C, { message: M; data?: never }>;
export function rpcError(
    code: number, schemaOrShape: Schema | { message?: Schema<string>; data?: Schema },
): ApplicationErrorDescriptorBase {
    assertErrorCode(code);
    const bodySchema = '_zod' in schemaOrShape ? schemaOrShape : zObject({
        message: schemaOrShape.message ?? zString(),
        ...(schemaOrShape.data === undefined ? {} : { data: schemaOrShape.data }),
    });
    return Object.freeze({
        code,
        bodySchema,
        create(body: RpcErrorBody) {
            return brandApplicationError({
                kind: 'application' as const, code, message: body.message,
                ...(Object.hasOwn(body, 'data') ? { data: body.data } : {}),
            });
        },
        is(value: unknown): boolean {
            const payload = isRpcFailure(value) ? value.error : value;
            if (!isApplicationErrorValue(payload) || payload.code !== code || payload.type !== undefined) return false;
            return parseErrorBody(bodySchema, {
                message: payload.message,
                ...(Object.hasOwn(payload, 'data') ? { data: payload.data } : {}),
            }).success;
        },
    });
}

/** Declare one checked application error for use with {@link RequestType.withErrors}. */
export function applicationError<const TType extends string, TData, const TCode extends number = typeof ErrorCode.applicationError>(
    type: TType,
    options: { message?: string; data: Schema<TData>; code?: TCode },
): ApplicationErrorDescriptor<TCode, string, TData, TType>;
export function applicationError<const TType extends string, const TCode extends number = typeof ErrorCode.applicationError>(
    type: TType,
    options?: { message?: string; code?: TCode },
): ApplicationErrorDescriptor<TCode, string, never, TType>;
export function applicationError<const TCode extends number, const TMessage extends string>(
    code: TCode,
    message: TMessage,
): ApplicationErrorDescriptor<TCode, TMessage, never>;
export function applicationError<const TCode extends number, const TMessage extends string, TData>(
    code: TCode,
    message: TMessage,
    data: Schema<TData>,
): ApplicationErrorDescriptor<TCode, TMessage, TData>;
export function applicationError(
    codeOrType: number | string,
    messageOrOptions?: string | { message?: string; code?: number; data?: Schema<any> },
    dataSchema?: Schema<any>,
): ApplicationErrorDescriptorBase {
    const type = typeof codeOrType === 'string' ? codeOrType : undefined;
    if (type === '') throw new Error('Application error type must be a nonempty string.');
    const options = typeof messageOrOptions === 'object' ? messageOrOptions : undefined;
    const code = typeof codeOrType === 'number' ? codeOrType : options?.code ?? ErrorCode.applicationError;
    const message = type === undefined ? messageOrOptions : options?.message ?? type;
    if (type !== undefined) dataSchema = options?.data;
    assertApplicationErrorCode(code);
    if (typeof message !== 'string') throw new Error('Application error message must be a string.');
    const create = dataSchema === undefined
        ? function (this: void) {
            if (arguments.length !== 0) {
                throw new Error(`Application error ${code} does not accept data.`);
            }
            return Object.freeze({
                kind: 'application' as const,
                code,
                message,
                ...(type === undefined ? {} : { type }),
                [applicationErrorBrand]: true as const,
            });
        }
        : function (this: void, data: unknown) {
            if (arguments.length !== 1) {
                throw new Error(`Application error ${code} requires exactly one data value.`);
            }
            return Object.freeze({
                kind: 'application' as const,
                code,
                message,
                ...(type === undefined ? {} : { type }),
                [applicationErrorBrand]: true as const,
                data,
            });
        };
    const descriptor = Object.freeze({
        type,
        code,
        message,
        ...(dataSchema === undefined ? {} : { dataSchema }),
        create,
        is(value: unknown): boolean {
            const payload = isRpcFailure(value) ? value.error : value;
            if (!isApplicationErrorValue(payload)) return false;
            if (payload.kind !== 'application' || payload.code !== code || payload.type !== type) return false;
            const data = Object.hasOwn(payload, 'data') ? { data: payload.data } : {};
            return parseDeclaredErrorBody(descriptor, {
                message: payload.message,
                ...(type === undefined ? data : { data: { type, ...data } }),
            }).success;
        },
    });
    return descriptor;
}

/** Runtime nominal check for values produced by an application-error descriptor. */
export function isApplicationErrorValue(
    value: unknown,
): value is ReturnType<ApplicationErrorDescriptorBase['create']> {
    return typeof value === 'object' && value !== null
        && (value as { [applicationErrorBrand]?: unknown; })[applicationErrorBrand] === true;
}

function assertApplicationErrorCode(code: number): void {
    assertErrorCode(code);
    if ((code >= -32768 && code <= -32000) || code === -32800) {
        throw new Error(`Application error code ${code} is reserved by JSON-RPC or LinkRPC.`);
    }
}

function assertErrorCode(code: number): void {
    if (!Number.isInteger(code) || code < -2147483648 || code > 2147483647) {
        throw new Error(`Application error code ${code} must be a signed 32-bit integer.`);
    }
}

/**
 * Optional documentation for a method member.
 *
 * - `description` is the **normative** contract of the method (included in the
 *   interface hash — changing it changes `schemaHash`).
 * - `comment` is non-normative implementation notes (stripped from the hash).
 * - `annotations` are normative behavioral claims (e.g. `readOnly`,
 *   `idempotent`); included in the hash.
 */
export interface MemberDocs {
    description?: string;
    comment?: string;
    annotations?: MemberAnnotations;
}

export class RequestType<
    TParams = unknown,
    TResult = void,
    TError = void,
    TClientStream = never,
    TServerStream = never,
    TErrors extends readonly ApplicationErrorDescriptorBase[] = readonly ApplicationErrorDescriptorBase[],
    TLegacyError = TError,
> {
    public readonly kind = 'request' as const;

    constructor(
        public readonly paramsSchema: Schema<TParams>,
        public readonly resultSchema: Schema<TResult>,
        public readonly errorSchema: Schema<TLegacyError>,
        public readonly docs: MemberDocs = {},
        /**
         * Schema for stream messages the **client** may emit on an
         * in-flight call (e.g. cancellation, input). `undefined` means
         * the client may not stream on this method.
         */
        public readonly clientStreamSchema?: Schema<TClientStream>,
        /**
         * Schema for stream messages the **server** may emit while
         * handling an in-flight call (e.g. progress, partial results).
         * `undefined` means the server may not stream on this method.
         */
        public readonly serverStreamSchema?: Schema<TServerStream>,
        /** Checked application errors explicitly declared with `.withErrors()`. */
        public readonly applicationErrors: TErrors = [] as unknown as TErrors,
    ) {
        const seen = new Set<string>();
        for (const error of applicationErrors) {
            if (applicationErrors.some((other) => other !== error && other.code === error.code
                && (other.bodySchema !== undefined || error.bodySchema !== undefined))) {
                throw new Error(`Raw error code ${error.code} cannot be shared.`);
            }
            if (error.bodySchema !== undefined) {
                assertErrorCode(error.code);
                const key = `code:${error.code}`;
                if (seen.has(key)) throw new Error(`Duplicate application error ${key}.`);
                seen.add(key);
                continue;
            }
            assertApplicationErrorCode(error.code);
            if (typeof error.message !== 'string') {
                throw new Error('Application error message must be a string.');
            }
            if (error.type !== undefined && (typeof error.type !== 'string' || error.type.length === 0)) {
                throw new Error('Application error type must be a nonempty string.');
            }
            const key = error.type === undefined ? `code:${error.code}` : `type:${error.type}`;
            if (seen.has(key)) {
                throw new Error(`Duplicate application error ${key}.`);
            }
            seen.add(key);
        }
        this.applicationErrors = Object.freeze([...applicationErrors]) as unknown as TErrors;
        this.errors = this.applicationErrors;
    }

    /** Declared checked errors, retained as a tuple for generated-contract consumers. */
    public readonly errors: TErrors;

    /** Phantom field — typed-only, do not access at runtime. */
    declare readonly _params: TParams;
    declare readonly _result: TResult;
    declare readonly _error: TError;
    declare readonly _clientStream: TClientStream;
    declare readonly _serverStream: TServerStream;

    /**
     * Return a copy of this request type with stream payload schemas
     * attached. Pass `undefined` for either direction to leave it
     * closed.
     * `NoInfer` keeps a contextual MemberMap's `any` stream slots from
     * widening undeclared directions; only the supplied schemas infer payloads.
     */
    public withStream<TClient = TClientStream, TServer = TServerStream>(
        opts: {
            client?: Schema<TClient>;
            server?: Schema<TServer>;
        },
    ): RequestType<TParams, TResult, TError, NoInfer<TClient>, NoInfer<TServer>, TErrors, TLegacyError> {
        return new RequestType<TParams, TResult, TError, TClient, TServer, TErrors, TLegacyError>(
            this.paramsSchema,
            this.resultSchema,
            this.errorSchema,
            this.docs,
            opts.client,
            opts.server,
            this.applicationErrors,
        );
    }

    /**
     * Return a copy with an explicit, typed set of checked application errors.
     * The legacy third `requestType` schema remains accepted for compatibility,
     * but does not opt a method into checked errors.
     */
    public withErrors<const TErrors extends readonly ApplicationErrorDescriptorBase[]>(
        errors: TErrors,
    ): RequestType<TParams, TResult, ApplicationErrorsOf<TErrors>, TClientStream, TServerStream, TErrors, TLegacyError> {
        return new RequestType<TParams, TResult, ApplicationErrorsOf<TErrors>, TClientStream, TServerStream, TErrors, TLegacyError>(
            this.paramsSchema,
            this.resultSchema,
            this.errorSchema,
            this.docs,
            this.clientStreamSchema,
            this.serverStreamSchema,
            errors,
        );
    }
}

export class NotificationType<TParams = unknown> {
    public readonly kind = 'notification' as const;

    constructor(
        public readonly paramsSchema: Schema<TParams>,
        public readonly docs: MemberDocs = {},
    ) { }

    declare readonly _params: TParams;
}

/**
 * Define a request method.
 *
 * @example
 *   bar: requestType(z.object({ to: z.string() }), z.string(), {
 *     description: "MUST resolve before the next call from the same caller.",
 *   })
 */
export function requestType<
    TParams,
    TResult = void,
    TError = void,
>(
    params: Schema<TParams>,
    result?: Schema<TResult>,
    docsOrError?: MemberDocs | Schema<TError>,
    maybeDocs?: MemberDocs,
): RequestType<TParams, TResult, TError> {
    // A zod schema (params/result/error) vs. a `MemberDocs` object: every
    // Zod 4 schema carries the `_zod` marker (the library-author–blessed way
    // to detect one — see zod's "For library authors" guide), which plain
    // docs objects never have. Works for both classic and mini schemas.
    const isErrorSchema = (v: unknown): v is Schema<TError> =>
        typeof v === 'object' && v !== null && '_zod' in v;

    const error = isErrorSchema(docsOrError) ? docsOrError : undefined;
    const docs = (!isErrorSchema(docsOrError) ? docsOrError : maybeDocs) ?? {};

    return new RequestType(
        params,
        result ?? (zVoid() as unknown as Schema<TResult>),
        error ?? (zVoid() as unknown as Schema<TError>),
        docs,
    );
}

/**
 * Define a notification method.
 *
 * @example
 *   foo: notificationType(z.object({ message: z.string() }))
 */
export function notificationType<TParams>(
    params: Schema<TParams>,
    docs: MemberDocs = {},
): NotificationType<TParams> {
    return new NotificationType(params, docs);
}

export interface ZodToSvcJsonSchemaOptions {
    readonly methodName: string;
    readonly schemaPosition: string;
    readonly components: Record<string, LinkRpcJsonSchema>;
    /** Internal symbolic parameters used while reflecting a declarative factory. */
    readonly parameterNames?: WeakMap<Schema, string>;
}

/** Convert a zod schema to our restricted SvcJsonSchema subset. */
export function zodToSvcJsonSchema(
    schema: Schema,
    options?: ZodToSvcJsonSchemaOptions,
): LinkRpcJsonSchema {
    const source = schemaSources.get(schema);
    if (source !== undefined) {
        for (const [name, component] of Object.entries(source.components)) {
            if (options === undefined) throw new Error('Imported schema references require a component destination');
            addComponent(options.components, name, normalizeJsonSchema(component));
        }
        return normalizeJsonSchema(source.schema);
    }
    // `z.void()` / `z.undefined()` have no JSON-Schema representation —
    // `toJSONSchema` throws on them. Treat them as the trivially-true
    // schema (matches anything); JSON-RPC drops `undefined` from the wire
    // anyway, so this is the right structural answer for "no value".
    const type = (schema as { _zod?: { def?: { type?: string; }; }; })._zod?.def?.type;
    if (type === 'void' || type === 'undefined') return true;
    return normalizeZodJsonSchema(toJSONSchema(schema, {
        override: context => {
            const name = options?.parameterNames?.get(context.zodSchema);
            if (name !== undefined) {
                for (const key of Object.keys(context.jsonSchema)) delete context.jsonSchema[key];
                context.jsonSchema.$ref = `linkrpc-parameter:${encodeURIComponent(name)}`;
            } else if (options?.parameterNames !== undefined) {
                // Unlike numeric/string refinements, these change structural shape.
                // Normalization must not silently erase a parameter inside them.
                for (const key of ['allOf', 'patternProperties', 'unevaluatedProperties', 'if', 'then', 'else', 'contains']) {
                    if (key in context.jsonSchema) throw new Error(`Unsupported template JSON Schema keyword "${key}"`);
                }
            }
        },
    }), options);
}

function normalizeZodJsonSchema(
    raw: unknown,
    options: ZodToSvcJsonSchemaOptions | undefined,
): LinkRpcJsonSchema {
    if (!isRecord(raw)) return normalizeJsonSchema(raw);

    const definitions = isRecord(raw.$defs) ? raw.$defs : {};
    const localRefs = collectLocalRefs(raw);
    if (Object.keys(definitions).length === 0 && localRefs.size === 0) {
        return normalizeJsonSchema(raw);
    }
    if (options === undefined) {
        throw new Error(
            'zodToSvcJsonSchema: local references require a component destination',
        );
    }

    const componentNamePrefix =
        `method=${encodeComponentNamePart(options.methodName)}` +
        `&schema=${encodeComponentNamePart(options.schemaPosition)}`;
    const definitionComponents = new Map<string, string>();
    for (const definitionName of Object.keys(definitions)) {
        definitionComponents.set(
            definitionName,
            `${componentNamePrefix}&def=${encodeComponentNamePart(definitionName)}`,
        );
    }
    const rootComponent = localRefs.has('#')
        ? `${componentNamePrefix}&root`
        : undefined;
    const rewrite = (value: unknown): unknown =>
        rewriteLocalRefs(value, definitionComponents, rootComponent);

    for (const [definitionName, definition] of Object.entries(definitions)) {
        const componentName = definitionComponents.get(definitionName);
        if (componentName === undefined) {
            throw new Error(`zodToSvcJsonSchema: missing component for "${definitionName}"`);
        }
        addComponent(
            options.components,
            componentName,
            normalizeJsonSchema(rewrite(definition)),
        );
    }

    const root = rewrite(raw);
    if (rootComponent !== undefined) {
        addComponent(options.components, rootComponent, normalizeJsonSchema(root));
        return { $ref: componentRef(rootComponent) };
    }
    return normalizeJsonSchema(root);
}

function collectLocalRefs(value: unknown, refs = new Set<string>()): ReadonlySet<string> {
    if (Array.isArray(value)) {
        for (const child of value) collectLocalRefs(child, refs);
        return refs;
    }
    if (!isRecord(value)) return refs;
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#')) {
        refs.add(value.$ref);
    }
    for (const child of Object.values(value)) collectLocalRefs(child, refs);
    return refs;
}

function rewriteLocalRefs(
    value: unknown,
    definitionComponents: ReadonlyMap<string, string>,
    rootComponent: string | undefined,
): unknown {
    if (Array.isArray(value)) {
        return value.map((child) =>
            rewriteLocalRefs(child, definitionComponents, rootComponent));
    }
    if (!isRecord(value)) return value;

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === '$defs') continue;
        if (key === '$ref' && typeof child === 'string') {
            result[key] = rewriteLocalRef(child, definitionComponents, rootComponent);
        } else {
            result[key] = rewriteLocalRefs(child, definitionComponents, rootComponent);
        }
    }
    return result;
}

function rewriteLocalRef(
    ref: string,
    definitionComponents: ReadonlyMap<string, string>,
    rootComponent: string | undefined,
): string {
    if (ref === '#') {
        if (rootComponent === undefined) {
            throw new Error('zodToSvcJsonSchema: root reference has no component destination');
        }
        return componentRef(rootComponent);
    }

    const definitionPrefix = '#/$defs/';
    if (ref.startsWith(definitionPrefix)) {
        const encodedName = ref.slice(definitionPrefix.length);
        const definitionName = [...definitionComponents.keys()]
            .find((name) => encodeJsonPointerSegment(name) === encodedName);
        const componentName = definitionName === undefined
            ? undefined
            : definitionComponents.get(definitionName);
        if (componentName === undefined) {
            throw new Error(`zodToSvcJsonSchema: dangling local reference "${ref}"`);
        }
        return componentRef(componentName);
    }

    if (ref.startsWith('#') && !ref.startsWith('#/components/schemas/')) {
        throw new Error(`zodToSvcJsonSchema: unsupported local reference "${ref}"`);
    }
    return ref;
}

function addComponent(
    components: Record<string, LinkRpcJsonSchema>,
    name: string,
    schema: LinkRpcJsonSchema,
): void {
    if (Object.hasOwn(components, name)) {
        throw new Error(`zodToSvcJsonSchema: duplicate component name "${name}"`);
    }
    components[name] = schema;
}

function componentRef(name: string): string {
    return `#/components/schemas/${encodeJsonPointerSegment(name)}`;
}

function encodeJsonPointerSegment(value: string): string {
    return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function encodeComponentNamePart(value: string): string {
    return encodeURIComponent(value).replace(/~/g, '%7E');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
