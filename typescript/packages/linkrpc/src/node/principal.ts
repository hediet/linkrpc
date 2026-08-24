import { Principal } from '../identity/signingSender';
import { CapBag } from '../identity/capBag';
import { KeypairIdentity } from '../identity/identity';
import { loadOrCreateIdentity } from './hubClient';
import { fileManagedIdentityStorage } from './fileManagedIdentityStorage';

/**
 * Self-managed principal: a local Ed25519 + X25519 keypair (created/loaded on
 * disk) signs and wraps/unwraps for outbound calls, and granted caps are
 * cached in a sibling file. Purely local — no transport needed — and
 * cheap/idempotent, so it can be re-derived on each reconnect. Used with
 * `--use-non-managed-identity`.
 */
export async function createSelfManagedPrincipal(identityKey: string): Promise<Principal> {
    return _selfManagedPrincipal({ id: identityKey });
}

/**
 * Self-managed principal whose keypair lives at an explicit file path (rather
 * than a slot derived from an id). Caps are cached in a sibling `.caps.json`.
 * Used by callers that want to pin the identity to a specific file, e.g. the
 * CLI's `--principal file:<path>`.
 */
export async function createSelfManagedPrincipalFromFile(file: string): Promise<Principal> {
    return _selfManagedPrincipal({ id: `file:${file}`, file });
}

async function _selfManagedPrincipal(opts: { id: string; file?: string; }): Promise<Principal> {
    const id = await loadOrCreateIdentity({ id: opts.id, file: opts.file });
    const capsFile = id.file.endsWith('.json') ?
        id.file.replace(/\.json$/, '.caps.json') :
        `${id.file}.caps.json`;
    const capBag = await CapBag.load({ storage: fileManagedIdentityStorage(capsFile) });
    const identity = new KeypairIdentity(id.principal, id.keypair.privateKey, id.wrapKeypair);
    return new Principal(identity, capBag);
}
