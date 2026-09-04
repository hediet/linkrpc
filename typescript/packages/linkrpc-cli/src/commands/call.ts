import { ErrorCode, type JsonValue, RpcError } from '@hediet/linkrpc';
import { MethodRefWithOptHash } from '../methodRef';
import { formatJson, readParamsArg } from '../output';
import { mergeParams } from '../paramParsing';
import { type CliChannel, findMethodInSchema } from '@hediet/linkrpc-client';
import { formatSuggestion, HubSnapshot } from '../suggest';
import {
    describeObjectParams,
    describeSchema,
    explainValidation,
    validateValueAgainstSchema,
} from '../validation';
import type { LinkRpcInterfaceSchema as SvcInterfaceSchema, MethodSchema } from '@hediet/linkrpc';
import { fetchSchemaForMethodRef } from '../schemaLookup';

export interface CallCommandOptions {
    /** Full `[svc::][iface::]method[@hash]` reference. */
    readonly methodRef: string;
    /** Raw `--params <json>` value, or "-" for stdin. */
    readonly paramsArg?: string;
    readonly paramOverrides?: readonly string[];
    /** Skip schema-based validation. Default: validate. */
    readonly noValidate?: boolean;
    /** Schema lookup policy. `noValidate` takes precedence when set. */
    readonly validation?: 'auto' | 'required' | 'off';
    readonly json?: boolean;
    /**
     * Invoked for every server→client stream message (`$stream::send`) that
     * arrives while the call is in flight. Defaults to writing each chunk to
     * stderr (one line each) so streamed progress shows live without
     * polluting the stdout result. Pass a custom sink in tests.
     */
    readonly onStreamChunk?: (payload: JsonValue) => void;
}

export async function callCommand(channel: CliChannel, opts: CallCommandOptions): Promise<string> {
    const ref = MethodRefWithOptHash.parseMethodRef(opts.methodRef);
    const baseParams = readParamsArg(opts.paramsArg);
    const params = mergeParams({ base: baseParams, overrides: opts.paramOverrides });

    const validation = opts.noValidate ? 'off' : (opts.validation ?? 'required');
    if (validation !== 'off') await validateParams(channel, ref, params, 'call', validation);
    const onStreamChunk = opts.onStreamChunk ?? writeChunkToStderr;
    try {
        // Always use the streaming send path: it behaves identically to a plain
        // request when no stream messages arrive, and surfaces them live when
        // the method does stream (e.g. an interactive `login` device-code
        // prompt). The final result is the request's response.
        const call = channel.sendRequestWithStream(ref.getMethodOnWire(), params as never, {
            onStreamMessage: onStreamChunk,
        });
        const result = await call.result;
        return opts.json !== false ? formatJson(result) : String(result);
    } catch (e) {
        if (e instanceof RpcError && e.code === ErrorCode.methodNotFound) {
            await _failWithSuggestion(channel, ref, 'call');
        }
        if (e instanceof RpcError) throw formatRpcError(e);
        throw e;
    }
}

/**
 * Default stream sink: one line per chunk on stderr. Strings pass through
 * verbatim; structured payloads are JSON-encoded. stderr (not stdout) keeps
 * `call … | jq` clean while still showing live progress.
 */
function writeChunkToStderr(payload: JsonValue): void {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    process.stderr.write(text + '\n');
}

export interface NotifyCommandOptions extends CallCommandOptions { }

export async function notifyCommand(channel: CliChannel, opts: NotifyCommandOptions): Promise<string> {
    const ref = MethodRefWithOptHash.parseMethodRef(opts.methodRef);
    const baseParams = readParamsArg(opts.paramsArg);
    const params = mergeParams({ base: baseParams, overrides: opts.paramOverrides });
    const validation = opts.noValidate ? 'off' : (opts.validation ?? 'required');
    if (validation !== 'off') await validateParams(channel, ref, params, 'notify', validation);
    await channel.sendNotification(ref.getMethodOnWire(), params as never);
    return '(notification sent)';
}

