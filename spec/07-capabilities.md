# 07 — Capabilities

**Optional. Requires chapter 06.** Identity says *who* makes a call; a capability is a signed predicate describing *which calls that identity may make*. Here, a **call** means either a JSON-RPC request or notification. This chapter defines that predicate as `capabilityPermits`, how callers present capabilities under `params.$linkrpcUnsigned.capabilities`, and the **gate** a provider runs to authorize a call. The model is fail-closed: absent a valid permitting capability chain, a gated call is refused.

## 1. Capability

A capability is a flat JSON object plus a `capability`-domain signature (chapter 06 §2). Its `permissions` form a predicate over calls: `capabilityPermits(call, capability, ability)` is true when at least one permission admits the call for the requested ability.

```ts
interface Capability {
  issuer: PrincipalId;
  audience: PrincipalId;
  permissions: Permission[];
  expiresAtMs?: number; // Unix milliseconds; absent means no expiry
  parentHash?: string;  // signedHash("capability", parent); absent means root
  nonce: string;        // per-capability distinguisher, base64url
}

type SignedCapability = Capability & SignedObject<"capability">;
```

The `capability` signature commits to `signingInput("capability", getData(cap))` (chapter 06 §2). `verifySignatureWithPrincipal(cap, "capability", cap.issuer, resolvePrincipalKey)` MUST succeed (chapter 06 §3).

Capabilities refer to signed objects by content hash. The hash uses exactly the bytes committed to by the corresponding signature:

```ts
function signedHash<TDomain extends string>(
  domain: TDomain,
  signedObject: SignedObject<TDomain>,
): string {
  return base64url(sha256(
    signingInput(domain, getData(signedObject)),
  ));
}
```

### 1.1 Permission

Each permission describes a set of calls and which ability the holder has over that set:

```ts
type Pattern = { exact: string } | { prefix: string };

type ParamMatcher =
  | { exact: unknown }
  | { enum: unknown[] }
  | { prefix: string }
  | { subsetOf: string[] }
  | { any: true };

interface TargetPattern {
  serviceId: Pattern;
  interfaceId: Pattern;
  interfaceHash?: string;
  members: Pattern[];
}

interface Permission {
  target: TargetPattern;
  canInvoke?: boolean;   // defaults to false
  canDelegate?: boolean; // defaults to false
  params?: Record<string, ParamMatcher>;
  callBind?: { alg: "sha256"; payloadHash: string };
}

type Ability = "invoke" | "delegate";
```

`Call` is the capability layer's normalized view of either a JSON-RPC request or notification after identity verification:

```ts
interface Call {
  target: {
    serviceId: string;
    interfaceId: string;
    interfaceHash?: string;
    member: string;
  };
  params: Record<string, unknown>; // user params; reserved fields removed
  principal: PrincipalId;          // authenticated caller
  callHash: string;                // signedHash("call", signed params)
}
```

The following functions define the core semantic predicate. A call is contained in one capability's authority for an ability iff at least one permission returns `true`:

```ts
function capabilityPermits(
  call: Call,
  capability: Capability,
  ability: Ability,
): boolean {
  return capability.permissions.some(
    permission => permissionPermits(call, permission, ability),
  );
}

function permissionPermits(
  call: Call,
  permission: Permission,
  ability: Ability,
): boolean {
  const grantsAbility = ability === "invoke"
    ? permission.canInvoke === true
    : permission.canDelegate === true;
  if (!grantsAbility) return false;

  if (!targetMatches(call.target, permission.target)) return false;
  if (permission.params !== undefined &&
      !paramsMatch(call.params, permission.params)) return false;

  const bind = permission.callBind;
  if (bind !== undefined &&
      (bind.alg !== "sha256" || bind.payloadHash !== call.callHash)) return false;

  return true;
}

function targetMatches(call: Call["target"], target: TargetPattern): boolean {
  return patternMatches(call.serviceId, target.serviceId, "/") &&
    patternMatches(call.interfaceId, target.interfaceId, ".") &&
    (target.interfaceHash === undefined ||
      target.interfaceHash === call.interfaceHash) &&
    Array.isArray(target.members) &&
    target.members.some(pattern => patternMatches(call.member, pattern, ""));
}

function patternMatches(value: string, pattern: Pattern, delimiter: string): boolean {
  if ("exact" in pattern) return value === pattern.exact;
  if (pattern.prefix === "") return true;
  if (delimiter === "") return value.startsWith(pattern.prefix);
  return value === pattern.prefix ||
    value.startsWith(pattern.prefix + delimiter);
}
```

`params` is a strict top-level allowlist. Its key set MUST equal the call's user-param key set, and every value MUST match:

