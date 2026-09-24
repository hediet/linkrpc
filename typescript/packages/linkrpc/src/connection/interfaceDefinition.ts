import { any as zAny, void as zVoid } from 'zod/mini';
import type { RequestId } from '../protocol/jsonRpc';
import { computeInterfaceHash } from '../schema/hash';
import {
    type ApplicationErrorDescriptorBase,
    type DeclaredApplicationErrorOf,
    type PublicApplicationErrorOf,
    applicationError,
    rpcError,
    type MemberType,
    NotificationType,
    RequestType,
    type Schema,
    zodToSvcJsonSchema,
} from '../schema/memberTypes';
import { schemaToZod } from '../schema/schemaToZod';
import {
    attachInterfaceTemplates, getInterfaceTags, normalizeInterfaceTags, validateInterfaceTemplates, type MappedInterfaceTemplate,
} from '../schema/interfaceTemplates';
import type { MethodSchema, LinkRpcInterfaceSchema } from '../schema/linkRpcInterfaceSchema';
import type { LinkRpcJsonSchema } from '../schema/linkRpcJsonSchema';
import type { Result } from './rpcFailure';
import type { NonCompliantServerError } from './nonCompliantServerError';
import { validateInterfaceErrors } from '../schema/validateInterfaceErrors';
import { interfaceTemplateGroup, type InterfaceTemplateGroup } from '../schema/interfaceTemplateGroup';

/**
 * Per-call stream API handed to a request handler as its third argument.
 * Allows the handler to consume {@link STREAM_METHOD} notifications
 * emitted by the caller (`onMessage`) and emit stream notifications to
 * the caller (`send`) while the request is in flight.
 *
 * Members are typed by the originating method's
 * {@link RequestType.clientStreamSchema} / `serverStreamSchema`.
 * Streams whose schema is `undefined` make the corresponding member
 * effectively unusable: `send` is typed `(payload: never) => void` and
 * the registered `onMessage` listener can never fire because the
 * receiver-side validator rejects the wire payload.
 */
export interface StreamApi<TClient = unknown, TServer = unknown> {
    /** Emit a server→client stream message. */
    send(payload: TServer): Promise<void>;
    /**
     * Register a listener for client→server stream messages on this
     * request. Calling twice replaces the previous listener.
     */
    onMessage(listener: (payload: TClient) => void): void;
    /**
     * Liveness probe toward the caller: resolves once the caller
     * acknowledges with a matching pong, rejects if the call settles
     * first. Independent of the channel's automatic keepalive ping.
     */
    ping(): Promise<void>;
    /**
     * Aborts when the caller cancels this in-flight request, or when the
     * hub cancels it on the caller's behalf (caller disconnect / idle
     * timeout). Observe it to stop work early and settle the request
     * (e.g. `signal.throwIfAborted()`), which surfaces as a `cancelled`
     * error to the caller.
     */
    readonly signal: AbortSignal;
}

export interface InterfaceInfo {
    id: string;
    /** Non-normative discovery labels; do not affect interface identity. */
    tags?: readonly string[];
    /**
     * Normative description of the interface (markdown). Part of the
     * interface hash — changing it is a contract change.
     */
    description?: string;
    /** Non-normative implementation notes. Stripped from the hash. */
    comment?: string;
    /**
     * Optional expected content hash (see `computeInterfaceHash`). When
     * set, {@link InterfaceDefinition}'s constructor verifies that the
     * computed {@link InterfaceDefinition.schemaHash} matches and throws
     * otherwise — a guard against silent contract drift when the wire
     * shape changes but a pinned hash was not updated.
     */
    hash?: string;
}


export type MemberMap = Record<string, MemberType>;
export type InterfaceDeclarations = Record<string, MemberType | InterfaceTemplateGroup>;
type GroupWireName<Name extends string, K extends string, Mapping> =
    Mapping extends Record<string, string> ? Mapping[K] : `${Name}$${K}`;
type GroupWireMembers<Name extends string, G extends InterfaceTemplateGroup> = {
    readonly [K in keyof G['members'] & string as GroupWireName<Name, K, G['mapping']>]: G['members'][K];
};
type DeclarationWireMember<K extends string, M> = M extends InterfaceTemplateGroup
    ? GroupWireMembers<K, M> : M extends MemberType ? { readonly [N in K]: M } : never;
