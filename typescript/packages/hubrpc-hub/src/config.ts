/**
 * Declarative hub configuration shared by the CLI (`serve`, `connect`,
 * `tunnel`, `-c, --config`), the server hub, and the VS Code extension. One
 * config describes a hub by its **transports**:
 *
 * - {@link HubConfig.listeners} — inbound: accept many peers (websocket / unix
 *   socket). Each peer is admitted by the listener's ordered {@link
 *   ConnectionHandlerSchema handlers} (keyed on the presented token), which also
 *   provision its root services (identity, granted namespace, minting).
 * - {@link HubConfig.endpoints} — outbound: dial a single far end (a remote
 *   hub over `ws`/`socket`, or a spawned child over `cmd-env`/`cmd-stdio`).
 *   Dial-out has no token, so an endpoint carries a single inline
 *   {@link provisionFields provision} instead of handlers.
 * - {@link HubConfig.namedEndpoints} — sugar over `endpoints`: the map key
 *   becomes the `grantedServiceId` and the `managedIdentity.slot`
 *   (`endpoint:<name>`) unless overridden.
 */
import { z } from 'zod';

/**
 * A **provision**: the root services a connection is granted once admitted.
 * Shared by listener handlers (static/anonymous forms) and endpoints. Each
 * field is optional and names the root interface it enables.
 */
export const ConnectionTokenBinderSchema = z.object({
    /** Managed-identity slots this binder may mint (literal string prefix). */
    identitySlotPrefix: z.string().min(1).optional(),
    /** ServiceId namespaces this binder may grant (literal string prefix). */
    serviceIdPrefix: z.string().min(1).optional(),
});
export type ConnectionTokenBinderConfig = z.infer<typeof ConnectionTokenBinderSchema>;

const provisionFields = {
    /**
     * Managed identity for the connection (`identity::*`), provisioned under
     * `slot`. Omit for no managed identity.
     */
    managedIdentity: z.object({ slot: z.string().min(1) }).optional(),
    /**
     * ServiceId namespace the connection may claim freely
     * (`hubGrantedServiceId::get`). Omit to grant no freely-claimable namespace.
     */
    grantedServiceId: z.string().min(1).optional(),
    /**
     * Authorize the connection to mint single-use connection tokens by serving
     * `connectionTokenBinder::bindConnectionToken` at its overlay root. The two
     * prefixes bound **independent axes** of what a minted token may carry; set
     * either, both, or neither.
     */
    connectionTokenBinder: ConnectionTokenBinderSchema.optional(),
};

export type ProvisionConfig = z.infer<z.ZodObject<typeof provisionFields>>;

/**
 * A listener **connection handler**: a token match + (for the static forms) the
 * provision to install when it claims. Discriminated by `token`:
 *
 * - `anonymous` — claims **any** connection (the catch-all "no auth"); provisions
 *   the inline fields.
 * - `static` — claims connections whose presented token equals `value`;
 *   provisions the inline fields.
 * - `bound` — claims connections whose token is live in the hub's
 *   connection-token store, **redeeming** it (single-use). The provision is
 *   **intrinsic** to the token's mint binding (identity slot and/or granted
 *   namespace), so it carries no inline provision.
 */
export const ConnectionHandlerSchema = z.discriminatedUnion('token', [
    z.object({ token: z.literal('anonymous'), ...provisionFields }),
    z.object({ token: z.literal('static'), value: z.string().min(1), ...provisionFields }),
    z.object({ token: z.literal('bound') }),
]);
export type ConnectionHandlerConfig = z.infer<typeof ConnectionHandlerSchema>;

/** Routing fields common to every endpoint (outbound transport). */
const routingFields = {
    /** The far end serves these service ids; route matching calls OUT to it. */
    routeServiceIds: z.array(z.string().min(1)).default([]),
    /** I serve these service ids; register them on the far end's hub. */
    claimServiceIds: z.array(z.string().min(1)).default([]),
    /** Catch-all: anything not otherwise routed goes to this transport. */
    defaultRoute: z.boolean().default(false),
    /**
     * The root services the far end is provisioned with (`managedIdentity`,
     * `grantedServiceId`, `connectionTokenBinder`). Only honored on `cmd-env`
     * endpoints (the only outbound transport that gets an overlay-root front
     * door); `connectionTokenBinder` is rejected on other endpoint kinds. Each
     * binder prefix (e.g. `"docker/"`) is matched against the requested value as
     * a literal string prefix — it grants an unbounded family, so scope it
     * narrowly. The token minted here is later redeemed by a peer on a listener
     * `{ token: "bound" }` handler.
     */
    ...provisionFields,
};

// ---- endpoints (outbound) -----------------------------------------------

