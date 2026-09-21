import type { InterfaceDefinition } from './interfaceDefinition';

/** A metadata-free foreign-protocol interface and its wire-method prefix. */
export interface BareInterfaceTarget<TDef extends InterfaceDefinition<any>> {
    readonly mode: 'bare';
    readonly interface: TDef;
    readonly prefix: string;
}

/**
 * Bundle an interface definition with metadata-free foreign-protocol
 * addressing for use with `connection.get(target)` or
 * `connection.register(target, handlers)`.
 */
export function bareInterfaceTarget<TDef extends InterfaceDefinition<any>>(
    iface: TDef,
    options: { readonly prefix?: string } = {},
): BareInterfaceTarget<TDef> {
    const prefix = options.prefix ?? '';
    validateBarePrefix(prefix);
    return Object.freeze({
        mode: 'bare' as const,
        interface: iface,
        prefix,
    });
}

export function isBareInterfaceTarget<TDef extends InterfaceDefinition<any>>(
    value: TDef | BareInterfaceTarget<TDef>,
): value is BareInterfaceTarget<TDef> {
    return typeof value === 'object'
        && value !== null
        && 'mode' in value
        && value.mode === 'bare'
        && 'interface' in value
        && 'prefix' in value;
}

export function validateBarePrefix(
    prefix: string,
): void {
    if (prefix.includes('::') || !/^[\x20-\x7e]*$/.test(prefix)) {
        throw new Error('Bare interface prefix must contain only printable ASCII and must not contain "::".');
    }
}
