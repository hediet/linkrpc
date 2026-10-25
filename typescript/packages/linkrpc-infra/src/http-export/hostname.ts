/**
 * Maps Hub service IDs and ports to and from `*.localhost` hostnames.
 *
 * Form: `[<port>.]<service label>.localhost`, e.g. `3000.hediet--tablet--compute.localhost`
 * is port 3000 of service `hediet/tablet/compute`. The service is always exactly one label
 * directly below `localhost`, a public suffix, so browsers treat every service as its own
 * site, while its ports share that site like the ports of `localhost` do on the service's
 * own machine. Segments are joined with `--`, which plain segments cannot contain. A service
 * ID that cannot be written that way, or whose label would exceed 63 characters, is written
 * as a hashed label instead, `<slug>--h<hash>`, which is resolved against the known services.
 */
import { createHash } from 'node:crypto';

export const HTTP_EXPORT_BASE_DOMAIN = 'localhost';
const MAX_LABEL_LENGTH = 63;
const HASH_LENGTH = 12;
const SEGMENT_SEPARATOR = '--';
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const READABLE_SEGMENT = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
const PORT_LABEL = /^[1-9][0-9]{0,4}$/;
const HASHED_LABEL = /^(?<slug>[a-z](?:[a-z0-9-]*[a-z0-9])?)--h(?<hash>[a-f0-9]{12})$/;

export interface HttpExportParams {
    readonly port?: number;
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
    const labels = [serviceLabel(target.serviceId), baseDomain];
    if (target.params.port !== undefined) {
        assertPort(target.params.port);
        labels.unshift(String(target.params.port));
    }
    return labels.join('.');
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
    if (labels.length > 2 || labels.some(label => !LABEL.test(label))) {
        return undefined;
    }
    let params: HttpExportParams = {};
    if (labels.length === 2) {
        if (!PORT_LABEL.test(labels[0]) || Number(labels[0]) > 65_535) {
            return undefined;
        }
        params = { port: Number(labels[0]) };
    }
    const label = labels[labels.length - 1];
    const hashed = HASHED_LABEL.exec(label);
    if (hashed?.groups) {
        return { kind: 'service', service: { kind: 'hashed', slug: hashed.groups.slug, hash: hashed.groups.hash }, params };
    }
    const segments = label.split(SEGMENT_SEPARATOR);
    if (!segments.every(segment => READABLE_SEGMENT.test(segment))) {
        return undefined;
    }
    return { kind: 'service', service: { kind: 'readable', serviceId: segments.join('/') }, params };
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

function serviceLabel(serviceId: string): string {
    const segments = serviceId.split('/');
    const readable = segments.join(SEGMENT_SEPARATOR);
    const isReadable = segments.every(segment => READABLE_SEGMENT.test(segment) && !segment.includes(SEGMENT_SEPARATOR))
        && readable.length <= MAX_LABEL_LENGTH
        && !HASHED_LABEL.test(readable)
        // `--` at positions 3-4 is reserved for IDNA labels such as `xn--`.
        && readable.slice(2, 4) !== SEGMENT_SEPARATOR;
    return isReadable ? readable : hashedServiceLabel(serviceId);
}

function hashedServiceLabel(serviceId: string): string {
    const suffix = `--h${serviceHash(serviceId)}`;
    let slug = serviceId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z]/.test(slug) || slug.length === 2) {
        slug = `s-${slug}`.replace(/-+$/, '');
    }
    return `${slug.slice(0, MAX_LABEL_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
}

function serviceHash(serviceId: string): string {
    return createHash('sha256').update(serviceId).digest('hex').slice(0, HASH_LENGTH);
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
