/**
 * Approver-side consent utilities for the `hubAccessManifest` flow.
 *
 * This module is consumed by *approvers* — {@link runManifestApprover} (the CLI)
 * and any other manifest consumer. It provides:
 *
 *  - the prompt contract ({@link ConsentPrompt} / {@link ConsentPromptRequest} /
 *    {@link ConsentDecision}) an approver uses to ask a human, plus the default
 *    terminal y/N prompt ({@link createTerminalConsentPrompt});
 *  - capability-shaping helpers an approver uses when it mints
 *    ({@link toSignedPermissions} / {@link computeCallBindHash}, which honor
 *    "Allow once" `callBind` byte-binding); and
 *  - {@link describePermissions} for rendering a request.
 *
 * The hub-side translation of `hubAccess` requests into parked manifest entries
 * lives on {@link HubAccessManifestHost} (`hubAccessConfig`), not here.
 */
import {
    HUBRPC_META_KEY,
    type CallMeta,
    type JsonValue,
    type PrincipalId,
    type Pattern,
    type Permission,
    requireObjectParams,
    signedHash,
    type SignedCapability,
} from '@vscode/hubrpc';
import {
    type AccessCallIntent,
    type AccessDirectPermission,
} from '../hub/server';
import * as readline from 'node:readline';

/**
 * The outcome of a single consent prompt.
 *
 * - `{ grant: false }` — deny (optionally with a reason).
 * - `{ grant: true, capabilities }` — approve. The approver minted the
 *   capabilities itself (with its own accepted-root identity); the keyless
 *   {@link HubAccessManifestHost} relays them verbatim. On a grant the
 *   capabilities are **required** — the host has no signing identity of its
 *   own.
 */
export type ConsentDecision =
    | { readonly grant: false; readonly reason?: string; }
    | { readonly grant: true; readonly capabilities?: readonly SignedCapability[]; };

/**
 * Asks an approver to decide a single access request. Injected so different
 * approvers (the terminal prompt, the hub-served manifest, tests) can supply the
 * decision. May be aborted via {@link ConsentPromptRequest.signal} when another
 * racing prompt settles first — implementations should stop waiting and clean up.
 */
export type ConsentPrompt = (request: ConsentPromptRequest) => Promise<ConsentDecision>;

export interface ConsentPromptRequest {
    /** Correlates the prompt with the blocked `hubAccess` call. */
    readonly requestId: string;
    /** Which `hubAccess` method is blocked on this request. */
    readonly kind: 'request' | 'extend' | 'requestAccess';
    /** Human-friendly description of who is asking. */
    readonly consumer: { readonly name: string; readonly origin?: string; readonly purpose?: string; };
    /** Verified PrincipalId of the calling consumer (the capability audience). */
    readonly consumerPrincipalId: PrincipalId;
    /**
     * The exact authority requested. Each permission may carry the consent-only
     * `callIntent` preview, so an approver can mint a byte-bound one-shot
     * ("Allow once") capability.
     */
    readonly permissions: readonly AccessDirectPermission[];
    /** One line per authority being requested (`serviceId::interfaceId member`). */
    readonly grants: readonly string[];
    /** `once` / `session` / `persistent`, when the consumer expressed one. */
    readonly duration: string | undefined;
    /** Aborts when another racing prompt has already settled this request. */
    readonly signal: AbortSignal;
}

/** One-line, human-readable summary of a permission for the consent prompt. */
function describePermission(perm: Permission): string {
    const svc = patternText(perm.target.serviceId);
    const iface = patternText(perm.target.interfaceId);
    const members = perm.target.members.map(patternText).join(',');
    return `${svc}::${iface} {${members}}`;
}

/** One human-readable line per permission, for an approver's UI / prompt. */
export function describePermissions(permissions: readonly Permission[]): string[] {
    return permissions.map(describePermission);
}

function patternText(p: Pattern | undefined): string {
    if (p === undefined) return '*';
    if ('exact' in p) return p.exact;
    if ('prefix' in p) return p.prefix === '' ? '*' : `${p.prefix}*`;
    return '*';
}

/**
 * Strip the consent-only `callIntent` from each requested permission and, for a
 * one-shot (`duration: 'once'`) grant whose intent declares a concrete call,
 * pin the permission to that exact call via `callBind.payloadHash`. The result
 * is the `Permission[]` to sign into the capability. Shared by the hub-issuer
 * mint path and any inbox approver that wants to honor "Allow once".
 *
 * `callIntent` is never itself signed — only the derived `callBind` is.
 */
export async function toSignedPermissions(
    permissions: readonly AccessDirectPermission[],
    consumerPrincipalId: PrincipalId,
    duration: string | undefined,
): Promise<Permission[]> {
    return Promise.all(
        permissions.map(async ({ callIntent, ...perm }) => {
            const signed: Permission = { ...perm };
            if (
                duration === 'once'
                && callIntent !== undefined
                && callIntent.params !== undefined
                && callIntent.nonce
                && callIntent.signedAtMs !== undefined
            ) {
                signed.callBind = {
                    alg: 'sha256',
                    payloadHash: await computeCallBindHash(callIntent, consumerPrincipalId),
                };
            }
            return signed;
        }),
    );
}

