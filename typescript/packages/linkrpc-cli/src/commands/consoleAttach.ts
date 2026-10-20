import {
    createSchemaToZod,
    interfaceTemplateMemberName,
    interfaceTemplatesEqual,
    INTERFACE_TEMPLATES_EXTENSION,
    validateInterfaceTemplates,
    type InterfaceTemplateArgument,
    type InterfaceTemplatesMetadata,
    type JsonValue,
} from '@hediet/linkrpc';
import type { CliChannel } from '@hediet/linkrpc-client-internal';
import {
    CONSOLE_INTERFACE_TAG,
    consoleAttachResultSchema,
    consoleServerMessageSchema,
    ConsoleTemplate,
    type ConsoleAttachParams,
    type ConsoleServerMessage,
} from '@hediet/linkrpc-infra/console';
import { unknown } from 'zod/mini';
import { discoverViewTargets, loadViewTarget, resolveViewSelection } from '../views/discovery';
import type { ResolvedViewInterface, ViewContribution } from '../views/types';
import { localTerminalSize, runConsoleSession, type ConsoleCall, type DetachKeys } from './consoleSession';

/** One instance of the `linkrpc.console.v1` template, found through reflection. */
export interface ConsoleTarget {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly instance: string;
    readonly infoMethod: string;
    readonly attachMethod: string;
    readonly params: InterfaceTemplateArgument;
}

export interface AttachConsoleOptions {
    readonly serviceId: string;
    readonly interfaceId?: string;
    readonly instance?: string;
    /** JSON params of the selected instance; defaults to `{}`. */
    readonly params?: string;
    readonly readOnly?: boolean;
    readonly detachKeys?: DetachKeys;
    readonly reattachCommand: string;
}

const consoleTemplate = ConsoleTemplate({ params: unknown() }).template;

/** Discovery-only view: the generic `attach` command reuses directory and reflection resolution. */
export const consoleDiscovery: ViewContribution = {
    id: 'console', title: 'Console', modes: ['cli'],
    conditions: [
        { kind: 'interface', interface: { tag: CONSOLE_INTERFACE_TAG } },
        { kind: 'service', implements: { tag: CONSOLE_INTERFACE_TAG } },
    ],
    configureCommand() {},
    open() { throw new Error('Use the attach command'); },
    createSession() { throw new Error('Consoles have no TUI view'); },
};

/** Console template instances in reflected schemas; tags are only discovery hints. */
export function consoleTargets(interfaces: readonly ResolvedViewInterface[]): ConsoleTarget[] {
    return interfaces.flatMap(listing => {
        const metadata = listing.schema[INTERFACE_TEMPLATES_EXTENSION] as InterfaceTemplatesMetadata | undefined;
        if (metadata === undefined) return [];
        validateInterfaceTemplates(listing.schema);
        return metadata.instances.flatMap(instance => {
            const template = metadata.templates[instance.template];
            if (template?.id !== consoleTemplate.id) return [];
            if (!interfaceTemplatesEqual(template, consoleTemplate)) {
                throw new Error(`${listing.interfaceId} uses an unsupported revision of the ${consoleTemplate.id} template`);
            }
            const method = (member: string) => {
                const name = interfaceTemplateMemberName(instance, member);
                if (listing.isDefault) return name;
                return listing.serviceId === '' ? `${listing.interfaceId}::${name}` : `${listing.serviceId}::${listing.interfaceId}::${name}`;
            };
            const params = instance.arguments.params;
            if (params === undefined) throw new Error(`Console instance "${instance.name}" is missing its params argument`);
            return [{
                serviceId: listing.serviceId, interfaceId: listing.interfaceId, instance: instance.name,
                infoMethod: method('info'), attachMethod: method('attach'), params,
            }];
        });
    });
}

/** List console targets without attaching: discovery uses directory tags, then reflection resolves instances. */
export async function listConsoleTargets(channel: CliChannel): Promise<string> {
    const discovery = await discoverViewTargets(channel, consoleDiscovery);
    const rows: string[] = [];
    for (const target of discovery.targets.filter(value => value.kind === 'service')) {
        const context = await loadViewTarget(channel, target, undefined, consoleDiscovery);
        for (const console of consoleTargets(context.interfaces)) {
            rows.push(`${console.serviceId || '<root>'}  ${console.interfaceId}  ${console.instance}  ${JSON.stringify(console.params.schema)}`);
        }
    }
    return [
        rows.length === 0 ? 'No services offer linkrpc.console.' : 'SERVICE  INTERFACE  INSTANCE  PARAMS',
        ...rows,
        ...discovery.warnings.map(warning => `warning: ${warning}`),
    ].join('\n');
}

/** Attach to any service implementing the console template, selected by service, interface, and instance. */
export async function attachConsole(channel: CliChannel, options: AttachConsoleOptions): Promise<void> {
    const context = await resolveViewSelection(channel, consoleDiscovery, {
        service: options.serviceId, ...(options.interfaceId === undefined ? {} : { interface: options.interfaceId }),
    });
    const candidates = consoleTargets(context.interfaces)
        .filter(target => options.instance === undefined || target.instance === options.instance);
    if (candidates.length !== 1) {
        const names = consoleTargets(context.interfaces).map(target => `${target.interfaceId}#${target.instance}`).join(', ');
        throw new Error(candidates.length === 0
            ? `No console instance matches on "${options.serviceId}"${names ? ` (available: ${names})` : ''}`
            : `Several consoles are available (${names}); select one with --instance or --interface`);
    }
    const target = candidates[0]!;
    let params: unknown;
    try { params = JSON.parse(options.params ?? '{}'); }
    catch { throw new Error('--params must be valid JSON'); }
    const validation = createSchemaToZod(target.params.components?.schemas ?? {}).toZod(target.params.schema).safeParse(params);
    if (!validation.success) {
        throw new Error(`--params does not match the params of console "${target.instance}" `
            + `(${JSON.stringify(target.params.schema)}): ${validation.error.message}`);
    }
    const interactive = options.readOnly !== true;
    const size = interactive ? localTerminalSize() : undefined;
    const result = await runConsoleSession(onMessage => rawConsoleCall(channel, target.attachMethod, {
        params: params as JsonValue, interactive, ...(size ? { size } : {}),
    }, onMessage), {
        interactive, owner: false, reattachCommand: options.reattachCommand,
        ...(options.detachKeys ? { detachKeys: options.detachKeys } : {}),
    });
    if (!result.closedLocally && result.exit?.code) process.exitCode = result.exit.code;
}

/** Call a reflected attach method on the raw channel, validating every stream message against the protocol. */
function rawConsoleCall(
    channel: Pick<CliChannel, 'sendRequestWithStream'>,
    method: string,
    params: ConsoleAttachParams & { readonly params: JsonValue },
    onMessage: (message: ConsoleServerMessage) => void,
): ConsoleCall {
    const call = channel.sendRequestWithStream(method, params as JsonValue, {
        onStreamMessage: payload => {
            const message = consoleServerMessageSchema.safeParse(payload);
            onMessage(message.success ? message.data : { t: 'notice', text: `Ignored an invalid console message: ${message.error.message}` });
        },
    });
    const result = call.result.then(value => consoleAttachResultSchema.parse(value));
    void result.finally(() => call.dispose?.()).catch(() => {});
    return {
        then: (onFulfilled, onRejected) => result.then(onFulfilled, onRejected),
        send: message => call.send(message as JsonValue),
        cancel: () => call.cancel('detached'),
    };
}
