const rpcFailureBrand: unique symbol = Symbol('linkrpc.rpcFailure');

/** A nominal failure wrapper: successful application objects can never collide with it. */
export class RpcFailure<E> {
    readonly [rpcFailureBrand] = true;
    constructor(public readonly error: E) {
        Object.freeze(this);
    }
}

export type Result<T, E = never> = T | RpcFailure<E>;

export function isRpcFailure<T, E>(value: Result<T, E>): value is RpcFailure<E>;
export function isRpcFailure(value: unknown): value is RpcFailure<unknown>;
export function isRpcFailure(value: unknown): value is RpcFailure<unknown> {
    return typeof value === 'object' && value !== null
        && (value as RpcFailure<unknown>)[rpcFailureBrand] === true;
}