type DeclarationWireMembers<D extends InterfaceDeclarations> = {
    [K in keyof D & string]: DeclarationWireMember<K, D[K]>;
}[keyof D & string];
type WireKeys<U> = U extends MemberMap ? keyof U : never;
type WireValue<U, K extends PropertyKey> = U extends MemberMap ? K extends keyof U ? U[K] : never : never;
export type FlattenInterfaceDeclarations<D extends InterfaceDeclarations> =
    string extends keyof D ? MemberMap :
    { readonly [K in WireKeys<DeclarationWireMembers<D>>]: WireValue<DeclarationWireMembers<D>, K> };

/** Stable wire identity of one member in an interface definition. */
export interface InterfaceMemberRef<TName extends string = string> {
    readonly interfaceId: string;
    readonly interfaceHash: string;
    readonly member: TName;
}

export type InterfaceMemberRefMap<TMembers extends MemberMap> = {
    readonly [K in keyof TMembers & string]: InterfaceMemberRef<K>;
};

/**
 * Per-call options accepted by a streaming-enabled client method. Currently
 * only `onMessage` for consuming server→client stream notifications; the
 * caller addresses client→server stream messages via the returned
 * {@link StreamingCall}.
 */
export interface StreamCallOptions<TServer> {
    /** Listener for server→client stream messages on this in-flight call. */
    onMessage?: (payload: TServer) => void;
}

/**
 * Return shape of a streaming-enabled client method. Behaves as a
 * `Promise<TResult>` for the final response, and exposes `send` for
 * emitting client→server stream messages on the in-flight call. The
 * wire request id is also exposed (resolved once the request has
 * been allocated).
 *
 * For methods whose interface schema declares no client stream
 * (`TClient = never`), `send` is typed `(payload: never) => Promise<void>`
 * and is effectively uncallable — matching the runtime behavior, where
 * the receiver would drop client-emitted stream messages anyway.
 */
export interface StreamingCall<TResult, TClient> extends Promise<TResult> {
    /** Resolves to the wire request id once the call has been sent. */
    readonly requestId: Promise<RequestId>;
    /** Emit a client→server stream message on this in-flight call. */
    send(payload: TClient): Promise<void>;
    /**
     * Ask the callee to abort this in-flight call. Advisory: the call
     * settles via its normal response (typically a `cancelled` error).
     * `reason` is an open-set diagnostic string (see `StreamControlReason`).
     */
    cancel(reason?: string): Promise<void>;
    /**
     * Stop tracking this call locally. This does not notify the callee; call
     * {@link cancel} first when remote work should also be cancelled.
     */
    dispose?(reason?: string): void;
    /**
     * Liveness probe toward the callee: resolves once the callee
     * acknowledges with a matching pong, rejects if the call settles
     * first. Independent of the channel's automatic keepalive ping.
     */
    ping(): Promise<void>;
}

export interface RemoteRpcError {
    readonly kind: 'remote';
    readonly code: number;
    readonly message: string;
    readonly data?: import('../protocol/jsonValue').JsonValue;
}

export interface LocalRpcError {
    readonly kind: 'local';
    readonly cause: unknown;
}

export interface TransportRpcError {
    readonly kind: 'transport';
    readonly cause: unknown;
}

export type GenericRpcError = RemoteRpcError | LocalRpcError | TransportRpcError | NonCompliantServerError;
export type RpcCallError<E = never> =
    | { readonly kind: 'application'; readonly error: E }
    | { readonly kind: 'generic'; readonly error: GenericRpcError };

export type CheckedCallResult<TResult, TApplicationError = never> =
    | { readonly ok: true; readonly value: TResult; }
    | {
        readonly ok: false;
        readonly error: TApplicationError | GenericRpcError;
    };

export interface CheckedCall<TResult, TApplicationError = never> extends Promise<Result<TResult, TApplicationError>> {
    /**
     * @deprecated Use getResultClient() for values that include generic errors.
     */
    result(): Promise<CheckedCallResult<TResult, TApplicationError>>;
}

/**
 * `true` iff at least one stream direction is declared (either client or
 * server stream schema present). Used by {@link InterfaceClient} to pick
 * between the plain `Promise<R>` shape and the {@link StreamingCall}
 * shape per method.
 */
