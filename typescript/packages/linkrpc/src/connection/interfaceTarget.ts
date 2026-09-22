import type { InterfaceDefinition } from './interfaceDefinition';
import type { BareInterfaceTarget } from './bareInterfaceTarget';

/** A qualified LinkRPC route. An empty serviceId addresses the root interface. */
export interface QualifiedInterfaceTarget<TDef extends InterfaceDefinition<any>> {
    readonly mode: 'qualified';
    readonly interface: TDef;
    readonly serviceId: string;
}

/** The peer's preset form-1 route, retaining LinkRPC metadata and streaming. */
export interface DefaultInterfaceTarget<TDef extends InterfaceDefinition<any>> {
    readonly mode: 'default';
    readonly interface: TDef;
}

export type InterfaceTarget<TDef extends InterfaceDefinition<any>> =
    | QualifiedInterfaceTarget<TDef>
    | DefaultInterfaceTarget<TDef>
    | BareInterfaceTarget<TDef>;

export function interfaceTarget<TDef extends InterfaceDefinition<any>>(
    iface: TDef,
    options: { readonly serviceId?: string } = {},
): QualifiedInterfaceTarget<TDef> {
    const serviceId = options.serviceId ?? '';
    if (serviceId.includes('::') || !/^[\x20-\x7e]*$/.test(serviceId)) {
        throw new Error('Service id must contain only printable ASCII and must not contain "::".');
    }
    return Object.freeze({ mode: 'qualified', interface: iface, serviceId });
}

export function defaultInterfaceTarget<TDef extends InterfaceDefinition<any>>(
    iface: TDef,
): DefaultInterfaceTarget<TDef> {
    return Object.freeze({ mode: 'default', interface: iface });
}

export function isInterfaceTarget<TDef extends InterfaceDefinition<any>>(
    value: TDef | InterfaceTarget<TDef>,
): value is InterfaceTarget<TDef> {
    return typeof value === 'object' && value !== null
        && 'interface' in value && 'mode' in value
        && (value.mode === 'qualified' || value.mode === 'default' || value.mode === 'bare');
}
