import {
    ContextStore,
    type ContextReference,
    type ContextValues,
    type SelectedContext,
    mergeContextValues,
} from './contexts';
import {
    resolveEndpoint,
    type ResolvedEndpoint,
} from '@hediet/linkrpc-client';

export type CliProfile = 'rpc' | 'hub';

export interface ResolvedInvocationContext {
    readonly profile: CliProfile;
    readonly selected: SelectedContext;
    readonly contextValues: ContextValues;
    readonly environmentValues: ContextValues;
    readonly values: ContextValues;
    readonly cliOverrides: ContextValues;
    readonly environmentApplied: boolean;
}

export interface ResolveInvocationContextOptions {
    readonly profile: CliProfile;
    readonly store: ContextStore;
    readonly selector?: string;
    readonly cliOverrides?: ContextValues;
    readonly env?: NodeJS.ProcessEnv;
    readonly useEnvironment?: boolean;
    readonly allowMissingContext?: boolean;
}

export async function resolveInvocationContext(
    options: ResolveInvocationContextOptions,
): Promise<ResolvedInvocationContext> {
    const env = options.env ?? process.env;
    const environmentSelector = firstDefined(
        env.LINKRPC_CONTEXT,
        env.HUBRPC_CONTEXT,
    );
    const selected = await options.store.select({
        ...(options.selector !== undefined ? { selector: options.selector } : {}),
        ...(options.selector === undefined && environmentSelector !== undefined
            ? { environmentSelector }
            : {}),
        ...(options.allowMissingContext === true ? { allowMissing: true } : {}),
    });
    const environmentApplied = options.useEnvironment
        ?? (options.profile === 'hub' && options.selector === undefined);
    const contextValues = selected.context?.values ?? {};
    const environmentValues = environmentApplied ? contextValuesFromEnvironment(env) : {};
    const cliOverrides = options.cliOverrides ?? {};
    return {
        profile: options.profile,
        selected,
        contextValues,
        environmentValues,
        values: mergeContextValues(
            mergeContextValues(contextValues, environmentValues),
            cliOverrides,
        ),
        cliOverrides,
        environmentApplied,
    };
}

export function contextValuesFromEnvironment(env: NodeJS.ProcessEnv): ContextValues {
    const endpoint = firstDefined(env.LINKRPC_ENDPOINT, env.HUBRPC_ENDPOINT);
    const endpointToken = firstDefined(env.LINKRPC_TOKEN, env.HUBRPC_TOKEN);
    return {
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...(endpointToken !== undefined ? { endpointToken } : {}),
    };
}

export async function mutationReference(
    store: ContextStore,
    selected: SelectedContext,
): Promise<Exclude<ContextReference, { readonly kind: 'empty'; }>> {
    if (
        selected.reference.kind !== 'empty'
        && selected.reference.kind !== 'root'
    ) {
        return selected.reference;
    }
    const cwd = await store.resolveReference('.');
    if (cwd.kind === 'empty') throw new Error('current directory cannot be used as a context');
    return cwd;
}

export function validationDefault(profile: CliProfile): 'auto' | 'required' {
    return profile === 'hub' ? 'required' : 'auto';
}

export function resolveInvocationEndpoint(
    invocation: ResolvedInvocationContext,
    provisioningHandledElsewhere = false,
): ResolvedEndpoint | undefined {
    const cli = invocation.cliOverrides;
    const context = invocation.contextValues;
    const environment = invocation.environmentValues;
    const cliHasEndpoint = hasEndpointSelector(cli);
    const environmentHasEndpoint = environment.endpoint !== undefined;
    let input: Parameters<typeof resolveEndpoint>[0];

    if (cliHasEndpoint) {
        const inheritedToken = cli.endpoint !== undefined && hasTokenPlaceholder(cli.endpoint)
            ? environment.endpointToken ?? context.endpointToken
            : undefined;
        const token = cli.endpointToken ?? inheritedToken;
        input = {
            ...endpointInput(cli),
            ...(token !== undefined ? { endpointToken: token } : {}),
            provisioningHandledElsewhere,
            env: {},
        };
    } else if (environmentHasEndpoint) {
        input = {
            ...endpointInput(cli),
            ...(cli.endpointToken !== undefined ? { endpointToken: cli.endpointToken } : {}),
            provisioningHandledElsewhere,
            env: {
                LINKRPC_ENDPOINT: environment.endpoint,
                ...(environment.endpointToken !== undefined
                    ? { LINKRPC_TOKEN: environment.endpointToken }
                    : {}),
            },
        };
    } else {
        const values = { ...context, ...cli };
        const token = cli.endpointToken
            ?? environment.endpointToken
            ?? context.endpointToken;
        input = {
            ...endpointInput(values),
            ...(token !== undefined ? { endpointToken: token } : {}),
            provisioningHandledElsewhere,
            env: {},
        };
    }

    const result = resolveEndpoint(input);
    if (result.error !== undefined) throw new Error(result.error);
    return result.endpoint;
}

function endpointInput(values: ContextValues): Parameters<typeof resolveEndpoint>[0] {
    return {
        ...(values.endpoint !== undefined ? { endpoint: values.endpoint } : {}),
        ...(values.endpointCmd !== undefined ? { endpointCmd: values.endpointCmd } : {}),
        ...(values.endpointCmdStdio !== undefined
            ? { endpointCmdStdio: values.endpointCmdStdio }
            : {}),
        ...(values.endpointCmdEnv !== undefined ? { endpointCmdEnv: values.endpointCmdEnv } : {}),
        ...(values.endpointCmdCwd !== undefined ? { endpointCmdCwd: values.endpointCmdCwd } : {}),
        ...(values.provisionIdentity !== undefined
            ? { provisionIdentity: values.provisionIdentity }
            : {}),
        ...(values.provisionIdentitySlot !== undefined
            ? { provisionIdentitySlot: values.provisionIdentitySlot }
            : {}),
    };
}

function hasEndpointSelector(values: ContextValues): boolean {
    return values.endpoint !== undefined
        || values.endpointCmd !== undefined
        || values.endpointCmdStdio !== undefined;
}

function hasTokenPlaceholder(endpoint: string): boolean {
    return /(?:[?&])token=%(?:[&#]|$)/.test(endpoint);
}

function firstDefined(...values: readonly (string | undefined)[]): string | undefined {
    return values.find((value) => value !== undefined);
}
