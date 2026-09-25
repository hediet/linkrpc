import type { MemberType } from './memberTypes';
import type { InterfaceTemplateArgument, InterfaceTemplateSchema } from './interfaceTemplates';

/** Local authoring marker. Never serialized into the wire contract. */
export const interfaceTemplateGroup = Symbol.for('@hediet/linkrpc.interfaceTemplateGroup');

export interface InterfaceTemplateGroup<
    M extends Record<string, MemberType> = Record<string, MemberType>,
    Mapping extends Record<keyof M, string> | undefined = Record<keyof M, string> | undefined,
> {
    readonly [interfaceTemplateGroup]: true;
    readonly members: M;
    readonly template: InterfaceTemplateSchema;
    readonly arguments: Readonly<Record<string, InterfaceTemplateArgument>>;
    readonly mapping: Mapping;
}
