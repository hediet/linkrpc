export const applicationErrorBrand: unique symbol = Symbol('linkrpc.applicationError');

export function brandApplicationError<T extends object>(
    value: T,
): T & { readonly [applicationErrorBrand]: true } {
    return Object.freeze(Object.defineProperty(value, applicationErrorBrand, { value: true })) as
        T & { readonly [applicationErrorBrand]: true };
}