/** Universal copy-paste form: a strict endpoint URI plus an optional token. */
const uriEndpoint = z.object({
    kind: z.literal('uri'),
    /** e.g. `wss://host/?…`, `unix:/run/hub.sock`, `npipe://./pipe/x`. */
    uri: z.string().min(1),
    token: z.string().optional(),
    ...routingFields,
});

/** A running WebSocket hub. */
const wsEndpoint = z.object({
    kind: z.literal('ws'),
    url: z.string().min(1),
    token: z.string().optional(),
    ...routingFields,
});

/** A named pipe / unix-domain socket the far end already listens on. */
const socketEndpoint = z.object({
    kind: z.literal('socket'),
    path: z.string().min(1),
    token: z.string().optional(),
    ...routingFields,
});

const commandFields = {
    /** Verbatim command line (run through the shell). Use this or `argv`. */
    cmd: z.string().optional(),
    /** Pre-split argv (no shell). Use this or `cmd`. */
    argv: z.array(z.string()).optional(),
    /** Extra environment variables for the spawned child. */
    env: z.record(z.string(), z.string()).optional(),
    /** Working directory for the spawned child. */
    cwd: z.string().optional(),
};

/** Spawn a child against a private hub socket; it dials back as a participant. */
const cmdEnvEndpoint = z.object({
    kind: z.literal('cmd-env'),
    ...commandFields,
    ...routingFields,
});

/** Spawn a child and talk hubrpc over its stdin/stdout. */
const cmdStdioEndpoint = z.object({
    kind: z.literal('cmd-stdio'),
    ...commandFields,
    ...routingFields,
});

/**
 * Outbound participant kinds that can be attached to an already-running Hub
 * without host-specific admission or identity provisioning.
 */
export const ParticipantConnectorConfigSchema = z.discriminatedUnion('kind', [
    uriEndpoint,
    wsEndpoint,
    socketEndpoint,
    cmdStdioEndpoint,
]);
export type ParticipantConnectorConfig = z.infer<typeof ParticipantConnectorConfigSchema>;

export const EndpointConfigSchema = z.discriminatedUnion('kind', [
    uriEndpoint,
    wsEndpoint,
    socketEndpoint,
    cmdEnvEndpoint,
    cmdStdioEndpoint,
]);
export type EndpointConfig = z.infer<typeof EndpointConfigSchema>;

// ---- listeners (inbound) ------------------------------------------------

/** Fields a listener shares regardless of transport type. */
const listenerCommon = {
    /**
     * Ordered connection handlers. Each accepted peer is admitted by the first
     * handler whose token check claims it (see {@link ConnectionHandlerSchema});
     * that handler also provisions the peer's root services. **Required** — an
     * empty array accepts no connection.
     */
    handlers: z.array(ConnectionHandlerSchema).default([]),
};

const websocketListener = z.object({
    type: z.literal('websocket'),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(7878),
    path: z.string().startsWith('/').default('/'),
    healthPath: z.string().startsWith('/').nullable().default('/healthz'),
    maxPayload: z.number().int().positive().default(16 * 1024 * 1024),
    /** Optional `Origin` allow-list for browser clients. */
    allowedOrigins: z.array(z.string()).default([]),
    ...listenerCommon,
});

const socketListener = z.object({
    type: z.literal('socket'),
    /** UDS path (posix) or named pipe (`\\.\pipe\…`, win32). */
    path: z.string().min(1),
    ...listenerCommon,
});

export const ListenerConfigSchema = z.discriminatedUnion('type', [
    websocketListener,
    socketListener,
]);
export type ListenerConfig = z.infer<typeof ListenerConfigSchema>;

// ---- forward checking ---------------------------------------------------

/**
 * Forward-checking policy for the hub's inbound listeners. When enabled, the
 * hub mints an admin signing identity, serves the signed
 * `hubServiceIdRegistry::registerServiceId` + `hubAccess` front doors, and gates
 * every forwarded (fully-qualified) call at each listener boundary:
 *
 * - `verifySignatures` — forwarded calls must carry a valid `$hubrpc`
 *   signature (authenticity).
 * - `requireCapability` — forwarded calls must additionally present a
 *   capability chain rooting at the hub admin (authorization). Granting
 *   capabilities is gated by the {@link HubAccessManifestHost} consent rendezvous.
 *
 * `true` is shorthand for both flags on; `false` disables forward checking
 * entirely (open hub, no consent surface).
 */
export const ForwardCheckingSchema = z.union([
    z.boolean(),
    z.object({
        verifySignatures: z.boolean().default(true),
        requireCapability: z.boolean().default(true),
    }),
]).default(true);
export type ForwardCheckingConfig = z.infer<typeof ForwardCheckingSchema>;

