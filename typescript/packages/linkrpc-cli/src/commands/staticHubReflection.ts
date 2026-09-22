import {
    ErrorCode,
    type LinkRpcInterfaceSchema,
    type IncomingCall,
    type IRequestSender,
    type JsonValue,
    type ChannelResult as Result,
    RpcError,
} from '@hediet/linkrpc';
import type {
    StaticHubSchema,
    StaticInterfaceReference,
} from '../staticHubSchema';

const DIRECTORY_INTERFACE_ID = 'hubrpc.directory';
const SCHEMAS_INTERFACE_ID = 'hubrpc.schemas';
const DEFAULTS_INTERFACE_ID = 'hubrpc.defaults';

const DIRECTORY_LIST_METHOD = `${DIRECTORY_INTERFACE_ID}::list`;
const DIRECTORY_WATCH_METHOD = `${DIRECTORY_INTERFACE_ID}::watch`;
const SCHEMAS_GET_METHOD = `${SCHEMAS_INTERFACE_ID}::get`;
const DEFAULTS_GET_METHOD = `${DEFAULTS_INTERFACE_ID}::get`;

interface DirectoryItem {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly interfaceHash: string;
}

export class StaticHubReflection {
    private readonly _directory: readonly DirectoryItem[];
    private readonly _schemasByKey = new Map<string, LinkRpcInterfaceSchema>();
    private readonly _activeHashesById = new Map<string, Set<string>>();
    private readonly _hashesByServiceInterface = new Map<string, Set<string>>();

    constructor(private readonly _schema: StaticHubSchema) {
        this._directory = (_schema.services ?? []).flatMap((service) =>
            service.interfaces.map((ref) => ({
                serviceId: service.serviceId,
                interfaceId: ref.interfaceId,
                interfaceHash: ref.interfaceHash,
            })));
        for (const schema of _schema.interfaceSchemas) {
            this._schemasByKey.set(interfaceKey(schema.id, schema.hash), schema);
        }
        for (const item of this._directory) {
            const hashes = this._activeHashesById.get(item.interfaceId) ?? new Set<string>();
            hashes.add(item.interfaceHash);
            this._activeHashesById.set(item.interfaceId, hashes);
            const serviceKey = interfaceKey(item.serviceId, item.interfaceId);
            const serviceHashes = this._hashesByServiceInterface.get(serviceKey) ?? new Set<string>();
            serviceHashes.add(item.interfaceHash);
            this._hashesByServiceInterface.set(serviceKey, serviceHashes);
        }
        if (_schema.defaultInterface !== undefined) {
            const ref = _schema.defaultInterface;
            const hashes = this._activeHashesById.get(ref.interfaceId) ?? new Set<string>();
            hashes.add(ref.interfaceHash);
            this._activeHashesById.set(ref.interfaceId, hashes);
        }
        for (const { interface: ref } of _schema.bareInterfaces ?? []) {
            const hashes = this._activeHashesById.get(ref.interfaceId) ?? new Set<string>();
            hashes.add(ref.interfaceHash);
            this._activeHashesById.set(ref.interfaceId, hashes);
        }
    }

    public tryHandleRequest(call: IncomingCall): Promise<Result> | undefined {
        return this.tryHandle(call.method, call.params, call.signal);
    }