type _HasStream<TClient, TServer> = [TClient] extends [never] ? ([TServer] extends [never] ? false : true) :
    true;

type ClientCall<TResult, TApplicationError> = [TApplicationError] extends [never]
    ? Promise<TResult>
    : CheckedCall<TResult, TApplicationError>;
type ClientResult<R, E> = [E] extends [never] ? R : Result<R, E>;

/**
 * Compile-time TypeScript shape of an interface — useful for typed
 * client/server implementations on top of the runtime definition.
 *
 * Methods whose `RequestType` declares stream payloads via
 * `.withStream({ client, server })` return a {@link StreamingCall}
 * augmented with `send`; all others return a plain `Promise<TResult>`.
 *
 * @example
 *   type Client = InterfaceClient<typeof myInterface>;
 *   // => { bar(p: {...}): Promise<string>; foo(p: {...}): void; }
 */
type InterfaceClientMember<TMember> =
    TMember extends RequestType<infer P, infer R, infer E, infer TC, infer TS, any, any> ? (
        _HasStream<TC, TS> extends true ? (params: P, opts?: StreamCallOptions<TS>) =>
            StreamingCall<ClientResult<R, PublicApplicationErrorOf<E>>, TC> & ClientCall<R, PublicApplicationErrorOf<E>> :
        (params: P) => ClientCall<R, PublicApplicationErrorOf<E>>
    ) :
    TMember extends NotificationType<infer P> ? (params: P) => void :
    never;

type MembersClient<M extends MemberMap> = {
    [K in keyof M]: InterfaceClientMember<M[K]>;
};

/** A reusable consumer's client shape, independent of instance name or wire mapping. */
export type InterfaceTemplateClient<T extends InterfaceTemplateGroup> = MembersClient<T['members']>;

type DeclarationClient<M> = M extends InterfaceTemplateGroup
    ? InterfaceTemplateClient<M> : InterfaceClientMember<M>;

export type InterfaceClient<TDef extends InterfaceDefinition<any>> = {
    [K in keyof TDef['_declarations']]: DeclarationClient<TDef['_declarations'][K]>;
};

type InterfaceResultClientMember<TMember> = TMember extends
        RequestType<infer P, infer R, infer E, infer TC, infer TS, any, any>
        ? _HasStream<TC, TS> extends true
            ? (params: P, opts?: StreamCallOptions<TS>) =>
                StreamingCall<Result<R, RpcCallError<PublicApplicationErrorOf<E>>>, TC>
            : (params: P) => Promise<Result<R, RpcCallError<PublicApplicationErrorOf<E>>>>
        : TMember extends NotificationType<infer P> ? (params: P) => void : never;

type MembersResultClient<M extends MemberMap> = {
    [K in keyof M]: InterfaceResultClientMember<M[K]>;
};

/** Result-client counterpart of {@link InterfaceTemplateClient}. */
export type InterfaceTemplateResultClient<T extends InterfaceTemplateGroup> = MembersResultClient<T['members']>;

/** Every request returns failures as values, including methods with no declared errors. */
type DeclarationResultClient<M> = M extends InterfaceTemplateGroup
    ? InterfaceTemplateResultClient<M> : InterfaceResultClientMember<M>;

export type InterfaceResultClient<TDef extends InterfaceDefinition<any>> = {
    [K in keyof TDef['_declarations']]: DeclarationResultClient<TDef['_declarations'][K]>;
};

/**
 * Compile-time shape of a server implementation for an interface — used by
 * `LinkRpcConnection.register`. Request handlers may return synchronously or
 * via a promise; notification handlers return void.
 *
 * `TCtx` is the call-context type carried by the hosting connection — see
 * `LinkRpcConnection<TCtx>`. For the default connection (`TCtx = undefined`)
 * handlers may take a single params arg; for ctx-aware connections (e.g.
 * the hub's self connection) they may take a second `ctx` arg of the
 * concrete type. A 1-arg handler remains assignable where a 2-arg handler
 * is expected, so existing handlers compile unchanged.
 */
type InterfaceHandler<TMember, TCtx> =
    TMember extends RequestType<infer P, infer R, infer E, infer TC, infer TS, any, any> ?
    (params: P, ctx: TCtx, stream: StreamApi<TC, TS>) =>
        R | DeclaredApplicationErrorOf<E> |
        Promise<R | DeclaredApplicationErrorOf<E>> :
    TMember extends NotificationType<infer P> ? (params: P, ctx: TCtx) => void | Promise<void> :
    never;

