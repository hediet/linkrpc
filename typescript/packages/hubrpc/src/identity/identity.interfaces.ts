import { array, boolean, object, optional, string, unknown } from 'zod/mini';
import { defineInterface } from '../connection/interfaceDefinition';
import { requestType } from '../schema/memberTypes';

// ---- The wire interface --------------------------------------------------
const zB64 = string();
/**
 * Per-participant key oracle. Reached on the participant's root overlay
 * (form-2 method names like `identity::sign`). Private key material lives
 * in the executor; the participant only sees the operations.
 *
 * Wire shape:
 *   sign / wrap / unwrap all take and return base64url-encoded bytes.
 *   `domain` is a caller-chosen string bound into HPKE info and the AEAD
 *   AAD. `unwrap` succeeds only when invoked with the exact `domain` that
 *   `wrap` was called with. Use a stable, namespaced string (e.g.
 *   `secrets.vault.master-key.v1`).
 */

export const identityInterface = defineInterface(
    {
        id: 'identity',
        description: 'Per-participant key oracle: exposes signing and HPKE-based ' +
            'wrap/unwrap for the identity the executor has attached to ' +
            "this participant's root overlay. Private keys never leave " +
            'the executor.',
    },
    {
        getPrincipal: requestType(
            object({}),
            object({ principal: string() })
        ),
        getWrapPublicKey: requestType(
            object({}),
            object({ wrapPublicKey: zB64 })
        ),
        sign: requestType(
            object({ bytes: zB64 }),
            object({ signature: zB64 })
        ),
        wrap: requestType(
            object({ domain: string(), bytes: zB64 }),
            object({ blob: zB64 })
        ),
        unwrap: requestType(
            object({ domain: string(), blob: zB64 }),
            object({ bytes: zB64 })
        ),
    }
);
/**
 * Per-identity persistent key/value store. Reached on the participant's
 * root overlay as `identity.storage::get` etc. — same overlay that serves
 * `identity::*`, same single-participant addressability.
 *
 * Storage scope is the executor's managed-identity slot (e.g.
 * `service:demo`). Lifecycle is bound to the identity: when the executor
 * deletes the identity for a slot, the storage for that slot is wiped in
 * the same operation. New identity issued for the same slot starts empty.
 *
 * The executor encrypts the backing file at rest with the same secret it
 * uses for identity files — see {@link IdentityKeystore} in
 * `@vscode/hubrpc/node`.
 *
 * Keys must match `^[A-Za-z0-9._/-]{1,256}$`. `/` is conventional for
 * namespacing (`caps.v1`, `prefs/foo`) and `list({ prefix })` honours
 * that. Values are arbitrary JSON.
 */

export const identityStorageInterface = defineInterface(
    {
        id: 'identity.storage',
        description: 'Per-identity persistent key/value store. Scope is the ' +
            "executor's managed-identity slot; lifecycle is tied to the " +
            'identity itself. Backed by an at-rest-encrypted file in the ' +
            'executor.',
    },
    {
        get: requestType(
            object({ key: string() }),
            // `value` is omitted when the key is absent — mirrors
            // `web-app-host::storageGet`'s convention.
            object({ value: optional(unknown()) })
        ),
        set: requestType(
            object({ key: string(), value: unknown() }),
            object({})
        ),
        delete: requestType(
            object({ key: string() }),
            object({ existed: boolean() })
        ),
        list: requestType(
            object({ prefix: optional(string()) }),
            object({ keys: array(string()) })
        ),
    }
);