```ts
function paramsMatch(
  actual: Record<string, unknown>,
  declared: Record<string, ParamMatcher>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const declaredKeys = Object.keys(declared).sort();
  if (actualKeys.length !== declaredKeys.length ||
      actualKeys.some((key, index) => key !== declaredKeys[index])) return false;

  return declaredKeys.every(
    key => paramValueMatches(actual[key], declared[key]),
  );
}

function paramValueMatches(value: unknown, matcher: ParamMatcher): boolean {
  if ("any" in matcher) return true;
  if ("prefix" in matcher)
    return typeof value === "string" && value.startsWith(matcher.prefix);
  if ("subsetOf" in matcher)
    return Array.isArray(value) && value.every(
      item => typeof item === "string" && matcher.subsetOf.includes(item),
    );
  if ("exact" in matcher) return jcsEqual(value, matcher.exact);
  if ("enum" in matcher)
    return matcher.enum.some(option => jcsEqual(value, option));
  return false;
}

function jcsEqual(left: unknown, right: unknown): boolean {
  return bytesEqual(jcsBytes(left), jcsBytes(right));
}
```

An omitted `params` accepts any user params. `{ any: true }` permits any value for one explicitly allowed key. Empty `members` matches no call; `[{ prefix: "" }]` matches every member.

A `callBind` admits only the call whose `callHash` equals its `payloadHash`. This pins all signed fields at once and is intrinsically single-use because chapter 06 §4.1 rejects reuse of the signed nonce.

> **Note.** `callBind` uses the *same bytes the call signature commits to*, so an issuer can pre-compute it at consent time exactly as the caller will sign — the basis of "Allow once".

## 2. Presenting capabilities

A caller attaches capabilities to a request or notification under `params.$linkrpcUnsigned.capabilities` (chapter 01 §3). The partial message interface repeats the relevant envelope fields to show their location:

```ts
interface CallUnsignedData {
  capabilities?: SignedCapability[];
}

interface JsonRpcMessage {
  // jsonrpc, id, and other fields specified in earlier chapters are omitted.
  method: string;
  params: {
    [propertyName: string]: unknown;
    $hubrpc: {
      method: string;
      nonce: string;
      signedAtMs: number;
      principal?: PrincipalId;
      interfaceHash?: string;
    };
    $linkrpcSignature?: {
      [domain: string]?: SignatureEntry;
    };
    $linkrpcUnsigned?: CallUnsignedData;
  };
}
```

`$linkrpcUnsigned` is **not** covered by the call signature (chapter 06 §4): each capability has its own issuer signature and can be attached without changing the signed call. `capabilities` is an unordered set of presented capabilities, not a chain. It MAY contain leaves for multiple candidate chains and MUST contain every ancestor needed to resolve any chain the caller expects the provider to accept.

## 3. Delegation chains

A capability with a `parentHash` delegates from exactly one parent, referenced by `signedHash("capability", parent)`. A capability without `parentHash` is a root. To construct a candidate chain, a provider starts at a presented leaf and repeatedly resolves `parentHash` against the presented set until it reaches a root. A missing parent, duplicate hash, or cycle makes that candidate chain invalid.

The resolved chain is ordered leaf first and root last:

```ts
type CapabilityChain = readonly [
  SignedCapability,
  ...SignedCapability[],
];
```

**Effective authority is the intersection over one resolved chain**: the call MUST be permitted by every link. The leaf grants `invoke` to the caller; each ancestor grants `delegate` to the issuer of its child.

```ts
function chainPermits(call: Call, chain: CapabilityChain): boolean {
  return chain.every(
    (capability, index) => capabilityPermits(
      call,
      capability,
      index === 0 ? "invoke" : "delegate",
    ),
  );
}
```

`chainPermits` assumes the chain has already been resolved and describes authority intersection only. It does not inspect `parentHash` or search `CallUnsignedData.capabilities`. The gate additionally validates signatures, audiences, expiry, parent relationships, and the trusted root.

## 4. The gate

A provider that gates a call MUST, in order:

1. **Verify identity** (chapter 06 §4.1): valid signature, `principal` present, method assertion, freshness, nonce single-use. On failure, reject.
2. **Resolve candidate chains**: treat each presented capability whose `audience` equals the call's `principal` as a possible leaf and follow `parentHash` through the presented set to a root.
3. **Verify each candidate chain**: verify every capability signature for its `issuer`; require each parent's hash to equal its child's `parentHash`; require each parent's `audience` to equal its child's `issuer`; require every `expiresAtMs` to be in the future; and require the root issuer to be trusted by the provider for the target service.
4. **Check permission**: at least one fully valid candidate chain MUST satisfy `chainPermits(call, chain)`. The leaf therefore permits `invoke`, every ancestor permits `delegate`, and all links contain the same call in their declared authority.

A call that fails authorization MUST be rejected with `permissionRequired` (chapter 01 §4). The gate is **fail-closed**: if no presented candidate chain is complete, valid, trusted, and permitting, the call is refused.

> **Note.** Steps are ordered cheapest-rejection-first only as guidance; the normative requirement is that all of identity, chain validity, and permission hold. An ungated call (one the provider does not require a capability for) skips the gate entirely — this is what lets a Capability provider interoperate with a Core caller on its open surface (chapter 00 §3).
