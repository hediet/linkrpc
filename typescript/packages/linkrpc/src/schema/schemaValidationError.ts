/** Invalid reflected schema data, as distinct from an unexpected implementation failure. */
export class SchemaValidationError extends Error {
    override readonly name = "SchemaValidationError";
}
