/**
 * A decidable subset of JSON Schema for which schema assignability
 * (every value matching X also matches Y) can be checked structurally.
 *
 * Excluded on purpose: `not`, `if/then/else`, `allOf`, `pattern`,
 * numeric/length bounds, `patternProperties`, `propertyNames`,
 * `dependentSchemas`. Structured refinements break decidability.
 *
 * `oneOf` is included alongside `anyOf` for fidelity with Zod's
 * `discriminatedUnion` (and OpenAPI tagged unions). For assignability
 * purposes `oneOf` is treated identically to `anyOf` — the "exactly
 * one branch" semantics is a runtime-validation refinement that does
 * not change the set of values structurally matched in our subset.
 *
 * `format` is kept as an opaque tag on primitives (like JSON Schema's
 * `format`): two schemas with different `format`s are treated as
 * incomparable; adding a `format` is a breaking change, dropping one
 * is widening.
 */
import type { JsonValue } from "../protocol/jsonValue";
export type { JsonValue };

export type LinkRpcJsonSchema =
    | true                       // top: matches anything
    | false                      // bottom: matches nothing
    | NullSchema
    | BooleanSchema
    | NumberSchema
    | IntegerSchema
    | StringSchema
    | ConstSchema
    | EnumSchema
    | ArraySchema
    | TupleSchema
    | ObjectSchema
    | UnionSchema
    | OneOfSchema
    | RefSchema;

export interface SchemaBase {
    [key: `x-${string}`]: unknown;
    title?: string;
    description?: string;
    /**
     * Additional draft 2020-12 constraints that refine (never replace) this
     * node. This extension is non-normative for LinkRPC identity; use
     * {@link materializeJsonSchema} when exporting to a general validator.
     */
    "x-json-schema"?: boolean | Record<string, unknown>;
}

export interface NullSchema extends SchemaBase {
    type: "null";
}

export interface BooleanSchema extends SchemaBase {
    type: "boolean";
}

export interface NumberSchema extends SchemaBase {
    type: "number";
    /** Opaque well-known refinement tag, e.g. "float32", "percentage". */
    format?: string;
}

export interface IntegerSchema extends SchemaBase {
    type: "integer";
    /** Opaque well-known refinement tag, e.g. "int32", "uint8", "unix-time". */
    format?: string;
}

export interface StringSchema extends SchemaBase {
    type: "string";
    /** Opaque well-known refinement tag, e.g. "email", "uri", "uuid", "date-time". */
    format?: string;
}

/** Single literal value. */
export interface ConstSchema extends SchemaBase {
    const: JsonValue;
}

/** Finite set of literal values. */
export interface EnumSchema extends SchemaBase {
    enum: JsonValue[];
}

/** Homogeneous array. */
export interface ArraySchema extends SchemaBase {
    type: "array";
    items: LinkRpcJsonSchema;
}

/** Fixed-length head plus optional rest element type. */
export interface TupleSchema extends SchemaBase {
    type: "array";
    prefixItems: LinkRpcJsonSchema[];
    /** `false` => exact length; schema => typed rest; omitted => exact length. */
    items?: LinkRpcJsonSchema | false;
}

export interface ObjectSchema extends SchemaBase {
    type: "object";
    properties: Record<string, LinkRpcJsonSchema>;
    /** Names of required properties. Must all be keys of `properties`. */
    required?: string[];
    /** `false` => closed; schema => value type for unknown keys. */
    additionalProperties: LinkRpcJsonSchema | false;
}

/** Untagged union. Assignability distributes over branches. */
export interface UnionSchema extends SchemaBase {
    anyOf: LinkRpcJsonSchema[];
}

/**
 * Tagged-or-disjoint union (`oneOf`). Structurally treated the same as
 * `UnionSchema` for assignability; the distinction is preserved so the
 * wire schema faithfully reflects whether the source was a
 * discriminated union (e.g. Zod's `z.discriminatedUnion`) or a plain
 * union.
 *
 * `discriminator`, when present, is a pure consumer hint: it names the
 * property that branches dispatch on. Every branch SHOULD be an object
 * with that property set to a distinct `const` value, but the subset
 * does not enforce this — broken discriminators are tolerated.
 */
export interface OneOfSchema extends SchemaBase {
    oneOf: LinkRpcJsonSchema[];
    discriminator?: DiscriminatorSchema;
}

export interface DiscriminatorSchema {
    propertyName: string;
}

/** Reference to a named entry in `SvcInterfaceSchema.components.schemas`. */
export interface RefSchema extends SchemaBase {
    /** JSON Pointer, restricted to "#/components/schemas/<name>". */
    $ref: string;
}
