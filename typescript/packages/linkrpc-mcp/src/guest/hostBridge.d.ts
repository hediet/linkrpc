// ---- guest <-> host boundary --------------------------------------------
//
// This file declares the ENTIRE seam between the QuickJS guest and the host.
// There is nothing else: no `require`, no module loader, no shared memory.
//
// At startup `sandbox.ts` (the host) installs each `__host*` function as a
// QuickJS global via `vm.newFunction(...)`, and injects `__docs` /
// `__lastResultVal` as global values just before the guest runtime evaluates.
//
// RPC values that cross the boundary are strings:
//   - params / args go out JSON-encoded (or "" for `undefined`),
//   - results come back JSON-encoded (or "" for `undefined`),
//   - the host re-throws guest-visible `Error`s with the message preserved.
// Timer IDs and delays cross as numbers.
//
// The host mediates and authorises every call: capability checks, the user
// consent prompt (`requestAccess`), signing and the actual socket I/O all live
// on the host side. The guest only ever sees these opaque string channels.

/**
 * Invoke a request. Resolves with the JSON-encoded result (or "").
 * `optsJson` carries per-call options ({@link CallOptions}); "" when omitted.
 */
declare function __hostCall(
    method: string,
    paramsJson: string,
    optsJson: string,
    streamId: string,
): Promise<string>;

/** Fire-and-forget request. Resolves with "" once sent. */
declare function __hostNotify(method: string, paramsJson: string): Promise<string>;

/** Reflection / discovery. `_unused` is always "". */
declare function __hostExplore(argsJson: string, _unused: string): Promise<string>;

/** Request capabilities (may prompt the user host-side). `_unused` is always "". */
declare function __hostRequestAccess(argsJson: string, _unused: string): Promise<string>;

/** List currently-held capabilities. Both args are always "". */
declare function __hostGrants(_unused1: string, _unused2: string): Promise<string>;

/** Capture a console line. Returns nothing. */
declare function __hostLog(level: "log" | "warn" | "error", text: string): void;

/** Schedule or replace a sandbox-owned timer. `repeat` is 0 or 1. */
declare function __hostSetTimer(timerId: number, delayMs: number, repeat: number): void;

/** Cancel a sandbox-owned timeout or interval. */
declare function __hostClearTimer(timerId: number): void;

/**
 * The TypeScript declarations for `con` (the `connection.d.ts` resource text),
 * injected as a literal so `con.getDocs()` needs no host round-trip.
 */
declare const __docs: string;

/**
 * The previous `runLinkRpcScript` result on this connection, JSON round-tripped.
 * Injected by the host; surfaced to user code as `lastResultVal`.
 */
declare const __lastResultVal: unknown;
