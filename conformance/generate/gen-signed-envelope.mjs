// Generates conformance/vectors/signed_envelope.json from the REAL TypeScript
// `@hediet/linkrpc` implementation.
//
// Covers:
//   - Deterministic seeded Ed25519 identities (privateKey, publicKey, keyId, principal)
//   - Generic signed objects (`signObject`, `signingInput`, `signedHash`)
//   - `$hubrpc` signed RPC call envelopes (`signRpcCall`, `attachCapabilities`)
//   - `verifyRpcCall` pass/fail verdicts (tampered params, method mismatch, skew, wrong keyId,
//     unsigned vs requireSigned, mutated `$hubrpcUnsigned`)
//   - Signed capabilities + `permits` chain-verification verdicts (root, 2-link delegation,
//     callBind, param matchers, unaccepted root, expired)
//
// Ed25519 (RFC 8032) is deterministic, so Rust must produce byte-identical keys, signing
// inputs, hashes, signatures, and verification verdicts for every case.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const linkrpcDist =
  process.env.LINKRPC_TS_DIST ??
  join(here, "..", "..", "typescript", "packages", "linkrpc", "dist", "index.js");
const signingDist = join(dirname(linkrpcDist), "signing.js");

const linkrpc = await import(pathToFileURL(linkrpcDist).href);
const signing = await import(pathToFileURL(signingDist).href);

const {
  attachCapabilities,
  bytesToBase64Url,
  createSeededSigningIdentity,
  permits,
  signCapability,
  signRpcCall,
  signedHash,
  signingInput,
  verifyRpcCall,
} = linkrpc;
const { signObject } = signing;

const td = new TextDecoder();

// ── 1. Seeded identities ──────────────────────────────────────────────────────
const identities = [];
const seededMap = new Map();
for (const seed of [0, 1, 2]) {
  const id = await createSeededSigningIdentity({ seed });
  seededMap.set(seed, id);
  const serialized = id.toJson();
  identities.push({
    seed,
    privateKey: serialized.privateKey,
    publicKey: serialized.publicKey,
    keyId: id.publicSigningIdentity.keyId,
    principal: id.publicSigningIdentity.principal,
  });
}

const callerId = seededMap.get(0);
const adminId = seededMap.get(1);
const delegateId = seededMap.get(2);

// ── 2. Generic signed objects ─────────────────────────────────────────────────
const objectCases = [
  {
    name: "simple-example",
    seed: 0,
    domain: "example",
    object: { action: "read", count: 3, nested: { b: true, a: "hi" } },
    unsigned: { traceId: "trace-1" },
  },
  {
    name: "unicode-and-escapes",
    seed: 1,
    domain: "custom.domain",
    object: { note: "café ☕ \"quoted\"\nline2", empty: {}, list: [1, null, false] },
    unsigned: undefined,
  },
];

const signedObjects = [];
for (const c of objectCases) {
  const id = seededMap.get(c.seed);
  const withUnsigned =
    c.unsigned !== undefined ? { ...c.object, $hubrpcUnsigned: c.unsigned } : c.object;
  const inputUtf8 = td.decode(signingInput(c.domain, withUnsigned));
  const hash = signedHash(c.domain, withUnsigned);
  const signed = await signObject(c.domain, withUnsigned, id);
  signedObjects.push({
    name: c.name,
    seed: c.seed,
    domain: c.domain,
    object: withUnsigned,
    signingInput: inputUtf8,
    signedHash: hash,
    signed,
  });
}