async function validateParams(
    channel: CliChannel,
    ref: MethodRefWithOptHash,
    params: unknown,
    verb: 'call' | 'notify',
    validation: 'auto' | 'required',
): Promise<void> {
    let schema: SvcInterfaceSchema | undefined;
    try {
        schema = await fetchSchemaForMethodRef(channel, ref);
    } catch (e) {
        // Server side says the interface (or its host route) is unknown.
        // ErrorCode.methodNotFound covers both "no such interface" and "no
        // such route" — in either case the bus-wide suggestion is what the
        // user wants. Any other RpcError (e.g. permission) is propagated.
        if (e instanceof RpcError && e.code === ErrorCode.methodNotFound) {
            if (validation === 'auto') return;
            await _failWithSuggestion(channel, ref, verb);
        }
        throw e;
    }
    if (schema === undefined) {
        if (validation === 'auto') return;
        await _failWithSuggestion(channel, ref, verb);
    }
    const method = findMethodInSchema(schema, ref.methodName);
    if (!method) {
        await _failWithSuggestion(channel, ref, verb);
    }
    if (verb === 'call' && method!.result === undefined) {
        throw new Error(
            `${ref.getMethodOnWire()} is a notification member; use \`notify\` instead of \`call\`.`,
        );
    }
    if (verb === 'notify' && method!.result !== undefined) {
        throw new Error(
            `${ref.getMethodOnWire()} is a request member; use \`call\` instead of \`notify\`.`,
        );
    }
    const paramsSchema = method!.params;
    const reason = validateValueAgainstSchema(params, paramsSchema, schema.components?.schemas ?? {});
    if (reason !== undefined) {
        throw new Error(_formatParamValidationError(ref, schema, method!, params, reason));
    }
}

function _formatParamValidationError(
    ref: MethodRefWithOptHash,
    schema: SvcInterfaceSchema,
    method: MethodSchema,
    params: unknown,
    fallback: string,
): string {
    const components = schema.components?.schemas ?? {};
    const paramsSchema = method.params;
    const lines: string[] = [];
    lines.push(`Param validation failed for ${ref.getMethodOnWire()}:`);
    const issues = explainValidation(params, paramsSchema, components);
    if (issues.length > 0) {
        for (const i of issues) {
            const where = i.path === '' ? '(root)' : i.path;
            lines.push(`  ${where}: ${i.reason}`);
        }
    } else {
        lines.push(`  ${fallback}`);
    }
    if (paramsSchema !== undefined) {
        const table = describeObjectParams(paramsSchema, components);
        if (table !== undefined) {
            lines.push('Expected params:');
            lines.push(table);
        } else {
            lines.push(`Expected: ${describeSchema(paramsSchema, components)}`);
        }
    }
    return lines.join('\n');
}

/**
 * Walk the bus once, build a snapshot, and throw an Error whose message is a
 * focused "did you mean…" block tailored to `ref`. Always throws — return
 * type is `Promise<never>`. Snapshot load failures fall back to an empty
 * snapshot so we still produce *some* output.
 */
async function _failWithSuggestion(
    channel: CliChannel,
    ref: MethodRefWithOptHash,
    verb: 'call' | 'notify',
): Promise<never> {
    let snapshot: HubSnapshot;
    try {
        snapshot = await HubSnapshot.load(channel);
    } catch {
        snapshot = new HubSnapshot([]);
    }
    throw new Error(formatSuggestion({ ref, snapshot, verb }));
}

function formatRpcError(e: RpcError): Error {
    if (e.code === ErrorCode.permissionRequired) {
        return new Error(_formatPermissionRequired(e));
    }
    const dataStr = e.data === undefined ? '' : ` ${JSON.stringify(e.data)}`;
    return new Error(`RPC error ${e.code}: ${e.message}${dataStr}`);
}

/**
 * Friendly explanation for `permissionRequired` (-32401). Typical when the
 * CLI couldn't acquire a capability via `hubAccess::requestAccess` and the
 * target service gates on caps. The earlier `capability negotiation
 * skipped` warning explains *why* we couldn't get one; this footer tells
 * the user what to do.
 */
function _formatPermissionRequired(e: RpcError): string {
    return [
        `Permission required: ${e.message}`,
        '  The hub gates this call on a capability, and none was acquired.',
        '  If your hub uses an access handler, accept the consent prompt and retry.',
        '  Otherwise, the hub admin has to issue a capability to this CLI identity',
        `  (\`hub logout\` then retry to mint a fresh identity).`,
    ].join('\n');
}
