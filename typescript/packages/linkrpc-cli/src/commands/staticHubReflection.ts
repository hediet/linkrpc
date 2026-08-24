import {
    ErrorCode,
    type LinkRpcInterfaceSchema,
    type IncomingCall,
    type JsonValue,
    type Result,
} from '@hediet/linkrpc';
import type {
    StaticHubSchema,
    StaticInterfaceReference,
} from '../staticHubSchema';

const DIRECTORY_INTERFACE_ID = 'linkrpc.directory';
const SCHEMAS_INTERFACE_ID = 'linkrpc.schemas';
const DEFAULTS_INTERFACE_ID = 'linkrpc.defaults';

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

    constructor(private readonly _schema: StaticHubSchema) {
        this._directory = _schema.services.flatMap((service) =>
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
        }
        if (_schema.defaultInterface !== undefined) {
            const ref = _schema.defaultInterface;
            const hashes = this._activeHashesById.get(ref.interfaceId) ?? new Set<string>();
            hashes.add(ref.interfaceHash);
            this._activeHashesById.set(ref.interfaceId, hashes);
        }
    }

    public tryHandleRequest(call: IncomingCall): Promise<Result> | undefined {
        if (!isReflectionMethod(call.method)) {
            return undefined;
        }
        switch (call.method) {
            case DIRECTORY_LIST_METHOD:
                return Promise.resolve(this._listDirectory(call.params));
            case DIRECTORY_WATCH_METHOD:
                return this._watchDirectory(call);
            case SCHEMAS_GET_METHOD:
                return Promise.resolve(this._getSchema(call.params));
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
                return Promise.resolve(methodNotFound(call.method));
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

    private _watchDirectory(call: IncomingCall): Promise<Result> {
        const parsed = parseDirectoryParams(call.params, false);
        if ('error' in parsed) return Promise.resolve(parsed);
        return new Promise<Result>((resolve) => {
            const done = (): void => resolve({ result: {} });
            if (call.signal.aborted) {
                done();
                return;
            }
            call.signal.addEventListener('abort', done, { once: true });
        });
    }

    private _getSchema(params: JsonValue | undefined): Result {
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
            const active = [...(this._activeHashesById.get(interfaceId) ?? [])];
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

function isReflectionMethod(method: string): boolean {
    return method.startsWith(`${DIRECTORY_INTERFACE_ID}::`)
        || method.startsWith(`${SCHEMAS_INTERFACE_ID}::`)
        || method.startsWith(`${DEFAULTS_INTERFACE_ID}::`);
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
