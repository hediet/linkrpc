# Identity extension — key documents and rotation

**Optional. Extends [chapter 06](06-identity.md).** Chapter 06 resolves an inline `key:` keyId directly and binds it to one perpetual `PrincipalId`. This extension generalizes **key resolution and principal binding** so a principal can commit its genesis key by a *document* (carrying a genesis-key expiry and a rotation admin) and rotate to later keys — **without changing any wire shape defined in chapter 06**. It adds only (a) two `KeyId` schemes, (b) the `$hubrpcUnsigned.bindings` member that carries the resolving documents, and (c) one signing domain. A node that resolves only inline keys is unaffected; it ignores `bindings`.

## 1. KeyId schemes

A `KeyId` (06 §1) is one of:

```
KeyId = "key:"    <base64url(publicKey)>     // inline key — self-contained (chapter 06)
      | "keydoc:" <signedHash(d, doc)>       // key committed by a document carried in bindings
```

For the `keydoc:` form, `d` is the document's **role domain** (§4): `keyGenesis` for a genesis document, `keyRotation` for a rotation record. `signedHash` is defined in chapter 07 §1; the role domain is folded into the committed bytes, so a rotation record can never be read as a genesis document.

A `PrincipalId` remains `"id:" + <its genesis KeyId>` (06 §3). The genesis keyId MAY therefore be `key:…` (inline, perpetual, unrotatable) or `keydoc:…` (a genesis document, §3).

> **Note.** `id:key:…` exposes the raw public key in the name; `id:keydoc:…` hides it behind a hash and is the only form that can limit the genesis key or name an admin. Both are accepted; the choice is the identity holder's.

## 2. The `bindings` member

`keydoc:` keyIds are resolved against documents the caller presents under the unsigned attachment object (chapter 07 §2):

```
params.$hubrpcUnsigned.bindings = { [keyId: KeyId]: KeyGenesis | RotationRecord }
```

`bindings` is **unsigned**: every entry is self-verifying. A resolver MUST accept an entry only if its key equals `"keydoc:" + signedHash(d, doc)` for the entry's role domain `d` (§4) — a tampered document yields a different keyId and resolves to nothing. A `key:` keyId never consults `bindings`.

## 3. Key genesis documents

A `keyGenesis` document commits a principal's genesis key and optional rotation policy:

```
KeyGenesis = {
  key:        string,        // base64url(publicKey)
  expiresMs?: number,        // genesis-key validity end; absent ⇒ perpetual
  admin?:     PrincipalId    // who may rotate this identity; absent ⇒ unrotatable
}
```

`expiresMs` and `admin` are inside the hash that names the principal, so a leaked genesis key cannot extend its own validity or swap the admin without becoming a different principal. A genesis document carries no signature. Expiry disables direct authentication by the genesis key; it does not expire the principal or rotation keys authorized by `admin`.

## 4. Rotation records

To rotate an `id:keydoc:…` identity to a new key, its `admin` signs a rotation record in domain `keyRotation`:

```
RotationRecord = {
  genesisKeyId: KeyId,       // the subject's genesis keyId; subject principal = "id:" + this
  key:          string,      // base64url(new publicKey)
  notBeforeMs:  number,
  expiresMs:    number,      // working-key window end
  supersedes?:  KeyId,       // a prior key this retires
  nonce:        string,      // base64url
  $hubrpcSignature: { keyRotation: SignatureEntry }   // signed by the admin (chapter 06 §2)
}
```

The signing domain value for the new domain is `hubrpc-sig/v1/keyRotation` (06 §2). The record's own keyId is `"keydoc:" + signedHash("keyRotation", record)`.

## 5. Principal-key resolution

This extension generalizes `resolvePrincipalKey(signedObject, principalId, keyId)` (06 §3). It returns a public key only when `keyId` resolves and belongs to `principalId`; otherwise it returns `undefined` (fail-closed). Implementations MUST bound recursion depth and reject cycles.

1. **Inline** — `keyId` begins `key:`: the key is the base64url decoding after `key:`.
2. **Document lookup** — `keyId` begins `keydoc:`: let `doc = bindings[keyId]`; reject if absent. Determine the role domain `d` from `doc` (`keyRotation` if `doc` has a `genesisKeyId`, else `keyGenesis`) and reject unless `"keydoc:" + signedHash(d, doc) === keyId`.
  - **Genesis** (`d = keyGenesis`): reject if `doc.expiresMs` is set and `t > doc.expiresMs`; the key is the decoding of `doc.key`.
  - **Rotation** (`d = keyRotation`): look up `g = bindings[doc.genesisKeyId]` and hash-validate it as a `keyGenesis` document, without applying its genesis-key expiry; reject if absent, malformed, or missing `admin`. Verify the record's `keyRotation` signature, then reject unless its verified `keyId` is bound to `g.admin`. Reject unless `doc.notBeforeMs ≤ t ≤ doc.expiresMs`. The key is the decoding of `doc.key`. The genesis key's `g.expiresMs` does not constrain this window.

The resolver completes the principal check as follows:

1. An inline or genesis-document `keyId` is bound to `principal` iff `"id:" + keyId === principal`.
2. A rotation-record `keyId` is bound to `principal` iff `"id:" + record.genesisKeyId === principal` and the record resolved successfully above.

The same resolution and binding checks apply to call principals, capability issuers, and rotation admins.

## 6. Key lifetime and compromise

- `expiresMs` in a genesis document bounds direct use of the genesis key. After that time the principal remains the same, but it MUST authenticate through an unexpired admin-authorized rotation key.
- If the genesis document has no `admin`, genesis-key expiry makes the principal unusable because no later key can be authorized. This is a consequence of an unrotatable identity losing its only key, not expiry of the principal itself.
- Early revocation lives at the relying party: a service removes a principal from its accepted roots (chapter 05 `rootPrincipalSets`, chapter 08). Trust is the verifier's, never the token's.
- `expiresMs` on a **rotation record** genuinely bounds a leaked working key, since the admin sets the window and the working key cannot widen it — the case for an offline admin plus short-lived working keys.
- The effective lifetime of a call authenticated by a rotation key is bounded by that rotation record and any capability or application deadlines: `min(rotation.expiresMs, capability.expiresAtMs, …)`. The genesis key's expiry is relevant only when that key signs the call directly.

## 7. Versioning

There is **no per-message algorithm field**. The signing domain value encodes the version: `hubrpc-sig/v1/<domain>` (06 §2) fixes one frozen suite `(Ed25519, SHA-256)` and, being inside the signed bytes, cannot be downgraded. Algorithm agility is achieved by **adding** a version (a new domain value, e.g. `hubrpc-sig/v2/<domain>`), never by negotiating within one. The algorithm is a property of the resolved key, never of caller-supplied input.

> **Note.** This follows PASETO's versioned-fixed-suite model and the DID subject / verificationMethod / proof split (`principal` / `keyId` / `{keyId, sig}`), borrowing the models without their serialization machinery.
