/**
 * The JSON value lattice. Anything the wire can carry.
 *
 * Object values are `JsonValue | undefined` so `undefined`-valued fields
 * may be present in source and are simply omitted at canonicalisation
 * time (rather than serialised as `null`).
 */
export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue | undefined };