// ── 3. Signed RPC calls ───────────────────────────────────────────────────────
const fixedNowMs = 1_700_000_000_000;
const nonceA = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const nonceB = new Uint8Array([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);

const rpcSignSpecs = [
  {
    name: "basic-call",
    seed: 0,
    method: "hello::greeter::hello",
    params: { name: "world" },
    nowMs: fixedNowMs,
    nonce: nonceA,
  },
  {
    name: "call-with-interface-hash",
    seed: 0,
    method: "acme::com.acme.pizza::order",
    params: { kind: "margherita", size: "large", quantity: 2 },
    nowMs: fixedNowMs + 500,
    nonce: nonceB,
    interfaceHash: "0123456789abcdef",
  },
  {
    name: "call-with-no-params",
    seed: 1,
    method: "hub::hubrpc.directory::list",
    params: undefined,
    nowMs: fixedNowMs + 1000,
    nonce: nonceA,
  },
];

const signedCalls = [];
for (const spec of rpcSignSpecs) {
  const id = seededMap.get(spec.seed);
  const res = await signRpcCall({
    method: spec.method,
    params: spec.params,
    signingIdentity: id,
    nowMs: spec.nowMs,
    nonce: spec.nonce,
    ...(spec.interfaceHash !== undefined ? { interfaceHash: spec.interfaceHash } : {}),
  });
  signedCalls.push({
    name: spec.name,
    seed: spec.seed,
    method: spec.method,
    params: spec.params ?? null,
    paramsOmitted: spec.params === undefined,
    nowMs: spec.nowMs,
    nonceB64: bytesToBase64Url(spec.nonce),
    interfaceHash: spec.interfaceHash ?? null,
    callMeta: res.callMeta,
    callHash: res.callHash,
    wireParams: res.wireParams,
  });
}

// ── 4. Signed capabilities + call with attached cap ───────────────────────────
const rootCapUnsigned = {
  issuer: adminId.publicSigningIdentity.principal,
  audience: callerId.publicSigningIdentity.principal,
  permissions: [
    {
      target: {
        serviceId: { exact: "hello" },
        interfaceId: { exact: "greeter" },
        members: [{ exact: "hello" }],
      },
      canInvoke: true,
    },
  ],
  expiresAtMs: fixedNowMs + 60_000,
  nonce: "cap-root-nonce-1",
};
const rootCap = await signCapability(rootCapUnsigned, adminId);
const rootCapHash = signedHash("capability", rootCap);

const delegatingParentUnsigned = {
  issuer: adminId.publicSigningIdentity.principal,
  audience: delegateId.publicSigningIdentity.principal,
  permissions: [
    {
      target: {
        serviceId: { prefix: "hello" },
        interfaceId: { prefix: "greeter" },
        members: [{ prefix: "" }],
      },
      canDelegate: true,
    },
  ],
  expiresAtMs: fixedNowMs + 120_000,
  nonce: "cap-parent-nonce-1",
};
const delegatingParent = await signCapability(delegatingParentUnsigned, adminId);
const delegatingParentHash = signedHash("capability", delegatingParent);

const delegatedLeafUnsigned = {
  issuer: delegateId.publicSigningIdentity.principal,
  audience: callerId.publicSigningIdentity.principal,
  permissions: [
    {
      target: {
        serviceId: { exact: "hello/sub" },
        interfaceId: { exact: "greeter.v2" },
        members: [{ exact: "wave" }],
      },
      canInvoke: true,
      params: { name: { prefix: "a" } },
    },
  ],
  expiresAtMs: fixedNowMs + 60_000,
  parentHash: delegatingParentHash,
  nonce: "cap-leaf-nonce-1",
};
const delegatedLeaf = await signCapability(delegatedLeafUnsigned, delegateId);
const delegatedLeafHash = signedHash("capability", delegatedLeaf);

const basicCallWithCap = attachCapabilities(signedCalls[0].wireParams, [rootCap]);

const callBoundCapUnsigned = {
  issuer: adminId.publicSigningIdentity.principal,
  audience: callerId.publicSigningIdentity.principal,
  permissions: [
    {
      target: {
        serviceId: { exact: "hello" },
        interfaceId: { exact: "greeter" },
        members: [{ exact: "hello" }],
      },
      canInvoke: true,
      callBind: { alg: "sha256", payloadHash: signedCalls[0].callHash },
    },
  ],
  expiresAtMs: fixedNowMs + 60_000,
  nonce: "cap-once-nonce-1",
};
const callBoundCap = await signCapability(callBoundCapUnsigned, adminId);

const capabilities = [
  { name: "root-greeter", seed: 1, unsigned: rootCapUnsigned, signed: rootCap, hash: rootCapHash },
  {
    name: "delegating-parent",
    seed: 1,
    unsigned: delegatingParentUnsigned,
    signed: delegatingParent,
    hash: delegatingParentHash,
  },
  {
    name: "delegated-leaf",
    seed: 2,
    unsigned: delegatedLeafUnsigned,
    signed: delegatedLeaf,
    hash: delegatedLeafHash,
  },
  {
    name: "call-bound-once",
    seed: 1,
    unsigned: callBoundCapUnsigned,
    signed: callBoundCap,
    hash: signedHash("capability", callBoundCap),
  },
];

// ── 5. verifyRpcCall pass/fail cases ──────────────────────────────────────────
const tamperedParams = structuredClone(signedCalls[0].wireParams);
tamperedParams.name = "mallory";

const wrongKeyIdParams = structuredClone(signedCalls[0].wireParams);
wrongKeyIdParams.$hubrpcSignature.call.keyId = adminId.publicSigningIdentity.keyId;

const unsignedWithMeta = {
  name: "world",
  $hubrpc: { method: "hello::greeter::hello", nonce: "n1", signedAtMs: fixedNowMs },
};

const verifyCallInputs = [
  {
    name: "valid-signed-call",
    wireMethod: "hello::greeter::hello",
    wireParams: signedCalls[0].wireParams,
    nowMs: fixedNowMs + 1000,
    maxSkewMs: 300_000,
    requireSigned: true,
  },
  {
    name: "valid-with-unsigned-capabilities-attached",
    wireMethod: "hello::greeter::hello",
    wireParams: basicCallWithCap,
    nowMs: fixedNowMs + 1000,
    maxSkewMs: 300_000,
    requireSigned: true,
  },
  {
    name: "tampered-user-param",
    wireMethod: "hello::greeter::hello",
    wireParams: tamperedParams,
    nowMs: fixedNowMs + 1000,
    maxSkewMs: 300_000,
    requireSigned: true,
  },
  {
    name: "outer-method-mismatch",
    wireMethod: "hello::greeter::other",
    wireParams: signedCalls[0].wireParams,
    nowMs: fixedNowMs + 1000,
    maxSkewMs: 300_000,
    requireSigned: true,
  },
  {
    name: "timestamp-skew-exceeded",
    wireMethod: "hello::greeter::hello",
    wireParams: signedCalls[0].wireParams,
    nowMs: fixedNowMs + 400_000,
    maxSkewMs: 300_000,
    requireSigned: true,
  },
  {
    name: "mismatched-key-id",
    wireMethod: "hello::greeter::hello",
    wireParams: wrongKeyIdParams,
    nowMs: fixedNowMs + 1000,
    maxSkewMs: 300_000,
    requireSigned: true,
  },
  {
    name: "missing-envelope-allowed-when-optional",
    wireMethod: "hello::greeter::hello",
    wireParams: { name: "world" },
    nowMs: fixedNowMs,
    maxSkewMs: 300_000,
    requireSigned: false,
  },
  {
    name: "missing-envelope-rejected-when-required",
    wireMethod: "hello::greeter::hello",
    wireParams: { name: "world" },
    nowMs: fixedNowMs,
    maxSkewMs: 300_000,
    requireSigned: true,
  },
  {
    name: "unsigned-meta-allowed-when-optional",
    wireMethod: "hello::greeter::hello",
    wireParams: unsignedWithMeta,
    nowMs: fixedNowMs,
    maxSkewMs: 300_000,
    requireSigned: false,
  },
  {
    name: "unsigned-meta-rejected-when-required",
    wireMethod: "hello::greeter::hello",
    wireParams: unsignedWithMeta,
    nowMs: fixedNowMs,
    maxSkewMs: 300_000,
    requireSigned: true,
  },
];

const verifyRpcCalls = [];
for (const c of verifyCallInputs) {
  const res = await verifyRpcCall({
    wireMethod: c.wireMethod,
    wireParams: c.wireParams,
    nowMs: c.nowMs,
    maxSkewMs: c.maxSkewMs,
    requireSigned: c.requireSigned,
  });
  verifyRpcCalls.push({
    ...c,
    expectedOk: res.ok,
    expectedSigned: res.ok ? res.identity !== undefined : false,
    expectedSigner: res.ok ? (res.identity?.signer ?? null) : null,
    expectedCallHash: res.ok ? (res.identity?.callHash ?? null) : null,
    expectedParams: res.ok ? (res.params ?? null) : null,
    expectedCapCount: res.ok ? (res.identity?.capabilities.length ?? 0) : 0,
    expectedReason: res.ok ? null : res.reason,
  });
}

// ── 6. permits() verdicts ─────────────────────────────────────────────────────
const permitInputs = [
  {
    name: "root-cap-allows",
    call: {
      target: { serviceId: "hello", interfaceId: "greeter", member: "hello" },
      params: { name: "world" },
      nonce: bytesToBase64Url(nonceA),
      signedAtMs: fixedNowMs,
      signer: callerId.publicSigningIdentity.principal,
      callHash: signedCalls[0].callHash,
    },
    capabilities: [rootCap],
    acceptedRoots: [adminId.publicSigningIdentity.principal],
    nowMs: fixedNowMs + 1000,
  },
  {
    name: "root-cap-expired",
    call: {
      target: { serviceId: "hello", interfaceId: "greeter", member: "hello" },
      params: { name: "world" },
      nonce: bytesToBase64Url(nonceA),
      signedAtMs: fixedNowMs,
      signer: callerId.publicSigningIdentity.principal,
      callHash: signedCalls[0].callHash,
    },
    capabilities: [rootCap],
    acceptedRoots: [adminId.publicSigningIdentity.principal],
    nowMs: fixedNowMs + 120_000,
  },
  {
    name: "root-cap-unaccepted-issuer",
    call: {
      target: { serviceId: "hello", interfaceId: "greeter", member: "hello" },
      params: { name: "world" },
      nonce: bytesToBase64Url(nonceA),
      signedAtMs: fixedNowMs,
      signer: callerId.publicSigningIdentity.principal,
      callHash: signedCalls[0].callHash,
    },
    capabilities: [rootCap],
    acceptedRoots: [delegateId.publicSigningIdentity.principal],
    nowMs: fixedNowMs + 1000,
  },
  {
    name: "delegated-chain-allows",
    call: {
      target: { serviceId: "hello/sub", interfaceId: "greeter.v2", member: "wave" },
      params: { name: "alice" },
      nonce: bytesToBase64Url(nonceA),
      signedAtMs: fixedNowMs,
      signer: callerId.publicSigningIdentity.principal,
      callHash: signedCalls[0].callHash,
    },
    capabilities: [delegatedLeaf, delegatingParent],
    acceptedRoots: [adminId.publicSigningIdentity.principal],
    nowMs: fixedNowMs + 1000,
  },
  {
    name: "delegated-chain-param-mismatch",
    call: {
      target: { serviceId: "hello/sub", interfaceId: "greeter.v2", member: "wave" },
      params: { name: "bob" },
      nonce: bytesToBase64Url(nonceA),
      signedAtMs: fixedNowMs,
      signer: callerId.publicSigningIdentity.principal,
      callHash: signedCalls[0].callHash,
    },
    capabilities: [delegatedLeaf, delegatingParent],
    acceptedRoots: [adminId.publicSigningIdentity.principal],
    nowMs: fixedNowMs + 1000,
  },
  {
    name: "call-bind-allows-exact-hash",
    call: {
      target: { serviceId: "hello", interfaceId: "greeter", member: "hello" },
      params: { name: "world" },
      nonce: bytesToBase64Url(nonceA),
      signedAtMs: fixedNowMs,
      signer: callerId.publicSigningIdentity.principal,
      callHash: signedCalls[0].callHash,
    },
    capabilities: [callBoundCap],
    acceptedRoots: [adminId.publicSigningIdentity.principal],
    nowMs: fixedNowMs + 1000,
  },
  {
    name: "call-bind-rejects-different-hash",
    call: {
      target: { serviceId: "hello", interfaceId: "greeter", member: "hello" },
      params: { name: "world" },
      nonce: bytesToBase64Url(nonceA),
      signedAtMs: fixedNowMs,
      signer: callerId.publicSigningIdentity.principal,
      callHash: "different-hash",
    },
    capabilities: [callBoundCap],
    acceptedRoots: [adminId.publicSigningIdentity.principal],
    nowMs: fixedNowMs + 1000,
  },
];

const permitVerdicts = [];
for (const c of permitInputs) {
  const res = await permits(
    c.call,
    c.capabilities,
    () => c.acceptedRoots.map((principal) => ({ principal, isPublic: true })),
    c.nowMs,
  );
  permitVerdicts.push({
    ...c,
    expectedOk: res.ok,
    expectedRootIssuer: res.ok ? res.rootIssuer : null,
    expectedReason: res.ok ? null : res.reason,
  });
}

const outDir = join(here, "..", "vectors");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "signed_envelope.json");
const payload = {
  identities,
  signedObjects,
  signedCalls,
  capabilities,
  verifyRpcCalls,
  permitVerdicts,
};
writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
console.log(
  `wrote signed_envelope.json (${identities.length} identities, ${signedObjects.length} objects, ${signedCalls.length} calls, ${capabilities.length} caps, ${verifyRpcCalls.length} verify, ${permitVerdicts.length} permits)`
);
