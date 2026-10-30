import { isAssignable, matchParams, schemaToZod, type LinkRpcInterfaceSchema, type LinkRpcJsonSchema, type ParamMatcher } from '@hediet/linkrpc';
import { findCoveringCapabilities, type HubAccessDuration, type HubAccessPermission } from '@hediet/linkrpc/hub/common';
import { fetchDefaults, findMethodInSchema, type CliChannel, type SigningSession } from '@hediet/linkrpc-client-internal';
import { z } from 'zod';
import type { MethodRefWithOptHash } from '../methodRef';
import { parseParamOverride } from '../paramParsing';
import { formatJson } from '../output';

const matcherSchema = z.union([
    z.strictObject({ exact: z.json() }),
    z.strictObject({ enum: z.array(z.json()).min(1) }),
    z.strictObject({ prefix: z.string() }),
    z.strictObject({ subsetOf: z.array(z.string()) }),
    z.strictObject({
        range: z.strictObject({ min: z.int(), max: z.int() })
            .refine(range => range.min <= range.max, 'min must not exceed max'),
    }),
    z.strictObject({ any: z.literal(true) }),
]);

export interface RequestCallCapabilityOptions {
    readonly allowParams?: readonly string[];
    readonly duration?: HubAccessDuration;
    /** Also request `canDelegate`, so the holder can issue narrower capabilities to other identities. */
    readonly delegate?: boolean;
}

export async function requestCallCapability(
    channel: CliChannel,
    session: SigningSession,
    ref: MethodRefWithOptHash,
    params: unknown,
    schema: LinkRpcInterfaceSchema,
    opts: RequestCallCapabilityOptions,
): Promise<string> {
    const method = findMethodInSchema(schema, ref.methodName);
    if (method === undefined) throw new Error(`Unknown method ${ref.getMethodOnWire()}.`);
    const matchers = createParamMatchers(params, opts.allowParams ?? [], method.params, schema.components?.schemas);
    const defaults = ref.interfaceId === undefined ? await fetchDefaults(channel) : undefined;
    const permission: HubAccessPermission = {
        target: {
            serviceId: { exact: ref.serviceId ?? defaults?.serviceId ?? '' },
            interfaceId: { exact: ref.interfaceId ?? schema.id },
            members: [{ exact: ref.methodName }],
            ...(ref.hash !== undefined ? { interfaceHash: ref.hash } : {}),
        },
        canInvoke: true,
        ...(opts.delegate === true ? { canDelegate: true } : {}),
        params: matchers,
    };
    const coverageOptions = { audience: session.principal.id, freshnessMarginMs: 2000 };
    const cached = findCoveringCapabilities(session.listGrants(), [permission], coverageOptions);
    if (cached !== undefined) {
        return formatJson({ status: 'granted', reused: true, capabilities: cached });
    }
    const result = await session.requestAccess({
        consumer: { name: 'linkrpc-cli', purpose: `Invoke ${ref.getMethodOnWire()}.` },
        permissions: [permission],
        duration: opts.duration ?? 'persistent',
    });
    if (result.status !== 'granted') {
        const reason = 'reason' in result ? result.reason : undefined;
        throw new Error(`Capability request ${result.status}${reason ? `: ${reason}` : '.'}`);
    }
    if (findCoveringCapabilities(session.listGrants(), [permission], coverageOptions) === undefined) {
        throw new Error('The granted capabilities do not cover the requested durable scope.');
    }
    return formatJson({ ...result, reused: false });
}

export function createParamMatchers(
    params: unknown,
    allowParams: readonly string[],
    schema: LinkRpcJsonSchema,
    components: Record<string, LinkRpcJsonSchema> = {},
): Record<string, ParamMatcher> {
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
        throw new Error('Capability requests require object parameters.');
    }
    const actual: Record<string, unknown> = params === undefined ? {} : Object.fromEntries(Object.entries(params));
    const matchers: Record<string, ParamMatcher> = Object.fromEntries(
        Object.entries(actual).map(([key, value]) => [key, { exact: value }]),
    );
    const seen = new Set<string>();
    for (const raw of allowParams) {
        const { path, value } = parseParamOverride(raw);
        if (path.length !== 1) throw new Error('--cap:allow-param only supports top-level parameter names.');
        const key = path[0];
        if (seen.has(key)) throw new Error(`Duplicate --cap:allow-param for ${key}.`);
        seen.add(key);
        const parsed = matcherSchema.safeParse(value);
        if (!parsed.success) throw new Error(`Invalid --cap:allow-param ${key}: ${parsed.error.message}`);
        matchers[key] = parsed.data;
    }
    const properties = Object.fromEntries(
        Object.entries(matchers).map(([key, matcher]) => [key, matcherToSchema(matcher)]),
    );
    if (!isAssignable({
        type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
    }, schema, { schemas: components })) {
        throw new Error('--cap:allow-param scope does not match the method parameter schema.');
    }
    const validator = schemaToZod(schema, components);
    const samples = [actual];
    for (const [key, matcher] of Object.entries(matchers)) {
        const values = 'exact' in matcher ? [matcher.exact] : 'enum' in matcher ? matcher.enum
            : 'subsetOf' in matcher ? [[], ...matcher.subsetOf.map(value => [value])]
                : 'range' in matcher ? [matcher.range.min, matcher.range.max] : [];
        for (const value of values) samples.push({ ...actual, [key]: value });
    }
    for (const sample of samples) {
        const validated = validator.safeParse(sample);
        if (!validated.success) throw new Error(`Capability parameter schema validation failed: ${validated.error.message}`);
    }
    const matched = matchParams(matchers, actual);
    if (!matched.ok) throw new Error(`Parameters do not match --cap:allow-param: ${matched.reason}`);
    return matchers;
}

function matcherToSchema(matcher: ParamMatcher): LinkRpcJsonSchema {
    if ('any' in matcher) return true;
    if ('prefix' in matcher) return { type: 'string' };
    if ('range' in matcher) return { type: 'integer' };
    if ('subsetOf' in matcher) {
        return { type: 'array', items: { enum: matcher.subsetOf } };
    }
    if ('enum' in matcher) return { enum: z.array(z.json()).parse(matcher.enum) };
    return { const: z.json().parse(matcher.exact) };
}

export function listCaps(session: SigningSession, json: boolean): string {
    const capabilities = session.listGrants();
    return json ? formatJson({ principal: session.principal.id, capabilities })
        : `principal: ${session.principal.id}\n${capabilities.length === 0 ? 'No stored capabilities.' : formatJson(capabilities)}`;
}