type DeclarationHandler<M, TCtx> = M extends InterfaceTemplateGroup
    ? { [K in keyof M['members']]: InterfaceHandler<M['members'][K], TCtx> }
    : InterfaceHandler<M, TCtx>;
type KnownKeys<T> = keyof {
    [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: unknown;
};

export type InterfaceHandlers<
    TDef extends InterfaceDefinition<any>,
    TCtx = undefined,
> = {
        [K in keyof TDef['_declarations']]: DeclarationHandler<TDef['_declarations'][K], TCtx>;
    } & {
        // TypeScript includes inherited Object methods in structural assignments.
        // Own prototype-named aliases are still rejected by flattenHandlers.
        [K in Exclude<KnownKeys<TDef['members']>, keyof TDef['_declarations']>]?: K extends keyof Object ? Object[K] : never;
    };

/**
 * Options accepted by {@link InterfaceDefinition}'s constructor.
 *
 * `frozenSchema` lets callers supply an externally-authored
 * `LinkRpcInterfaceSchema` (e.g. produced by codegen or, in the faker, by an
 * LLM at runtime) verbatim. When set, `toSchema()` returns that document
 * (with `hash` overlaid) and `schemaHash` is computed from it — the
 * `members` map is used only for runtime dispatch (param/result
 * validation, stream routing) and is no longer the source of truth for
 * the wire shape.
 */
export interface InterfaceAuthoringOptions {
    /** Checked structural instances; implementations remain in connection.register(). */
    readonly templates?: Readonly<Record<string, MappedInterfaceTemplate>>;
}

export interface InterfaceDefinitionOpts extends InterfaceAuthoringOptions {
    frozenSchema?: LinkRpcInterfaceSchema;
}

interface InterfaceDefinitionState {
    readonly frozenSchema: LinkRpcInterfaceSchema | undefined;
    schemaCache: LinkRpcInterfaceSchema | undefined;
    hashCache: string | undefined;
    declarationGroups: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
}

const interfaceDefinitionState = new WeakMap<object, InterfaceDefinitionState>();

export class InterfaceDefinition<TMembers extends MemberMap, TDeclarations extends InterfaceDeclarations = TMembers> {
    /** Compile-time authoring shape shared by clients and handlers; wire members remain flat. */
    declare readonly _declarations: TDeclarations;
    /** Typed wire references for capability and access-request construction. */
    public readonly ref: InterfaceMemberRefMap<TMembers>;

    constructor(
        public readonly info: InterfaceInfo,
        public readonly members: TMembers,
        opts: InterfaceDefinitionOpts = {},
    ) {
        if (opts.frozenSchema !== undefined && opts.templates !== undefined) {
            throw new Error('Cannot combine frozenSchema with authored templates');
        }
        const frozenSchema = opts.templates === undefined ? opts.frozenSchema
            : attachInterfaceTemplates(buildSchema(info, members, ''), opts.templates);
        validateInterfaceErrors(frozenSchema);
        if (frozenSchema !== undefined) validateInterfaceTemplates(frozenSchema);
        const effectiveTags = frozenSchema === undefined
            ? normalizeInterfaceTags(info.tags ?? [])
            : getInterfaceTags(frozenSchema);
        if (info.tags !== undefined || effectiveTags.length > 0) {
            this.info = { ...info, tags: effectiveTags };
        }
        interfaceDefinitionState.set(this, {
            frozenSchema,
            schemaCache: undefined,
            hashCache: undefined,
            declarationGroups: undefined,
        });
        this.ref = Object.fromEntries(
            Object.keys(members).map((member) => [
                member,
                {
                    interfaceId: this.info.id,
                    interfaceHash: this.schemaHash,
                    member,
                },
            ]),
        ) as InterfaceMemberRefMap<TMembers>;
        if (info.hash !== undefined && this.schemaHash !== info.hash) {
            throw new Error(
                `Interface hash mismatch for "${info.id}": expected "${info.hash}", got "${this.schemaHash}". `
                + `The interface's wire contract changed — update the pinned hash to "${this.schemaHash}" after reviewing the change.`,
            );
        }
    }

    /** @internal Materialize authored groups using the existing wire call functions verbatim. */
    public nestClient(client: Record<string, unknown>): Record<string, unknown> {
        const groups = interfaceDefinitionState.get(this)!.declarationGroups;
        if (groups === undefined) return client;
        const groupedWireNames = new Set(Object.values(groups).flatMap(group => Object.values(group)));
        const result: Record<string, unknown> = Object.create(null);
        for (const [name, call] of Object.entries(client)) {
            if (!groupedWireNames.has(name)) result[name] = call;
        }
        for (const [name, mapping] of Object.entries(groups)) {
            const group: Record<string, unknown> = Object.create(null);
            for (const [member, wireName] of Object.entries(mapping)) group[member] = client[wireName];
            result[name] = group;
        }
        return result;
    }

    /** Validate grouped implementations atomically, then lower them to wire handlers. */
    public flattenHandlers(handlers: unknown): Record<string, unknown> {
        const groups = interfaceDefinitionState.get(this)!.declarationGroups;
        if (groups === undefined) return handlers as Record<string, unknown>;
        const requireObject = (value: unknown, where: string): Record<string, unknown> => {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error(`Expected handler group object at "${where}"`);
            }
            return value as Record<string, unknown>;
        };
        const implementation = requireObject(handlers, this.info.id);
        const groupedWireNames = new Set(Object.values(groups).flatMap(group => Object.values(group)));
        const flatNames = Object.keys(this.members).filter(name => !groupedWireNames.has(name));
        const expected = new Set([...Object.keys(groups), ...flatNames]);
        for (const key of Reflect.ownKeys(implementation)) {
            if (typeof key !== 'string' || !expected.has(key)) throw new Error(`Unexpected handler "${String(key)}"; grouped members require grouped handlers`);
        }
        const result: Record<string, unknown> = Object.create(null);
        const requireHandler = (object: Record<string, unknown>, key: string, where: string) => {
            if (!Object.hasOwn(object, key) || typeof object[key] !== 'function') {
                throw new Error(`Missing or invalid handler "${where}"`);
            }
            return object[key];
        };
        for (const name of flatNames) result[name] = requireHandler(implementation, name, name);
        for (const [name, mapping] of Object.entries(groups)) {
            if (!Object.hasOwn(implementation, name)) throw new Error(`Missing handler group "${name}"`);
            const group = requireObject(implementation[name], name);
            for (const member of Reflect.ownKeys(group)) {
                if (typeof member !== 'string' || !Object.hasOwn(mapping, member)) throw new Error(`Unexpected handler "${name}.${String(member)}"`);
            }
            for (const [member, wireName] of Object.entries(mapping)) {
                result[wireName] = requireHandler(group, member, `${name}.${member}`);
            }
        }
        return result;
    }

    /** Content hash of this interface (see `computeInterfaceHash`). */
    public get schemaHash(): string {
        const state = interfaceDefinitionState.get(this)!;
        if (state.hashCache === undefined) {
            const base = state.frozenSchema ?? buildSchema(this.info, this.members, '');
            state.hashCache = computeInterfaceHash(base);
        }
        return state.hashCache;
    }

    /** Lower the definition to a wire-format `LinkRpcInterfaceSchema`, hash filled in. */
    public toSchema(): LinkRpcInterfaceSchema {
        const state = interfaceDefinitionState.get(this)!;
        if (state.schemaCache === undefined) {
            state.schemaCache = state.frozenSchema !== undefined ?
                {
                    ...state.frozenSchema, hash: this.schemaHash,
                    ...(this.info.tags !== undefined ? { tags: [...this.info.tags] } : {}),
                } :
                buildSchema(this.info, this.members, this.schemaHash);
        }
        return state.schemaCache;
    }
}