    public tryHandle(
        method: string,
        params: JsonValue | undefined,
        signal: AbortSignal,
    ): Promise<Result> | undefined {
        const reflectionCall = parseReflectionMethod(method);
        if (reflectionCall === undefined) {
            return undefined;
        }
        switch (reflectionCall.method) {
            case `${DEFAULTS_INTERFACE_ID}::listBindings`:
                return Promise.resolve({
                    result: { bindings: (this._schema.bareInterfaces ?? []).map((binding) => ({
                        prefix: binding.prefix,
                        ...binding.interface,
                    })) },
                });
            case DIRECTORY_LIST_METHOD:
                return Promise.resolve(this._listDirectory(params));
            case DIRECTORY_WATCH_METHOD:
                return this._watchDirectory(params, signal);
            case SCHEMAS_GET_METHOD:
                return Promise.resolve(this._getSchema(params, reflectionCall.serviceId));
            case DEFAULTS_GET_METHOD:
                return Promise.resolve({
                    result: this._schema.defaultInterface === undefined
                        ? {}
                        : {
                            interfaceId: this._schema.defaultInterface.interfaceId,
                            interfaceHash: this._schema.defaultInterface.interfaceHash,
                        },
                });
            default:
                return Promise.resolve(methodNotFound(method));
        }
    }

    private _listDirectory(params: JsonValue | undefined): Result {
        const parsed = parseDirectoryParams(params);
        if ('error' in parsed) return parsed;

        const filtered = this._directory
            .filter((item) =>
                parsed.interfaceId === undefined || item.interfaceId === parsed.interfaceId)
            .filter((item) =>
                parsed.serviceId === undefined || item.serviceId === parsed.serviceId);
        const start = parsed.cursor ?? 0;
        if (start > filtered.length) {
            return invalidParams('directory cursor is outside the result set');
        }
        const end = parsed.limit === undefined
            ? filtered.length
            : Math.min(filtered.length, start + parsed.limit);
        return {
            result: {
                items: filtered.slice(start, end),
                ...(end < filtered.length ? { nextCursor: String(end) } : {}),
            },
        };
    }

    private _watchDirectory(params: JsonValue | undefined, signal: AbortSignal): Promise<Result> {
        const parsed = parseDirectoryParams(params, false);
        if ('error' in parsed) return Promise.resolve(parsed);
        return new Promise<Result>((resolve) => {
            const done = (): void => resolve({ result: {} });
            if (signal.aborted) {
                done();
                return;
            }
            signal.addEventListener('abort', done, { once: true });
        });
    }

    private _getSchema(params: JsonValue | undefined, serviceId: string | undefined): Result {
        if (!isRecord(params)) {
            return invalidParams('schemas.get params must be an object');
        }
        const interfaceId = params.interfaceId;
        const hash = params.hash;
        if (typeof interfaceId !== 'string' || interfaceId.length === 0) {
            return invalidParams('schemas.get interfaceId must be a non-empty string');
        }
        if (hash !== undefined && typeof hash !== 'string') {
            return invalidParams('schemas.get hash must be a string');
        }

        let resolvedHash = hash;
        if (resolvedHash === undefined) {
            const active = serviceId === undefined
                ? [...(this._activeHashesById.get(interfaceId) ?? [])]
                : [
                    ...(this._hashesByServiceInterface.get(interfaceKey(serviceId, interfaceId))
                        ?? []),
                ];
            if (active.length !== 1) {
                return {
                    error: {
                        code: ErrorCode.methodNotFound,
                        message: `Interface not found: ${interfaceId}`,
                        data: { reason: 'unknown-interface', interfaceId },
                    },
                };
            }
            resolvedHash = active[0];
        }
        const schema = this._schemasByKey.get(interfaceKey(interfaceId, resolvedHash));
        if (schema === undefined) {
            return {
                error: {
                    code: ErrorCode.methodNotFound,
                    message: `Interface not found: ${interfaceId}@${resolvedHash}`,
                    data: {
                        reason: 'unknown-interface',
                        interfaceId,
                        hash: resolvedHash,
                    },
                },
            };
        }
        return { result: { schema } as unknown as JsonValue };
    }
}