/**
 * Compute `callBind.payloadHash` for a grant bound to one consumer-declared
 * call. Builds the SAME signed params the consumer commits to at sign time
 * (`signedHash('call', { ...params, $hubrpc: meta })`); the forwarded-call gate
 * re-derives this on the inbound call and checks the hash matches. The consumer
 * owns `nonce`/`signedAtMs`, supplied via `callIntent`.
 */
export async function computeCallBindHash(
    intent: AccessCallIntent,
    consumerPrincipalId: PrincipalId,
): Promise<string> {
    const callMeta: CallMeta = {
        method: intent.method,
        nonce: intent.nonce,
        signedAtMs: intent.signedAtMs,
        principal: consumerPrincipalId,
        ...(intent.interfaceHash !== undefined ? { interfaceHash: intent.interfaceHash } : {}),
    };
    const userParams = requireObjectParams(intent.params as JsonValue | undefined);
    const signedParams = { ...userParams, [HUBRPC_META_KEY]: callMeta };
    return signedHash('call', signedParams);
}

/**
 * A terminal yes/no consent prompt on stdin.
 *
 * When stdin is not a TTY (no operator to answer) it **abstains** — it never
 * settles, parking until {@link ConsentPromptRequest.signal} aborts. This keeps
 * it safe inside {@link raceConsent}: a non-interactive terminal must not win
 * the race with an instant deny, or a hub-served inbox approval could never
 * land. A headless hub should simply not install this prompt at all (or pair it
 * with an inbox); on its own it grants nothing.
 *
 * When interactive, it resolves on the operator's answer, and abandons the
 * readline prompt if the request is aborted (another prompt decided first).
 */
export function createTerminalConsentPrompt(): ConsentPrompt {
    return (request) =>
        new Promise<ConsentDecision>((resolve) => {
            if (request.signal.aborted) {
                resolve({ grant: false });
                return;
            }
            if (!process.stdin.isTTY) {
                process.stderr.write(
                    'hubAccess: stdin is not a TTY; the terminal prompt is abstaining '
                    + '(waiting for an out-of-band approval or cancellation).\n',
                );
                request.signal.addEventListener('abort', () => resolve({ grant: false }), { once: true });
                return;
            }
            const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
            const onAbort = () => {
                rl.close();
                resolve({ grant: false });
            };
            request.signal.addEventListener('abort', onAbort, { once: true });
            const lines = [
                '',
                `Access request from "${request.consumer.name}"`,
                ...(request.consumer.purpose ? [`  purpose: ${request.consumer.purpose}`] : []),
                `  node:    ${request.consumerPrincipalId}`,
                ...request.grants.map((g) => `  grant:   ${g}`),
                ...(request.duration ? [`  duration: ${request.duration}`] : []),
                '',
            ];
            process.stderr.write(lines.join('\n'));
            rl.question('Allow? [y/N] ', (answer) => {
                request.signal.removeEventListener('abort', onAbort);
                rl.close();
                resolve(/^y(es)?$/i.test(answer.trim()) ? { grant: true } : { grant: false });
            });
        });
}

/**
 * Compose several {@link ConsentPrompt}s into one that presents each request to
 * **all** of them and takes the **first** to settle (first responder wins,
 * including a deny). Once one settles, the rest are aborted via a shared signal
 * so they can tear down (close the readline, drop the inbox entry). The
 * incoming request's own signal is honored too: if the consumer cancels, every
 * child prompt is aborted.
 *
 * This is what lets a single `hubAccess` request reach the hub operator's
 * terminal prompt and a hub-served inbox at the same time.
 */
export function raceConsent(prompts: readonly ConsentPrompt[]): ConsentPrompt {
    return (request) =>
        new Promise<ConsentDecision>((resolve, reject) => {
            if (prompts.length === 0) {
                resolve({ grant: false, reason: 'no consent surface configured' });
                return;
            }
            const child = new AbortController();
            const onOuterAbort = () => child.abort();
            if (request.signal.aborted) {
                child.abort();
            } else {
                request.signal.addEventListener('abort', onOuterAbort, { once: true });
            }
            let settled = false;
            const finish = (run: () => void) => {
                if (settled) return;
                settled = true;
                request.signal.removeEventListener('abort', onOuterAbort);
                child.abort();
                run();
            };
            const childRequest: ConsentPromptRequest = { ...request, signal: child.signal };
            for (const prompt of prompts) {
                Promise.resolve()
                    .then(() => prompt(childRequest))
                    .then(
                        (decision) => finish(() => resolve(decision)),
                        (err) => finish(() => reject(err)),
                    );
            }
        });
}
