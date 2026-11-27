// Live Rust <-> TypeScript signature & capability verification bridge.
//
// Reads a JSON payload produced by Rust on stdin:
//   {
//     keypairJson: { privateKey, publicKey },
//     expectedPrincipal: "id:key:...",
//     signedObjectDomain: "example",
//     signedObject: { ..., $hubrpcSignature: ... },
//     signedCallMethod: "hello::greeter::hello",
//     signedCallWireParams: { ..., $hubrpc: ..., $hubrpcSignature: ..., $hubrpcUnsigned: { capabilities: [...] } },
//     acceptedRootIssuer: "id:key:...",
//     nowMs: 1700000000000
//   }
//
// Verifies every Rust-produced artifact using the REAL TypeScript `@hediet/linkrpc`
// implementation, then signs a fresh TS RPC call + TS capability and prints them as JSON
// to stdout so Rust verifies them back.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");
const linkrpcDist = join(repoRoot, "typescript", "packages", "linkrpc", "dist", "index.js");
const signingDist = join(repoRoot, "typescript", "packages", "linkrpc", "dist", "signing.js");

const linkrpc = await import(pathToFileURL(linkrpcDist).href);
const signing = await import(pathToFileURL(signingDist).href);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

// 1. Verify Rust-exported keypair JSON loads cleanly in TS with identical principal.
const restored = linkrpc.KeypairSigningIdentity.fromJson(input.keypairJson);
if (restored.publicSigningIdentity.principal !== input.expectedPrincipal) {
  throw new Error(
    `principal mismatch: TS=${restored.publicSigningIdentity.principal} Rust=${input.expectedPrincipal}`,
  );
}

// 2. Verify Rust-signed generic object in TS.
const objOk = await signing.verifyObjectByPrincipal(
  input.signedObjectDomain,
  input.signedObject,
  input.expectedPrincipal,
);
if (!objOk) {
  throw new Error("TS failed to verify Rust-signed generic object");
}

// 3. Verify Rust-signed RPC call envelope in TS.
const verifiedCall = await linkrpc.verifyRpcCall({
  wireMethod: input.signedCallMethod,
  wireParams: input.signedCallWireParams,
  nowMs: input.nowMs,
  maxSkewMs: 300_000,
  requireSigned: true,
});
if (!verifiedCall.ok || !verifiedCall.identity) {
  throw new Error(`TS verifyRpcCall rejected Rust call: ${JSON.stringify(verifiedCall)}`);
}
if (verifiedCall.identity.signer !== input.expectedPrincipal) {
  throw new Error("TS verifyRpcCall signer mismatch");
}

// 4. Verify Rust-minted delegated capability chain authorizes the Rust call in TS `permits()`.
const parsedMethod = linkrpc.parseMethodName(input.signedCallMethod);
if (!parsedMethod || parsedMethod.kind !== "full") {
  throw new Error("expected full method name");
}
const permitRes = await linkrpc.permits(
  {
    target: {
      serviceId: parsedMethod.serviceId,
      interfaceId: parsedMethod.interfaceId,
      member: parsedMethod.member,
      ...(verifiedCall.identity.callMeta.interfaceHash !== undefined
        ? { interfaceHash: verifiedCall.identity.callMeta.interfaceHash }
        : {}),
    },
    params: verifiedCall.params,
    nonce: verifiedCall.identity.callMeta.nonce,
    signedAtMs: verifiedCall.identity.callMeta.signedAtMs,
    signer: verifiedCall.identity.signer,
    callHash: verifiedCall.identity.callHash,
  },
  verifiedCall.identity.capabilities,
  () => [{ principal: input.acceptedRootIssuer, isPublic: true }],
  input.nowMs,
);
if (!permitRes.ok) {
  throw new Error(`TS permits() rejected Rust capability chain: ${permitRes.reason}`);
}

// 5. Generate a fresh random TS identity, sign a reply call + capability, and return for Rust to verify.
const tsCaller = await linkrpc.KeypairSigningIdentity.generateNew();
const tsIssuer = await linkrpc.KeypairSigningIdentity.generateNew();
const tsCall = await linkrpc.signRpcCall({
  method: "rust::service::echo",
  params: { message: "hello from TS", count: 42 },
  signingIdentity: tsCaller,
  nowMs: input.nowMs,
});
const tsCap = await linkrpc.issueCapability(tsIssuer, {
  audience: tsCaller.publicSigningIdentity,
  permissions: [
    {
      target: {
        serviceId: { exact: "rust" },
        interfaceId: { exact: "service" },
        members: [{ exact: "echo" }],
      },
      canInvoke: true,
    },
  ],
  expiresAtMs: input.nowMs + 60_000,
});
const tsWireParams = linkrpc.attachCapabilities(tsCall.wireParams, [tsCap]);

process.stdout.write(
  JSON.stringify({
    verifiedRust: true,
    rustCallHash: verifiedCall.identity.callHash,
    rustRootIssuer: permitRes.rootIssuer,
    tsCallerPrincipal: tsCaller.publicSigningIdentity.principal,
    tsIssuerPrincipal: tsIssuer.publicSigningIdentity.principal,
    tsMethod: "rust::service::echo",
    tsWireParams,
    tsCallHash: tsCall.callHash,
  }) + "\n",
);