export function withStaticHubReflection<TContext>(
    sender: IRequestSender<TContext>,
    schema: StaticHubSchema,
): IRequestSender<TContext> {
    const reflection = new StaticHubReflection(schema);
    const handle = (
        method: string,
        params: JsonValue | undefined,
        signal: AbortSignal,
    ): Promise<JsonValue> | undefined => {
        const result = reflection.tryHandle(method, params, signal);
        return result?.then(unwrapResult);
    };
    return {
        sendRequest: (method, params, opts) =>
            handle(method, params, new AbortController().signal)
            ?? sender.sendRequest(method, params, opts),
        sendNotification: (method, params, opts) =>
            sender.sendNotification(method, params, opts),
        sendRequestWithStream: (method, params, opts) => {
            const controller = new AbortController();
            const result = handle(method, params, controller.signal);
            if (result === undefined) {
                return sender.sendRequestWithStream(method, params, opts);
            }
            return {
                result,
                send: () => { },
                cancel: () => controller.abort(),
                dispose: () => controller.abort(),
                ping: () => Promise.resolve(),
            };
        },
        close: () => sender.close(),
    };
}

function unwrapResult(result: Result): JsonValue {
    if ('error' in result) {
        throw new RpcError(result.error.message, result.error.code, result.error.data);
    }
    return result.result;
}

function parseDirectoryParams(
    params: JsonValue | undefined,
    allowPagination = true,
): {
    interfaceId?: string;
    serviceId?: string;
    cursor?: number;
    limit?: number;
} | Result {
    if (params === undefined) return {};
    if (!isRecord(params)) {
        return invalidParams('directory params must be an object');
    }
    const interfaceId = optionalString(params.interfaceId);
    if (interfaceId === false) return invalidParams('directory interfaceId must be a string');
    const serviceId = optionalString(params.serviceId);
    if (serviceId === false) return invalidParams('directory serviceId must be a string');

    const result: {
        interfaceId?: string;
        serviceId?: string;
        cursor?: number;
        limit?: number;
    } = {
        ...(interfaceId === undefined ? {} : { interfaceId }),
        ...(serviceId === undefined ? {} : { serviceId }),
    };
    if (!allowPagination) return result;

    if (params.cursor !== undefined) {
        if (typeof params.cursor !== 'string' || !/^(0|[1-9]\d*)$/.test(params.cursor)) {
            return invalidParams('directory cursor must be a non-negative integer string');
        }
        result.cursor = Number(params.cursor);
    }
    if (params.limit !== undefined) {
        if (
            typeof params.limit !== 'number'
            || !Number.isSafeInteger(params.limit)
            || params.limit <= 0
        ) {
            return invalidParams('directory limit must be a positive integer');
        }
        result.limit = params.limit;
    }
    return result;
}

function parseReflectionMethod(
    method: string,
): { readonly method: string; readonly serviceId: string | undefined; } | undefined {
    const parts = method.split('::');
    const candidate = parts.length === 2
        ? method
        : parts.length === 3
            ? `${parts[1]}::${parts[2]}`
            : undefined;
    if (
        candidate?.startsWith(`${DIRECTORY_INTERFACE_ID}::`)
        || candidate?.startsWith(`${SCHEMAS_INTERFACE_ID}::`)
        || candidate?.startsWith(`${DEFAULTS_INTERFACE_ID}::`)
    ) {
        return {
            method: candidate,
            serviceId: parts.length === 3 ? parts[0] : undefined,
        };
    }
    return undefined;
}

function methodNotFound(method: string): Result {
    return {
        error: {
            code: ErrorCode.methodNotFound,
            message: `Unknown static reflection method: ${method}`,
        },
    };
}

function invalidParams(message: string): Result {
    return {
        error: {
            code: ErrorCode.invalidParams,
            message,
        },
    };
}

function optionalString(value: JsonValue | undefined): string | undefined | false {
    if (value === undefined) return undefined;
    return typeof value === 'string' ? value : false;
}

function interfaceKey(interfaceId: string, interfaceHash: string): string {
    return `${interfaceId}\0${interfaceHash}`;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return value !== undefined
        && value !== null
        && typeof value === 'object'
        && !Array.isArray(value);
}
