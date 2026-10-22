import {
    INTERFACE_TEMPLATES_EXTENSION, interfaceTemplateMemberName, interfaceTemplatesEqual,
    validateInterfaceTemplates, type InterfaceTemplateArgument, type InterfaceTemplatesMetadata,
    type LinkRpcInterfaceSchema,
} from '@hediet/linkrpc';
import { unknown } from 'zod/mini';
import { DesktopTemplate } from './desktopInterface';
import { DesktopHubTemplate } from './desktopHub';

const template = DesktopTemplate({ params: unknown() }).template;

/** Resolves parameterized instances without assuming an implementation's interface or wire names. */
export function desktopInstances(schema: LinkRpcInterfaceSchema, transport: 'webrtc' | 'hub' = 'webrtc'): readonly {
    readonly name: string;
    readonly info: string;
    readonly attach: string;
    readonly params: InterfaceTemplateArgument;
}[] {
    const expected = transport === 'hub' ? DesktopHubTemplate({ params: unknown() }).template : template;
    const metadata = schema[INTERFACE_TEMPLATES_EXTENSION] as InterfaceTemplatesMetadata | undefined;
    if (!metadata) return [];
    validateInterfaceTemplates(schema);
    return metadata.instances.flatMap(instance => {
        const definition = metadata.templates[instance.template];
        if (definition?.id !== expected.id) return [];
        if (!interfaceTemplatesEqual(definition, expected)) throw new Error(`Unsupported ${expected.id} revision`);
        const params = instance.arguments.params;
        if (!params) throw new Error(`Desktop instance ${instance.name} has no params argument`);
        return [{
            name: instance.name,
            info: interfaceTemplateMemberName(instance, 'info'),
            attach: interfaceTemplateMemberName(instance, 'attach'),
            params,
        }];
    });
}
