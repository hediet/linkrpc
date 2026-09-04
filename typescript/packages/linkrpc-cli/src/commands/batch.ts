import type { JsonValue } from "@hediet/linkrpc";
import type { CallCommandOptions, NotifyCommandOptions } from "./call";

export interface BatchOperation {
    readonly kind: "call" | "notify";
    readonly methodRef: string;
    readonly paramsArg?: string;
    readonly paramOverrides: readonly string[];
    readonly noValidate: boolean;
}

export interface BatchPlan {
    readonly operations: readonly BatchOperation[];
    readonly continueOnError: boolean;
}

export interface BatchExecutor {
    readonly call: (options: CallCommandOptions) => Promise<string>;
    readonly notify: (options: NotifyCommandOptions) => Promise<string>;
}

export type BatchResult =
    | {
        readonly index: number;
        readonly kind: BatchOperation["kind"];
        readonly method: string;
        readonly ok: true;
        readonly result?: JsonValue;
    }
    | {
        readonly index: number;
        readonly kind: BatchOperation["kind"];
        readonly method: string;
        readonly ok: false;
        readonly error: string;
    };

export interface ExecuteBatchOptions {
    readonly validation?: 'auto' | 'required' | 'off';
    readonly onStreamChunk?: (event: {
        readonly index: number;
        readonly method: string;
        readonly payload: JsonValue;
    }) => void;
}

export function parseBatchArgs(args: readonly string[]): BatchPlan {
    const operations: MutableBatchOperation[] = [];
    let current: MutableBatchOperation | undefined;
    let continueOnError = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case "--call":
            case "--notify": {
                const methodRef = readOptionValue(args, ++i, arg, "method");
                current = {
                    kind: arg === "--call" ? "call" : "notify",
                    methodRef,
                    paramOverrides: [],
                    noValidate: false,
                };
                operations.push(current);
                break;
            }
            case "--params": {
                requireOperation(current, arg);
                if (current.paramsArg !== undefined) {
                    throw new Error("--params may be specified only once per batch operation");
                }
                current.paramsArg = readOptionValue(args, ++i, arg);
                break;
            }
            case "--param": {
                requireOperation(current, arg);
                current.paramOverrides.push(readOptionValue(args, ++i, arg));
                break;
            }
            case "--no-validate":
                requireOperation(current, arg);
                current.noValidate = true;
                break;
            case "--continue-on-error":
                continueOnError = true;
                break;
            default:
                if (arg.startsWith("-")) {
                    throw new Error(`Unknown batch option: ${arg}`);
                }
                throw new Error(`Unexpected batch argument: ${arg}`);
        }
    }

    if (operations.length === 0) {
        throw new Error("Batch requires at least one --call or --notify operation");
    }

    return { operations, continueOnError };
}

export async function executeBatch(
    plan: BatchPlan,
    executor: BatchExecutor,
    options: ExecuteBatchOptions = {},
): Promise<BatchResult[]> {
    const results: BatchResult[] = [];

    for (let index = 0; index < plan.operations.length; index++) {
        const operation = plan.operations[index];
        const commandOptions: CallCommandOptions = {
            methodRef: operation.methodRef,
            paramsArg: operation.paramsArg,
            paramOverrides: operation.paramOverrides,
            noValidate: operation.noValidate,
            validation: options.validation,
            json: true,
            onStreamChunk: (payload) => options.onStreamChunk?.({
                index,
                method: operation.methodRef,
                payload,
            }),
        };

        try {
            if (operation.kind === "notify") {
                await executor.notify(commandOptions);
                results.push(toSuccessResult(index, operation));
            } else {
                const output = await executor.call(commandOptions);
                const result: JsonValue = JSON.parse(output);
                results.push(toSuccessResult(index, operation, result));
            }
        } catch (error) {
            if (!plan.continueOnError) {
                throw error;
            }
            results.push({
                index,
                kind: operation.kind,
                method: operation.methodRef,
                ok: false,
                error: getErrorMessage(error),
            });
        }
    }

    return results;
}

interface MutableBatchOperation {
    kind: BatchOperation["kind"];
    methodRef: string;
    paramsArg?: string;
    paramOverrides: string[];
    noValidate: boolean;
}

function readOptionValue(
    args: readonly string[],
    index: number,
    option: string,
    valueName = "value",
): string {
    const value = args[index];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a ${valueName}`);
    }
    return value;
}

function requireOperation(
    operation: MutableBatchOperation | undefined,
    option: string,
): asserts operation is MutableBatchOperation {
    if (operation === undefined) {
        throw new Error(`${option} must follow --call or --notify`);
    }
}

function toSuccessResult(
    index: number,
    operation: BatchOperation,
    result?: JsonValue,
): BatchResult {
    return {
        index,
        kind: operation.kind,
        method: operation.methodRef,
        ok: true,
        ...(result === undefined ? {} : { result }),
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
