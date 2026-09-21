import type { LinkRpcJsonSchema } from './linkRpcJsonSchema';

/**
 * Minimal interface schema for linkrpc. A strict subset of OpenRPC 1.x:
 * identity & addressing live in linkrpc, so this format only describes the
 * contract of a single interface (methods + reusable JSON Schemas).
 */
export interface LinkRpcInterfaceSchema {
    [key: `x-${string}`]: unknown;
    /** Stable interface id, e.g. "de.hediet.notification-target". */
    id: string;

    /**
     * Content hash of the normalized schema. Pairs with `id` to form `id@hash`.
     * Normalization: serialize this object with `hash` omitted, object keys
     * sorted recursively, and no insignificant whitespace; hash the bytes.
     */
    hash: string;

    /**
     * Normative human description (GitHub-flavored markdown). Part of the
     * interface hash — changing `description` is a contract change. Use it
     * for the canonical purpose / semantics of the interface.
     */
    description?: string;

    /**
     * Non-normative implementation notes (markdown). Stripped from the hash,
     * so editing `comment` never changes the interface identity. Use it for
     * rationale, changelog notes, examples, etc.
     */
    comment?: string;

    /** Methods keyed by local member name. */
    methods: Record<string, MethodSchema>;

    /** Reusable schema definitions, referenced via `#/components/schemas/<name>`. */
    components?: {
        schemas?: Record<string, LinkRpcJsonSchema>;
    };
}

export interface MethodSchema {
    [key: `x-${string}`]: unknown;
    /** Schema for the user params object. */
    params: LinkRpcJsonSchema;

    /** Result schema. Omit to declare a notification-only method. */
    result?: LinkRpcJsonSchema;

    /**
     * Schema for client-emitted stream messages (`$stream::send` from
     * caller to callee) on an in-flight call. Absent means the client
     * may not stream on this method.
     */
    clientStream?: LinkRpcJsonSchema;

    /**
     * Schema for server-emitted stream messages (`$stream::send` from
     * callee to caller) on an in-flight call. Absent means the server
     * may not stream on this method.
     */
    serverStream?: LinkRpcJsonSchema;

    /** Application errors. Named types must be unique; legacy errors have unique codes. */
    errors?: ErrorSchema[];

    summary?: string;
    /**
     * Normative description of this method's contract (markdown). Part of
     * the interface hash — changing it is a contract change.
     */
    description?: string;
    /** Non-normative implementation notes. Stripped from the hash. */
    comment?: string;
    deprecated?: boolean;

    /**
     * Behavioral claims about this method. All flags default to `false`;
     * setting one is always a positive refinement of the contract.
     * Part of the interface hash — these are normative claims callers
     * may rely on, so changing them is a contract change.
     */
    annotations?: MemberAnnotations;
}

/**
 * Behavioral claims about a method. Every flag is a positive assertion
 * (default `false` ≡ "no claim"); setting one strengthens the contract
 * the caller may rely on.
 *
 * These are normative — they are included in the interface hash.
 */
export interface MemberAnnotations {
    /**
     * The method does not modify any observable state on the callee
     * (or anywhere reachable from it). Pure query.
     *
     * Implies `idempotent` and `reversible` (a no-op has nothing to
     * undo and repeats trivially).
     */
    readOnly?: boolean;
    /**
     * Calling N times with the same params has the same observable effect
     * as calling once. Safe to retry on transport failure.
     */
    idempotent?: boolean;
    /**
     * Effects of this method are reversible — the caller (or operator)
     * can undo them with a follow-up call. Implies the method is not
     * `dangerous`.
     */
    reversible?: boolean;
    /**
     * Calling this method is expensive (slow, costly, or rate-limited).
     * Callers should avoid unnecessary invocations and may want to
     * confirm / batch.
     */
    expensive?: boolean;
    /**
     * Method has irreversible or destructive effects (data loss, money
     * spent, message sent, etc.). UIs should require confirmation.
     */
    dangerous?: boolean;
}

export interface ErrorSchema {
    /** Named error discriminator in `error.data.type`. Absent for legacy numeric errors. */
    type?: string;
    /** JSON-RPC error code. -32768..-32000 and LinkRPC cancellation code -32800 are reserved. */
    code: number;
    message: string;
    /** Payload schema: `error.data.data` for named errors, `error.data` for legacy errors. */
    data?: LinkRpcJsonSchema;
}
