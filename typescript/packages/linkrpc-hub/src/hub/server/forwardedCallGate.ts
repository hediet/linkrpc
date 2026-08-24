import {
    type AcceptedRootIssuer,
    ErrorCode,
    type IMessageTransport,
    isNotification,
    isRequest,
    type JsonRpcMessage,
    type JsonRpcNotification,
    type JsonRpcRequest,
    methodNameToTarget, permits,
    type PublicSigningIdentity,
    verifyCall
} from '@hediet/linkrpc';
import { parseMethodName } from '@hediet/linkrpc';
import {
    isReservedInspectionInterface,
    markInspectionLifecycle,
} from './inspectionLifecycle';

/** Options common to both gate modes (authenticity-only and capability). */
interface ForwardedCallGateBaseOptions {
    /**
     * ServiceId prefixes whose calls pass **verbatim**, unverified — an
     * opt-in escape hatch. **Empty by default**: reflection and forwarded
     * service calls are gated like any other. The consent front door
     * (`hubAccess::*`) is served at the connection root (never forwarded), so it
     * is reached directly and never passes through this gate.
     */
    readonly exemptPrefixes?: Iterable<string>;
    /** Override the clock (Unix milliseconds) used for skew / expiry checks. Testing seam. */
    readonly nowMs?: () => number;
}

/**
 * Per-service trust anchors, consulted with the call's `serviceId`. A
 * capability authorises only if its chain roots at one of the anchors returned
 * for that service, so a participant cannot self-issue authority. An empty
 * result rejects every capability (fail closed) — there is deliberately no
 * "accept any root" affordance. Anchors flagged `isPublic` are named in
 * rejection messages.
 */
type AcceptedRootIssuerResolver = (serviceId: string) => readonly AcceptedRootIssuer[];

/**
 * Gate configuration. A **discriminated union on `requireCapability`** so the
 * type system enforces the one combination that is actually safe:
 *
 * - **authenticity only** (`requireCapability` omitted / `false`): a valid
 *   `$linkrpc` signature is enough; *authorization* is left to the target
 *   service / capability layer. `acceptedRootIssuers` is optional here.
 * - **capability mode** (`requireCapability: true`): a bare signature is not
 *   enough — the request must also present a capability that {@link permits}
 *   the concrete call, rooted at an accepted issuer. Because there is no safe
 *   default trust anchor, either fixed `trustedRoots` or a service-specific
 *   `acceptedRootIssuers` resolver is **required at compile time**. This makes
 *   it impossible to request enforcement while silently forgetting whose
 *   capabilities to trust.
 */
export type ForwardedCallGateOptions =
    | (ForwardedCallGateBaseOptions & {
        readonly requireCapability?: false;
        readonly acceptedRootIssuers?: AcceptedRootIssuerResolver;
        readonly trustedRoots?: never;
    })
    | (ForwardedCallGateBaseOptions & {
        readonly requireCapability: true;
    } & (
        | {
            readonly acceptedRootIssuers: AcceptedRootIssuerResolver;
            readonly trustedRoots?: never;
        }
        | {
            /** Fixed public trust roots accepted for every forwarded service. */
            readonly trustedRoots: readonly PublicSigningIdentity[];
            readonly acceptedRootIssuers?: never;
        }
    ));


/**
 * A **signature front door** for fully-qualified calls. Wrap an incoming
 * transport with this before attaching it to a hub or constructing the serving
 * connection, so every `serviceId::interfaceId::member` call must carry a
 * valid `$linkrpc` signature.
 * Unsigned or tampered calls are rejected with an error response and never
 * reach the downstream hub or connection.
 *
 * What passes **verbatim** (ungated):
 * - responses;
 * - root-addressed requests (`interfaceId::member`) and bare requests
 *   (`member`) — these always terminate at the connection root and are never
 *   forwarded; and
 * - requests targeting an {@link ForwardedCallGateOptions.exemptPrefixes exempt
 *   prefix} (the hub's own services, which gate themselves).
 *
 * The gate **does not strip** the envelope: signed wire params keep the real
 * call params at the top level alongside `$linkrpc`/`$linkrpcUnsigned`, so the
 * target's typed handler recovers them via schema-stripping while a target that
 * cares may re-verify as defense-in-depth. Authorization is *not* this gate's
 * job (unless {@link ForwardedCallGateOptions.requireCapability} is set): it
 * proves *who* is calling, leaving *whether they may* to the capability layer.
 *
 * In-order delivery toward the hub is preserved across the async verification:
 * inbound messages are processed through a single serial queue.
 */
export function withForwardedCallGate(
    inner: IMessageTransport,
    options: ForwardedCallGateOptions,
): IMessageTransport {
    return withFullyQualifiedCallGate(inner, options);
}

