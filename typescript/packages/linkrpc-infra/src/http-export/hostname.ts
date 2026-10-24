/**
 * Maps Hub service IDs and inline parameters to and from `*.localhost` hostnames.
 *
 * Readable form: `[<params>.]<reversed service segments>.localhost`, e.g.
 * `3000.compute.tablet.hediet.localhost` is service `hediet/tablet/compute` with
 * port 3000. The parameters label starts with the port and may add named
 * parameters: `3000--path-api`. A service ID whose segments are not plain DNS
 * labels, or that would exceed DNS length limits, is written as one hashed label
 * instead, `<slug>--h<hash>`, which is resolved against the known services.
 */
import { createHash } from 'node:crypto';

export const HTTP_EXPORT_BASE_DOMAIN = 'localhost';
const MAX_LABEL_LENGTH = 63;
const MAX_HOSTNAME_LENGTH = 253;
const HASH_LENGTH = 12;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const READABLE_SEGMENT = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
const PARAM_KEY = /^[a-z][a-z0-9]*$/;
const PARAM_VALUE = /^[a-z0-9]+$/;
const HASHED_LABEL = /^(?<slug>[a-z](?:[a-z0-9-]*[a-z0-9])?)--h(?<hash>[a-f0-9]{12})$/;

export interface HttpExportParams {
    readonly port?: number;
    /** Additional named parameters; keys and values are `[a-z0-9]`. */
    readonly named?: Readonly<Record<string, string>>;
}

export interface HttpExportTarget {
    readonly serviceId: string;
    readonly params: HttpExportParams;
}

export type ServiceReference =
    | { readonly kind: 'readable'; readonly serviceId: string }
    | { readonly kind: 'hashed'; readonly slug: string; readonly hash: string };

export type ParsedHttpExportHost =
    | { readonly kind: 'index' }
    | { readonly kind: 'service'; readonly service: ServiceReference; readonly params: HttpExportParams };

export function formatHttpExportHost(target: HttpExportTarget, baseDomain = HTTP_EXPORT_BASE_DOMAIN): string {
    const paramsLabel = formatParams(target.params);
    const prefix = paramsLabel ? [paramsLabel] : [];
    const readable = [...prefix, ...target.serviceId.split('/').reverse(), baseDomain];
    if (isReadableServiceId(target.serviceId) && fitsDns(readable)) {
        return readable.join('.');
    }
    return [...prefix, hashedServiceLabel(target.serviceId), baseDomain].join('.');
}

export function parseHttpExportHost(host: string, baseDomain = HTTP_EXPORT_BASE_DOMAIN): ParsedHttpExportHost | undefined {
    const hostname = stripPort(host).toLowerCase().replace(/\.$/, '');
    if (hostname === baseDomain) {
        return { kind: 'index' };
    }
    const suffix = `.${baseDomain}`;
    if (!hostname.endsWith(suffix)) {
        return undefined;
    }
    const labels = hostname.slice(0, -suffix.length).split('.');
    if (labels.some(label => !LABEL.test(label))) {
        return undefined;
    }
    let params: HttpExportParams = {};
    let serviceLabels = labels;
    if (/^[0-9]/.test(labels[0])) {
        const parsed = parseParams(labels[0]);
        if (!parsed || labels.length < 2) {
            return undefined;
        }
        params = parsed;
        serviceLabels = labels.slice(1);
    }
    if (serviceLabels.length === 1) {
        const hashed = HASHED_LABEL.exec(serviceLabels[0]);
        if (hashed?.groups) {
            return { kind: 'service', service: { kind: 'hashed', slug: hashed.groups.slug, hash: hashed.groups.hash }, params };
        }
    }
    if (!serviceLabels.every(label => READABLE_SEGMENT.test(label) && !label.includes('--'))) {
        return undefined;
    }
    return { kind: 'service', service: { kind: 'readable', serviceId: [...serviceLabels].reverse().join('/') }, params };
}

/** Resolves a reference against the reachable services; readable references resolve to themselves. */
export function resolveServiceReference(reference: ServiceReference, serviceIds: Iterable<string>): string | undefined {
    if (reference.kind === 'readable') {
        return reference.serviceId;
    }
    for (const serviceId of serviceIds) {
        if (serviceHash(serviceId) === reference.hash && hashedServiceLabel(serviceId).startsWith(`${reference.slug}--`)) {
            return serviceId;
        }
    }
    return undefined;
}

function isReadableServiceId(serviceId: string): boolean {
    return serviceId.split('/').every(segment => READABLE_SEGMENT.test(segment) && !segment.includes('--'));
}

function fitsDns(labels: readonly string[]): boolean {
    return labels.every(label => label.length <= MAX_LABEL_LENGTH) && labels.join('.').length <= MAX_HOSTNAME_LENGTH;
}

function hashedServiceLabel(serviceId: string): string {
    const suffix = `--h${serviceHash(serviceId)}`;
    let slug = serviceId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z]/.test(slug)) {
        slug = `s-${slug}`.replace(/-+$/, '');
    }
    return `${slug.slice(0, MAX_LABEL_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
}

function serviceHash(serviceId: string): string {
    return createHash('sha256').update(serviceId).digest('hex').slice(0, HASH_LENGTH);
}

function formatParams(params: HttpExportParams): string | undefined {
    const named = Object.entries(params.named ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (params.port === undefined) {
        if (named.length > 0) {
            throw new Error('Named parameters require a port.');
        }
        return undefined;
    }
    assertPort(params.port);
    for (const [key, value] of named) {
        if (!PARAM_KEY.test(key) || !PARAM_VALUE.test(value)) {
            throw new Error(`Parameter '${key}' cannot be encoded in a hostname; keys and values must be [a-z0-9].`);
        }
    }
    const label = [String(params.port), ...named.map(([key, value]) => `${key}-${value}`)].join('--');
    if (label.length > MAX_LABEL_LENGTH) {
        throw new Error('Parameters do not fit in one DNS label.');
    }
    return label;
}

function parseParams(label: string): HttpExportParams | undefined {
    const [portPart, ...namedParts] = label.split('--');
    if (!/^[1-9][0-9]{0,4}$/.test(portPart) || Number(portPart) > 65_535) {
        return undefined;
    }
    const named: Record<string, string> = {};
    for (const part of namedParts) {
        const match = /^(?<key>[a-z][a-z0-9]*)-(?<value>[a-z0-9]+)$/.exec(part);
        if (!match?.groups || Object.hasOwn(named, match.groups.key)) {
            return undefined;
        }
        named[match.groups.key] = match.groups.value;
    }
    return namedParts.length > 0 ? { port: Number(portPart), named } : { port: Number(portPart) };
}

function assertPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid TCP port '${port}'.`);
    }
}

function stripPort(host: string): string {
    const trimmed = host.trim();
    return trimmed.startsWith('[') ? trimmed.slice(1, trimmed.indexOf(']')) : trimmed.replace(/:\d+$/, '');
}
