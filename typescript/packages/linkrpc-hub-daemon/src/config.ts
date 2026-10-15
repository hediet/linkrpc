import { type HubConfig, hubConfigJsonSchema, parseHubConfig } from '@hediet/linkrpc-hub';
import * as jsonc from 'jsonc-parser';
import { z } from 'zod';

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A process the daemon starts, supervises, and connects to the hub. */
export const ManagedServiceSchema = z.object({
    description: z.string().optional(),
    /** Executable and arguments (no shell). `.cmd`/`.bat` shims work on Windows. */
    command: z.array(z.string().min(1)).min(1),
    /** Extra environment. `LINKRPC_ENDPOINT`/`LINKRPC_TOKEN` are always provided. */
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    /** `false` keeps the service configured but stopped. */
    enabled: z.boolean().default(true),
    restart: z.enum(['always', 'on-failure', 'never']).default('on-failure'),
    /**
     * When the service counts as running: after it connects to the hub
     * (`connected`, for LinkRPC services) or as soon as it spawned.
     */
    readiness: z.enum(['connected', 'spawned']).default('connected'),
    /** Namespace the service may claim on the hub. Defaults to its name. */
    serviceId: z.string().min(1).optional(),
    /** Provision a persistent managed identity (slot `service:<name>`). */
    managedIdentity: z.boolean().default(true),
    /** A `connected` service that does not connect in time is restarted. */
    startTimeoutMs: z.number().int().positive().default(30_000),
    /** Grace period after disconnecting (and SIGTERM on POSIX) before killing the process tree. */
    stopTimeoutMs: z.number().int().positive().default(5_000),
}).strict();

export type ManagedService = z.output<typeof ManagedServiceSchema> & { readonly serviceId: string; };

const ServicesSchema = z.record(
    z.string().regex(SERVICE_NAME, 'service names use letters, digits, ".", "_", and "-"'),
    ManagedServiceSchema,
).default({});

/** The daemon config file: a hub config plus supervised `services`. */
export interface DaemonConfig {
    readonly hub: HubConfig;
    readonly services: Readonly<Record<string, ManagedService>>;
}

/**
 * Parse a config file's text. Comments and trailing commas are allowed.
 * Throws a readable error on invalid input.
 */
export function parseDaemonConfigText(text: string): DaemonConfig {
    if (text.trim() === '') return parseDaemonConfig({});
    const errors: jsonc.ParseError[] = [];
    const raw: unknown = jsonc.parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
        const first = errors[0]!;
        const { line, column } = _position(text, first.offset);
        throw new Error(`invalid JSON at ${line}:${column}: ${jsonc.printParseErrorCode(first.error)}`);
    }
    return parseDaemonConfig(raw);
}

/**
 * Validate a parsed config. Unlike a standalone hub, the per-user hub defaults
 * to `forwardChecking: false`: the OS user is the trust boundary of its
 * private endpoints.
 */
export function parseDaemonConfig(raw: unknown): DaemonConfig {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('config must be a JSON object');
    }
    const record = raw as Record<string, unknown>;
    let hub: HubConfig;
    let parsedServices: Record<string, z.output<typeof ManagedServiceSchema>>;
    try {
        const { $schema: _editorSchema, ...hubFields } = parseHubConfig({ ...record, forwardChecking: record.forwardChecking ?? false });
        hub = hubFields;
        parsedServices = ServicesSchema.parse(record.services);
    } catch (error) {
        if (error instanceof z.ZodError) throw new Error(z.prettifyError(error));
        throw error;
    }
    const services: Record<string, ManagedService> = {};
    const owners = new Map<string, string>();
    for (const [name, service] of Object.entries(parsedServices)) {
        const serviceId = service.serviceId ?? name;
        const owner = owners.get(serviceId);
        if (owner !== undefined) {
            throw new Error(`services '${owner}' and '${name}' both claim serviceId '${serviceId}'`);
        }
        owners.set(serviceId, name);
        services[name] = { ...service, serviceId };
    }
    return { hub, services };
}

/** How applying `next` over a running `previous` service must proceed. */
export type ServiceChange = 'none' | 'inPlace' | 'restart';

const IN_PLACE_FIELDS = ['description', 'enabled', 'restart', 'startTimeoutMs', 'stopTimeoutMs'] as const;

export function classifyServiceChange(previous: ManagedService, next: ManagedService): ServiceChange {
    if (stableKey(_withoutInPlaceFields(previous)) !== stableKey(_withoutInPlaceFields(next))) return 'restart';
    return stableKey(previous) === stableKey(next) ? 'none' : 'inPlace';
}

/** A canonical serialization: equal for semantically equal JSON values. */
export function stableKey(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) => {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
        return Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
                .filter(([, entry]) => entry !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
    });
}

/**
 * Persistently enable or disable `name` with a minimal text edit, keeping the
 * file's comments and formatting. Enabling removes the key (the default).
 */
export function setServiceEnabledInText(text: string, name: string, enabled: boolean): string {
    const config = parseDaemonConfigText(text);
    if (!(name in config.services)) throw new Error(`unknown service '${name}'`);
    const edits = jsonc.modify(text, ['services', name, 'enabled'], enabled ? undefined : false, {
        formattingOptions: { insertSpaces: true, tabSize: 4, eol: text.includes('\r\n') ? '\r\n' : '\n' },
    });
    return jsonc.applyEdits(text, edits);
}

/** JSON Schema of the config file, for editor validation. */
export function daemonConfigJsonSchema(): unknown {
    const hubSchema = hubConfigJsonSchema() as { properties?: Record<string, Record<string, unknown>>; };
    const servicesSchema = z.toJSONSchema(
        z.object({ services: ServicesSchema }),
        { target: 'draft-2020-12', io: 'input' },
    ) as { properties: Record<string, unknown>; };
    const forwardChecking = hubSchema.properties?.forwardChecking;
    return {
        ...hubSchema,
        properties: {
            ...hubSchema.properties,
            ...(forwardChecking ? { forwardChecking: { ...forwardChecking, default: false } } : {}),
            services: servicesSchema.properties.services,
        },
    };
}

/** The config written on first start. */
export const DEFAULT_CONFIG_TEXT = `{
    "$schema": "./config.schema.json",
    // Services the hub starts at login and keeps running. Each service gets
    // LINKRPC_ENDPOINT and LINKRPC_TOKEN and may claim the service ID named
    // after it. Saving this file applies changes; only changed services restart.
    "services": {
        // "example": {
        //     "command": ["node", "/path/to/service.js"],
        //     "env": { "LOG_LEVEL": "info" }
        // }
    }
}
`;

function _withoutInPlaceFields(service: ManagedService): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...service };
    for (const field of IN_PLACE_FIELDS) delete copy[field];
    return copy;
}

function _position(text: string, offset: number): { line: number; column: number; } {
    const before = text.slice(0, offset).split('\n');
    return { line: before.length, column: before[before.length - 1]!.length + 1 };
}