/** Explicitly named alias for {@link withForwardedCallGate}. */
export function withFullyQualifiedCallGate(
    inner: IMessageTransport,
    options: ForwardedCallGateOptions,
): IMessageTransport {
    return new ForwardedCallGate(inner, options);
}

class ForwardedCallGate implements IMessageTransport {
    private readonly _exempt: Set<string>;
    /**
     * Per-call nonces already admitted on this link. A call replaying a
     * nonce is rejected — this is the single replay ledger, and it makes any
     * `callBind`-scoped capability single-use for free.
     */
    private readonly _seenNonces = new Set<string>();
    private _downstream: ((m: JsonRpcMessage) => void) | undefined;
    /** Serializes inbound processing so async verification never reorders the stream. */
    private _tail: Promise<void> = Promise.resolve();

    constructor(
        private readonly _inner: IMessageTransport,
        private readonly _options: ForwardedCallGateOptions,
    ) {
        this._exempt = new Set(_options.exemptPrefixes ?? []);
    }


    /** hub → participant: verbatim, never gated. */
    public send(message: JsonRpcMessage): void {
        void this._inner.send(message);
    }

    public setListener(listener: ((m: JsonRpcMessage) => void) | undefined): void {
        this._downstream = listener;
        this._inner.setListener(listener === undefined
            ? undefined
            : (message) => {
                this._tail = this._tail.then(() => this._process(message));
            });
    }

    public dispose(): void {
        this._inner.dispose();
    }

    private async _process(m: JsonRpcMessage): Promise<void> {
        if (!isRequest(m) && !isNotification(m)) {
            this._downstream?.(m);
            return;
        }
        const parsed = parseMethodName(m.method);
        // Only fully-qualified (cross-service) requests are forwarded by the
        // hub and thus gated. Root-form / malformed / exempt-prefix requests
        // pass through; the hub or the participant's overlay deals with them.
        //
        // SECURITY NOTE: `exemptPrefixes` is an opt-in escape hatch and is
        // **empty by default** — nothing, not even reflection, bypasses the
        // gate. The consent front door (`hubAccess::*`) is served at the
        // connection root (root form, never forwarded), so it is reached
        // directly and never reaches this gate. Callers that still pass a prefix
        // here accept that those services are reachable signed-but-uncapped.
        if (!parsed || parsed.kind !== 'full' || this._exempt.has(parsed.serviceId)) {
            this._downstream?.(m);
            return;
        }
        await this._gate(m);
    }

    private async _gate(call: JsonRpcRequest | JsonRpcNotification): Promise<void> {
        const nowMs = this._options.nowMs?.();
        const res = await verifyCall({
            method: call.method,
            params: call.params,
            parseMethod: methodNameToTarget,
            requireCapability: this._options.requireCapability === true,
            ...(nowMs !== undefined ? { nowMs } : {}),
        });
        if (!res.ok) {
            // `capability` → caller must present/acquire authority; anything
            // else (missing/bad signature, malformed) is a bad request.
            const code = res.kind === 'capability'
                ? ErrorCode.permissionRequired
                : ErrorCode.invalidRequest;
            this._reject(call, code, res.reason);
            return;
        }

        // Replay defense: every authentic forwarded call's nonce is
        // single-use on this link. (callBind grants ride on this for free.)
        if (this._seenNonces.has(res.nonce)) {
            this._reject(call, ErrorCode.invalidRequest, 'replayed request nonce');
            return;
        }

        // Authorization (capability mode): a presented capability must
        // `permits` the concrete call, rooting at an issuer this gate accepts
        // for the call's service.
        if (this._options.requireCapability === true) {
            const verdict = await permits(
                res.call,
                res.capabilities,
                (serviceId) => this._acceptedRootIssuers(serviceId),
                nowMs ?? Date.now(),
            );
            if (!verdict.ok) {
                this._reject(call, ErrorCode.permissionRequired, verdict.reason);
                return;
            }
        }

        // Admitted: record the nonce, then forward verbatim (envelope intact
        // for re-verification / schema-stripping at the target).
        this._seenNonces.add(res.nonce);
        const parsed = parseMethodName(call.method);
        if (parsed?.kind === 'full' && isReservedInspectionInterface(parsed.interfaceId)) {
            markInspectionLifecycle(call);
        }
        this._downstream?.(call);
    }

    private _reject(
        call: JsonRpcRequest | JsonRpcNotification,
        code: number,
        message: string,
    ): void {
        if (!isRequest(call)) {
            return;
        }
        void this._inner.send({
            jsonrpc: '2.0',
            id: call.id,
            error: { code, message },
        });
    }

    private _acceptedRootIssuers(serviceId: string): readonly AcceptedRootIssuer[] {
        if (this._options.requireCapability !== true) {
            return [];
        }
        if (this._options.trustedRoots !== undefined) {
            return this._options.trustedRoots.map(({ principal }) => ({ principal, isPublic: true }));
        }
        return this._options.acceptedRootIssuers(serviceId);
    }
}
