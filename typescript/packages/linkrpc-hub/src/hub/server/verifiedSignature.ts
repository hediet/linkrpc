import {
    ErrorCode,
    type IMessageTransport,
    isRequest,
    type JsonRpcMessage,
    verifyRpcCall,
} from '@hediet/linkrpc';

/**
 * Wrap an inbound transport so every request's `$hubrpc` signature is verified
 * **eagerly, at the door** — a pure authenticity gate with no capability check:
 *
 * - a **valid** signature → the request is delivered unchanged;
 * - an **invalid** signature → the request is **rejected** here (an error
 *   response is sent and the message is never delivered);
 * - an **unsigned** call (no envelope) → delivered unchanged, so keyless
 *   connections still work.
 *
 * This is the signature half of the hub's trust model. *Authorization*
 * (capability chains) is **not** this wrapper's job — that is enforced
 * separately by {@link import('./forwardedCallGate').withForwardedCallGate} on
 * the hub-facing (forwarded) path. The root overlay uses this wrapper on its own
 * root-form calls (consent / identity front doors), which never pass through the
 * forwarded-call gate and so need their authenticity established here.
 *
 * When `verifySignatures` is not `true`, the transport is returned unchanged (no
 * verification, every message passes verbatim).
 *
 * Verification is async but in-order delivery is preserved via a per-link
 * promise chain.
 */
export function withVerifiedSignature(
    link: IMessageTransport,
    options: { readonly verifySignatures?: boolean } = {},
): IMessageTransport {
    if (options.verifySignatures !== true) {
        return link;
    }
    return {
        send: (message) => link.send(message),
        setListener: (listener) => {
            if (listener === undefined) {
                link.setListener(undefined);
                return;
            }
            let chain: Promise<void> = Promise.resolve();
            link.setListener((message) => {
                chain = chain
                    .then(async () => {
                        if (await _rejectedBadSignature(link, message)) {
                            return;
                        }
                        listener(message);
                    })
                    .catch((e) => {
                        console.error('Error in inbound signature verification:', e);
                        // A verification fault must never wedge the link; drop the
                        // offending message and keep the ordering chain alive.
                    });
            });
        },
        dispose: () => link.dispose(),
    };
}

/**
 * Verify a single inbound request's signature. Returns `true` (and sends an
 * error response over `link`) when the signature is present but invalid;
 * returns `false` — the message should be delivered — for a valid signature, an
 * unsigned call, or a non-request.
 */
async function _rejectedBadSignature(
    link: IMessageTransport,
    message: JsonRpcMessage,
): Promise<boolean> {
    if (!isRequest(message)) {
        return false;
    }
    const res = await verifyRpcCall({
        wireMethod: message.method,
        wireParams: message.params,
    });
    if (!res.ok) {
        link.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: ErrorCode.invalidRequest, message: res.reason },
        });
        return true;
    }
    return false;
}
