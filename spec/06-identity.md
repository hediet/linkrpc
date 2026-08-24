# 06 — Identity

**Optional.** This chapter defines how a call is *signed*: the **principal** that names a signing identity (resolved to a public key via its **keyId**), the **signed-object standard** that fixes the bytes a signature commits to, the `$linkrpc` signing members and the `$linkrpcSignature` map that carry a call's signature, and the verification rules. Identity is self-contained: it authenticates *who* makes a call but grants no authority on its own (that is chapter 07). A node that does not implement identity omits these members; an unsigned call is well-formed (chapter 00 §3).

## 1. Keys

A **KeyId** names a public key. The v1 signature suite is **Ed25519** ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)): a signature is 64 bytes and a public key is 32 bytes. The inline `KeyId` contains that public key as base64url without padding ([RFC 4648](https://www.rfc-editor.org/rfc/rfc4648) §5):

```
KeyId = "key:" <base64url(publicKey)>
```

Keys are exposed through these interfaces; private key material does not need to be exportable:

```ts
interface PublicKey {
  verify(data: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

interface KeyPair extends PublicKey {
  readonly keyId: KeyId;
  sign(data: Uint8Array): Promise<Uint8Array>;
}
```

For v1, `KeyPair` and `PublicKey` implement Ed25519. `sign(data)` returns the 64-byte RFC 8032 signature of `data`. `verify(data, signature)` returns whether `signature` is that key's valid Ed25519 signature of exactly `data`; it MUST return `false`, rather than throw, for malformed keys or signatures. `keyId` MUST be `"key:" + base64url(publicKey)` for the same public key used by `verify`.

An in-process key pair uses a uniformly random 32-byte Ed25519 seed as its private key and the corresponding 32-byte public key. Implementations MAY instead keep private material in an OS keystore, hardware token, or remote signer, provided the interface has the same behavior. Private key material MUST NOT be exposed on the wire.

## 2. The signed-object standard

Signing in linkrpc follows one rule, applied to any JSON object in a **domain**. This chapter uses `call`; chapter 07 uses `capability`. The identity extension adds domains such as `keyRotation`; the domain set is open.

Signing is backwards-compatible with the existing wire envelope: it only adds members whose names begin with the reserved `$linkrpc` prefix. It does not change the shape or meaning of user params or any JSON-RPC field. A node that does not implement identity ignores these members (chapter 00 §3), while a node that does implement identity interprets them as defined below.

### 2.1 Signing

A signed object is the original object plus a domain-indexed signature map and, optionally, unsigned attachment data:

```ts
interface SignatureEntry {
  keyId: KeyId;
  sig: string;
}

type SignedObject<TDomain extends string> = {
  [propertyName: string]: unknown;
  $linkrpcSignature:
    Record<TDomain, SignatureEntry> &
    Partial<Record<string, SignatureEntry>>;
  $linkrpcUnsigned?: object;
};

async function sign<TDomain extends string>(
  domain: TDomain,
  signingKey: KeyPair,
  objectToSign: object,
  unsignedData: object,
): Promise<SignedObject<TDomain>> {
  const sig = base64url(await signingKey.sign(
    signingInput(domain, getData(objectToSign)),
  ));

  return {
    ...getData(objectToSign),
    $linkrpcSignature: {
      [domain]: { keyId: signingKey.keyId, sig },
    },
    $linkrpcUnsigned: unsignedData,
  };
}
```

The signing key owns the private key material; it need not expose or export it. Its `keyId` is copied into the signature entry. The returned value is the final wire object.

The signature does not cover `$linkrpcSignature` (which contains the signature itself) or `$linkrpcUnsigned` (which contains attachments authored independently of the signer). It covers every other property, including `$linkrpc`.

The signed and unsigned parts are read independently:

```ts
function getData(signedObject: object): object {
  const data = { ...signedObject } as Record<string, unknown>;
  delete data.$linkrpcSignature;
  delete data.$linkrpcUnsigned;
  return data;
}

function getUnsignedData<TDomain extends string>(
  signedObject: SignedObject<TDomain>,
): object | undefined {
  return signedObject.$linkrpcUnsigned;
}
```

Unsigned data is not authenticated and can be changed without affecting the signature. Applications MUST NOT derive trust from it.

The exact bytes passed to Ed25519 are defined below. `jcsBytes` is RFC 8785 canonicalization encoded as UTF-8 (chapter 04 §4).

```ts
function signingInput(
  domain: "call" | "capability" | string,
  data: object,
): Uint8Array {
  return jcsBytes({ [`linkrpc-sig/v1/${domain}`]: data });
}
```

Wrapping the signed content under the complete suite-and-domain key makes domain separation self-delimiting. A `call` signature cannot verify as a `capability` signature, and domain names cannot create byte-prefix ambiguity.

### 2.2 Verification

A verifier resolves the advertised `keyId`, then verifies the signature with that key:

```ts
type VerifyResult =
  | { valid: true; key: PublicKey }
  | { valid: false };

async function verifySignature<TDomain extends string>(
  signedObject: SignedObject<TDomain>,
  domain: TDomain,
  resolveKey: (
    signedObject: SignedObject<TDomain>,
    keyId: KeyId,
  ) => PublicKey | undefined,
): Promise<VerifyResult> {
  const entry = readSignature(signedObject, domain);
  if (entry === undefined) return { valid: false };

  const publicKey = resolveKey(signedObject, entry.keyId);
  if (publicKey === undefined) return { valid: false };

  const signature = tryBase64urlDecode(entry.sig);
  if (signature === undefined) return { valid: false };

  const valid = await publicKey.verify(
    signingInput(domain, getData(signedObject)),
    signature,
  );
  if (!valid) return { valid: false };

  return {
    valid: true,
    key: publicKey,
  };
}
```

`resolveKey` resolves the advertised `keyId` only. It MAY use `$linkrpcUnsigned` as untrusted resolution evidence, but MUST validate that evidence before returning a key. `verifySignature` does not know about principals.

Malformed signature data, failed key resolution, or a failed Ed25519 check returns `{ valid: false }`.

### 2.3 Example

Signing data and adding an unsigned attachment produces the complete wire object:

```ts
const signed = await sign(
  "example",
  signingKey,
  {
    action: "read",
  },
  { traceId: "<trace-id>" },
);

// signed = {
//   action: "read",
//   $linkrpcSignature: {
//     example: { keyId: "key:<public-key>", sig: "<signature>" },
//   },
//   $linkrpcUnsigned: { traceId: "<trace-id>" },
// }

getUnsignedData(signed);
// => { traceId: "<trace-id>" }

getData(signed);
// => { action: "read" }

await verifySignature(signed, "example", resolveKey);
// => { valid: true, key }

await verifySignature(signed, "other", resolveKey);
// => { valid: false } (wrong domain)

signed.$linkrpcUnsigned = { traceId: "<another-trace-id>" };
await verifySignature(signed, "example", resolveKey);
// => { valid: true, ... } (unsigned attachments changed)

signed.action = "write";
await verifySignature(signed, "example", resolveKey);
// => { valid: false } (signed content changed)
```

> **Rationale.** A verifier only strips two reserved keys, wraps the result under the suite-and-domain key, and applies JCS.

## 3. Principals

A **PrincipalId** names a stable identity independently of the key currently used to sign. In v1, a principal is named by its genesis key:

```
PrincipalId = "id:" <genesis KeyId>
```

Because the genesis public key is part of the principal id, no one can produce a valid signature for an existing principal id without possessing its corresponding private key. Assuming that private key remains private and Ed25519 is secure, the initial principal id is therefore self-certifying and cannot be impersonated. Anyone can create a different key pair and therefore a different principal id.

Principal-aware verification is a separate operation built on the generic signed-object verifier:

```ts
function verifySignatureWithPrincipal<TDomain extends string>(
  signedObject: SignedObject<TDomain>,
  domain: TDomain,
  principalId: PrincipalId,
  resolvePrincipalKey: (
    signedObject: SignedObject<TDomain>,
    principalId: PrincipalId,
    keyId: KeyId,
  ) => PublicKey | undefined,
): Promise<VerifyResult> {
  return verifySignature(
    signedObject,
    domain,
    (object, keyId) => resolvePrincipalKey(object, principalId, keyId),
  );
}
```

The current inline `resolvePrincipalKey` accepts only the genesis key. It checks that `keyId` is both a valid inline key and exactly the key named by `principalId`:

```ts
function resolvePrincipalKey<TDomain extends string>(
  signedObject: SignedObject<TDomain>,
  principalId: PrincipalId,
  keyId: KeyId,
): PublicKey | undefined {
  if (!keyId.startsWith("key:")) return undefined;
  if (`id:${keyId}` !== principalId) return undefined;

  const publicKeyBytes = tryBase64urlDecode(keyId.slice("key:".length));
  if (publicKeyBytes === undefined || publicKeyBytes.length !== 32) return undefined;

  return ed25519PublicKey(publicKeyBytes);
}
```

`signedObject` is unused by the inline resolver. The identity extension ([identity-extension.md](identity-extension.md)) uses its validated `$linkrpcUnsigned.bindings` evidence to resolve rotated keys while preserving the same function shape.

The principal is a claim inside the signed data: calls use `$linkrpc.principal`, capabilities use `issuer`, and rotation records use the genesis document's `admin`. A mismatched `(principalId, keyId)` pair MUST resolve to `undefined` (fail-closed).

## 4. Signed calls

A call's signing metadata lives in its `params.$linkrpc` object (chapter 01 §3.1). The partial interface below shows the fields relevant to identity; a message may contain additional JSON-RPC and linkrpc fields specified in earlier chapters.

```ts
interface JsonRpcMessage {
  // jsonrpc, id, and other fields specified in earlier chapters are omitted.
  method: string;
  params: {
    [propertyName: string]: unknown;
    $linkrpc: {
      method: string;         // fully-qualified wire method; MUST equal method above
      nonce: string;          // replay-protection nonce, base64url
      signedAtMs: number;     // Unix milliseconds when the call was signed
      principal?: PrincipalId;
      interfaceHash?: string; // optional version assertion (chapter 04 §5)
    };
    $linkrpcSignature?: {
      [domain: string]?: { keyId: KeyId; sig: string };
    };
    $linkrpcUnsigned?: object;
  };
}
```

The method appears twice deliberately. The outer `message.method` is the JSON-RPC routing field and is not part of the signed `params` object. The inner `params.$linkrpc.method` is the signer's assertion of the intended route and is covered by the signature. A receiver MUST require the two values to be equal. Thus a forwarder may read the outer method to route the message, but cannot change it to redirect a signed call without verification failing.

`$linkrpc` is present on both signed and unsigned calls (an unsigned call omits `principal` and carries no `$linkrpcSignature`).

A **signed call** is one whose `params` object is call-signed (domain `call`, §2). On a signed call, `principal` MUST be present and `verifySignatureWithPrincipal(params, "call", principal, resolvePrincipalKey)` MUST succeed.

```ts
const principalId = message.params.$linkrpc.principal;
if (principalId === undefined) reject();

const verified = await verifySignatureWithPrincipal(
  message.params,
  "call",
  principalId,
  resolvePrincipalKey,
);
if (!verified.valid) reject();
```

The resolver binds the signature entry's `keyId` to the principal claim carried by the signed bytes.

> **Note.** The strip rule (§2) removes `$linkrpcSignature` and `$linkrpcUnsigned` but keeps `$linkrpc`, so the signature binds `$linkrpc.method`, `nonce`, `signedAtMs`, `principal`, and the user params. The equality check against the outer `method` binds that signed assertion to JSON-RPC routing, and the bound `nonce` makes the bytes unique per attempt.

### 4.1 Verification

A node that requires a signed call MUST, before acting on it:

1. verify the `call` signature for `$linkrpc.principal` using `resolvePrincipalKey` (§§2–3);
2. assert `$linkrpc.method` equals the JSON-RPC `method`;
3. enforce a freshness window on `signedAtMs` (reject calls outside an acceptable clock-skew bound);
4. enforce single-use of `nonce` per principal (reject a replay of a previously-seen `(principal, nonce)`).

A call failing any step MUST be rejected. The error is `permissionRequired` when the gate is the capability layer (chapter 07); a node enforcing identity alone MAY use `invalidParams`.

### 4.2 Skipping identity

A node MAY operate without identity, in which case calls carry no `principal` and no `$linkrpcSignature`. A node that requires identity for a given call but receives an unsigned one MUST reject it (§4.1); a node that does not require identity MUST NOT reject a call merely for being unsigned.