function buildSchema(
    info: InterfaceInfo,
    members: MemberMap,
    hash: string,
): LinkRpcInterfaceSchema {
    const methods: Record<string, MethodSchema> = Object.create(null);
    const components: Record<string, LinkRpcJsonSchema> = {};
    for (const [name, member] of Object.entries(members)) {
        methods[name] = toMethodSchema(name, member, components);
    }
    const schema: LinkRpcInterfaceSchema = {
        id: info.id,
        hash,
        methods,
    };
    if (Object.keys(components).length > 0) schema.components = { schemas: components };
    if (info.description !== undefined) schema.description = info.description;
    if (info.comment !== undefined) schema.comment = info.comment;
    if (info.tags !== undefined) schema.tags = [...new Set(info.tags)];
    return schema;
}

export function toMethodSchema(
    name: string,
    member: MemberType,
    components: Record<string, LinkRpcJsonSchema>,
    convert: (schema: Schema, position: string) => LinkRpcJsonSchema =
        (schema, position) => convertMemberSchema(name, position, schema, components),
): MethodSchema {
    const docs = member.docs;

    if (member.kind === 'request') {
        const m: MethodSchema = {
            params: convert(member.paramsSchema, 'params'),
            result: convert(member.resultSchema, 'result'),
        };
        if (member.clientStreamSchema !== undefined) {
            m.clientStream = convert(member.clientStreamSchema, 'clientStream');
        }
        if (member.serverStreamSchema !== undefined) {
            m.serverStream = convert(member.serverStreamSchema, 'serverStream');
        }
        if (member.applicationErrors.length > 0) {
            m.errors = member.applicationErrors.map((error: ApplicationErrorDescriptorBase) => {
                if (error.bodySchema !== undefined) {
                    return {
                        code: error.code,
                        schema: convert(error.bodySchema, `error=${error.code}`),
                    };
                }
                const result: NonNullable<MethodSchema['errors']>[number] = {
                    code: error.code,
                    message: error.message!,
                    ...(error.type === undefined ? {} : { type: error.type }),
                };
                if (error.dataSchema !== undefined) {
                    result.data = convert(error.dataSchema, `error=${error.code}`);
                }
                return result;
            });
        }
        if (docs.description !== undefined) m.description = docs.description;
        if (docs.comment !== undefined) m.comment = docs.comment;
        if (docs.annotations !== undefined) m.annotations = docs.annotations;
        return m;
    }

    const m: MethodSchema = {
        params: convert(member.paramsSchema, 'params'),
    };
    if (docs.description !== undefined) m.description = docs.description;
    if (docs.comment !== undefined) m.comment = docs.comment;
    if (docs.annotations !== undefined) m.annotations = docs.annotations;
    return m;
}

