/**
 * A **ServiceId** is a `'/'`-segmented address naming a routing destination
 * on a {@link Hub}. The empty string is the **root** (the hub's own / local
 * services); every other id is one or more non-empty segments joined by
 * `'/'`.
 *
 * Examples:
 * - `""`          → root (valid)
 * - `"foo"`       → valid
 * - `"foo/bar"`   → valid
 * - `"/"`         → invalid (empty segments)
 * - `"/foo"`      → invalid (leading separator)
 * - `"foo/"`      → invalid (trailing separator)
 * - `"foo//bar"`  → invalid (empty interior segment)
 *
 * It is a plain `string` alias — the name exists only to mark the role at
 * call sites. Use {@link isValidServiceId} / {@link splitServiceId} to work
 * with it structurally.
 */
export type ServiceId = string;

/** The root service id — the hub's own local services. */
export const ROOT_SERVICE_ID: ServiceId = '';

/** The separator between service id segments. */
export const SERVICE_ID_SEPARATOR = '/';

/**
 * Whether `id` is a well-formed {@link ServiceId}. The root (`""`) is
 * valid; any other value must be non-empty segments joined by single
 * `'/'`s, with no leading, trailing, or empty segments.
 */
export function isValidServiceId(id: string): boolean {
    if (id === ROOT_SERVICE_ID) return true;
    if (id.startsWith(SERVICE_ID_SEPARATOR) || id.endsWith(SERVICE_ID_SEPARATOR)) return false;
    if (id.includes(SERVICE_ID_SEPARATOR + SERVICE_ID_SEPARATOR)) return false;
    return true;
}

/**
 * Split a {@link ServiceId} into its segments. The root (`""`) yields the
 * empty array; `"foo/bar"` yields `["foo", "bar"]`.
 *
 * Does not validate — pair with {@link isValidServiceId} when the input is
 * untrusted.
 */
export function splitServiceId(id: ServiceId): string[] {
    return id === ROOT_SERVICE_ID ? [] : id.split(SERVICE_ID_SEPARATOR);
}

/**
 * Whether `serviceId` is equal to or nested beneath `prefix` (segment-aware):
 * `"a/b"` covers `"a/b"` and `"a/b/c"` but **not** `"a/bc"`. The root prefix
 * (`""`) covers everything.
 */
export function isServiceIdUnder(serviceId: ServiceId, prefix: ServiceId): boolean {
    if (prefix === ROOT_SERVICE_ID) return true;
    if (serviceId === prefix) return true;
    return serviceId.startsWith(prefix + SERVICE_ID_SEPARATOR);
}