/**
 * Where the built-in terminal consent approver sources its pending requests
 * from. The approver consumes `hubAccessManifest::{getDesired,watchDesired,
 * setCurrent}` **over a connection** — never the in-process host object — so the
 * same loop works against a remote source unchanged.
 *
 * - `true` (default) — consume this hub's own manifest (served under
 *   {@link HubConfig.hubServiceId}). The common, local-operator case.
 * - `{ serviceId }` — consume the manifest served at `serviceId` (e.g. an
 *   upstream hub the operator approves on behalf of).
 * - `false` — install no built-in approver; rely entirely on external approvers
 *   (configured {@link HubConfig.rootPrincipalIds}) deciding via the manifest.
 *
 * The approver is only started when stdin is a TTY (it drives a terminal
 * prompt); a non-interactive hub is keyless regardless of this setting.
 */
export const ConsentApproverSchema = z.union([
    z.boolean(),
    z.object({ serviceId: z.string().min(1) }),
]).default(true);
export type ConsentApproverConfig = z.infer<typeof ConsentApproverSchema>;

// ---- top level ----------------------------------------------------------

export const HubConfigSchema = z.object({
    /**
     * Conventional pointer to a JSON Schema. Ignored at runtime; present so
     * editors validate against `--print-schema` output.
     */
    $schema: z.string().optional(),
    /**
     * The hub's own service id: the prefix under which it mounts its global
     * services (`hubAccess`, `hubrpc.directory`, reflection) and the target of
     * each overlay's `hubrpc.directory` referral. Defaults to `'hub'`.
     */
    hubServiceId: z.string().min(1).default('hub'),
    /** Inbound transports: accept many peers. */
    listeners: z.array(ListenerConfigSchema).default([]),
    /** Outbound transports: dial a single far end each. */
    endpoints: z.array(EndpointConfigSchema).default([]),
    /**
     * Sugar over {@link endpoints}: the map key becomes the entry's
     * `grantedServiceId` and its `managedIdentity.slot` (`endpoint:<name>`)
     * unless overridden.
     */
    namedEndpoints: z.record(z.string().min(1), EndpointConfigSchema).default({}),
    /**
     * Gate forwarded calls on inbound listeners. Defaults to `true`: signatures
     * are verified and a hub-admin-rooted capability is required, with consent
     * driven through the CLI consent prompt. Set `false` for an open hub.
     */
    forwardChecking: ForwardCheckingSchema,
    /**
     * Persistent identity slot used to mint the hub's admin signing identity
     * (the capability root) when {@link forwardChecking} is enabled. Stored
     * alongside other provisioned identities.
     */
    adminIdentitySlot: z.string().min(1).default('hub-admin'),
    /**
     * Additional capability root principal ids the forwarded-call gate trusts,
     * beyond the hub's own admin identity. Lets an external participant (e.g. a
     * dedicated access-granting service) mint capabilities the hub honors
     * without sharing the hub admin key. Only consulted when
     * {@link forwardChecking} requires a capability.
     */
    rootPrincipalIds: z.array(z.string().min(1)).default([]),
    /**
     * Source for the built-in terminal consent approver. See
     * {@link ConsentApproverSchema}. Defaults to `true` (this hub's own manifest).
     * Only takes effect when {@link forwardChecking} requires a capability and
     * stdin is interactive.
     */
    consentApprover: ConsentApproverSchema,
});
export type HubConfig = z.infer<typeof HubConfigSchema>;

/** Parse + validate an in-memory config object. Throws `ZodError` on failure. */
export function parseHubConfig(raw: unknown): HubConfig {
    return HubConfigSchema.parse(_applyNamedEndpointDefaults(raw));
}

/**
 * Apply `namedEndpoints` sugar before validation: each entry's key becomes its
 * `grantedServiceId` and its `managedIdentity.slot` (`endpoint:<name>`)
 * unless set. Done pre-parse so Zod's own defaults don't erase the
 * "was it omitted?" signal.
 */
function _applyNamedEndpointDefaults(raw: unknown): unknown {
    if (raw === null || typeof raw !== 'object') return raw;
    const r = raw as Record<string, unknown>;
    const named = r.namedEndpoints;
    if (named === null || typeof named !== 'object') return raw;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(named as Record<string, unknown>)) {
        if (value !== null && typeof value === 'object') {
            const v = value as Record<string, unknown>;
            out[key] = {
                ...v,
                grantedServiceId: v.grantedServiceId ?? key,
                managedIdentity: v.managedIdentity ?? { slot: `endpoint:${key}` },
            };
        } else {
            out[key] = value;
        }
    }
    return { ...r, namedEndpoints: out };
}

/** JSON-Schema for the config file (for `--print-schema` / editor tooling). */
export function hubConfigJsonSchema(): unknown {
    return z.toJSONSchema(HubConfigSchema, { target: 'draft-2020-12' });
}