function convertMemberSchema(
    methodName: string,
    position: string,
    schema: Schema,
    components: Record<string, LinkRpcJsonSchema>,
): LinkRpcJsonSchema {
    return zodToSvcJsonSchema(schema, {
        methodName,
        schemaPosition: position,
        components,
    });
}

/**
 * Convenient builder for an interface definition. Tracks TypeScript types
 * through `requestType` / `notificationType` so client and server code can
 * derive their shapes from the definition.
 *
 * @example
 *   const myInterface = defineInterface(
 *     { id: "de.hediet.notification-target" },
 *     {
 *       send: requestType(z.object({ to: z.string() }), z.string()),
 *       notify: notificationType(z.object({ message: z.string() })),
 *     },
 *   );
 */
export function defineInterface<const D extends InterfaceDeclarations>(
    info: InterfaceInfo,
    declarations: D,
    options: InterfaceAuthoringOptions = {},
): InterfaceDefinition<FlattenInterfaceDeclarations<D>, D> {
    const entries = Object.entries(declarations);
    const isGroup = (value: MemberType | InterfaceTemplateGroup): value is InterfaceTemplateGroup =>
        value !== null && typeof value === 'object' && interfaceTemplateGroup in value
        && value[interfaceTemplateGroup] === true;
    if (!entries.some(([, value]) => isGroup(value))) {
        return new InterfaceDefinition<FlattenInterfaceDeclarations<D>, D>(
            info, declarations as unknown as FlattenInterfaceDeclarations<D>, options,
        );
    }
    const members: MemberMap = Object.create(null);
    const groups: Record<string, Record<string, string>> = Object.create(null);
    const templates: Record<string, MappedInterfaceTemplate> = Object.assign(Object.create(null), options.templates);
    const groupNames = new Set(entries.filter(([, value]) => isGroup(value)).map(([name]) => name));
    const addMember = (name: string, member: MemberType) => {
        if (Object.hasOwn(members, name) || groupNames.has(name)) throw new Error(`Interface member collision at "${name}"`);
        members[name] = member;
    };
    for (const [name, declaration] of entries) {
        if (!isGroup(declaration)) {
            addMember(name, declaration);
            continue;
        }
        if (Object.hasOwn(templates, name)) throw new Error(`Interface template instance collision at "${name}"`);
        const mapping: Record<string, string> = Object.create(null);
        if (declaration.mapping !== undefined) {
            for (const member of Object.keys(declaration.mapping)) {
                if (!Object.hasOwn(declaration.members, member)) throw new Error(`Unknown mapped member "${member}"`);
            }
        }
        for (const [member, type] of Object.entries(declaration.members)) {
            if (declaration.mapping !== undefined && !Object.hasOwn(declaration.mapping, member)) {
                throw new Error(`Missing mapped member "${member}"`);
            }
            const wireName = declaration.mapping === undefined ? `${name}$${member}` : declaration.mapping[member];
            if (typeof wireName !== 'string' || wireName.length === 0) throw new Error(`Missing mapped member "${member}"`);
            addMember(wireName, type);
            mapping[member] = wireName;
        }
        groups[name] = Object.freeze(mapping);
        templates[name] = { template: declaration.template, schema: {
            template: declaration.template.id, arguments: declaration.arguments, members: mapping,
        } };
    }
    const definition = new InterfaceDefinition<FlattenInterfaceDeclarations<D>, D>(
        info, members as FlattenInterfaceDeclarations<D>,
        { ...options, templates },
    );
    interfaceDefinitionState.get(definition)!.declarationGroups = Object.freeze(groups);
    return definition;
}

/**
 * Build a runtime {@link InterfaceDefinition} from a previously-published
 * {@link LinkRpcInterfaceSchema} — typically one received over the wire (e.g.
 * from `hubrpc.schemas::get`) or generated at runtime by tooling that does
 * not have the original zod sources at hand (codegen, faker / mock
 * services, dynamic gateways).
 *
 * The original schema is kept verbatim: `toSchema()` returns it (with
 * `hash` overlaid) and `schemaHash` is computed from it, so reflection
 * consumers see the real wire contract. Member-level params / results /
 * streams use `z.any()` because no zod source is available — call-site
 * validation is therefore a no-op and the caller is responsible for
 * shape-checking inputs and outputs. Declared application-error payloads
 * are materialized and validated after code selection. A known code whose
 * body fails all declared branches is a noncompliant-server failure.
 *
 * Methods with no `result` descriptor become notifications; methods with
 * `clientStream` / `serverStream` get pass-through stream payload
 * schemas attached.
 */
export function interfaceFromSchema(schema: LinkRpcInterfaceSchema): InterfaceDefinition<MemberMap> {
    validateInterfaceErrors(schema);
    validateInterfaceTemplates(schema);
    const members: MemberMap = Object.create(null);
    for (const [name, method] of Object.entries(schema.methods)) {
        if (method.result === undefined) {
            members[name] = new NotificationType(zAny());
            continue;
        }
        const base = new RequestType<unknown, unknown, void>(zAny(), zAny(), zVoid())
            .withErrors((method.errors ?? []).map((error) => error.schema !== undefined
                ? rpcError(error.code, schemaToZod(error.schema, schema.components?.schemas))
                : error.type !== undefined
                ? error.data === undefined
                    ? applicationError(error.type, { code: error.code, message: error.message })
                    : applicationError(error.type, {
                        code: error.code, message: error.message,
                        data: schemaToZod(error.data, schema.components?.schemas),
                    })
                : error.data === undefined
                ? applicationError(error.code, error.message)
                : applicationError(error.code, error.message, schemaToZod(
                    error.data, schema.components?.schemas,
                ))));
        members[name] = method.clientStream !== undefined || method.serverStream !== undefined ?
            base.withStream({
                client: method.clientStream !== undefined ? zAny() : undefined,
                server: method.serverStream !== undefined ? zAny() : undefined,
            }) :
            base;
    }
    const info: InterfaceInfo = { id: schema.id };
    if (schema.description !== undefined) info.description = schema.description;
    if (schema.comment !== undefined) info.comment = schema.comment;
    if (schema.tags !== undefined) info.tags = schema.tags;
    return new InterfaceDefinition(info, members, { frozenSchema: schema });
}
