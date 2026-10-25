/**
 * Translates between a forwarded app's own origins (`http://localhost:<port>` on its machine) and
 * their exported names (`http://<port>.<service>.localhost` here), in both directions. The app's
 * Host, Origin, CORS, redirect, and cookie checks then see what a browser on its own machine would
 * produce, so forwarding neither adds nor removes protections.
 */
import type { Duplex } from 'node:stream';
import { formatHttpExportHost, parseHttpExportHost, type ServiceReference } from './hostname';

const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
const MAX_UPGRADE_RESPONSE_HEAD_BYTES = 64 * 1_024;

export interface ForwardTarget {
    readonly serviceId: string;
    readonly port: number;
    readonly baseDomain: string;
    /** The gateway port as the client addressed it, `:<port>`, or empty for port 80. */
    readonly gatewayPortSuffix: string;
}

export type ServiceResolver = (reference: ServiceReference) => Promise<string | undefined>;

export function gatewayPortSuffix(host: string | undefined): string {
    const port = /:(\d+)$/.exec(host ?? '')?.[1];
    return port && port !== '80' ? `:${port}` : '';
}

/**
 * Request headers as the target would receive them from a browser on its own machine.
 * `Host` names the target's loopback port; `Origin` and `Referer` from the same service's exported
 * names map back to its loopback origins. Origins of this machine's own loopback have no
 * counterpart on the target: `Origin` becomes `null` and `Referer` is dropped.
 */
export async function translateRequestHeaders(
    rawHeaders: readonly string[],
    target: ForwardTarget,
    resolve: ServiceResolver,
    options: { readonly keepUpgradeHeaders: boolean },
): Promise<string[]> {
    const headers: string[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index];
        const value = rawHeaders[index + 1];
        const lowerName = name.toLowerCase();
        if (!options.keepUpgradeHeaders && HOP_BY_HOP_HEADERS.has(lowerName)) {
            continue;
        }
        if (lowerName === 'host') {
            headers.push(name, loopbackHost(target.port));
        } else if (lowerName === 'origin') {
            headers.push(name, await toTargetUrl(value, target, resolve, false) ?? 'null');
        } else if (lowerName === 'referer') {
            const referer = await toTargetUrl(value, target, resolve, true);
            if (referer !== undefined) {
                headers.push(name, referer);
            }
        } else {
            headers.push(name, value);
        }
    }
    return headers;
}

/**
 * Response headers as a browser here should see them: redirects and CORS origins naming the
 * target machine's loopback map to their exported names, and cookies are scoped to the service's
 * exported ports, which is the set of hosts they reach on the target machine.
 */
export function translateResponseHeaders(
    rawHeaders: readonly string[],
    target: ForwardTarget,
    options: { readonly keepUpgradeHeaders: boolean },
): string[] {
    const headers: string[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index];
        let value = rawHeaders[index + 1];
        const lowerName = name.toLowerCase();
        if (!options.keepUpgradeHeaders && HOP_BY_HOP_HEADERS.has(lowerName)) {
            continue;
        }
        if (lowerName === 'location') {
            value = toExportedUrl(value, target, true);
        } else if (lowerName === 'access-control-allow-origin') {
            value = toExportedUrl(value, target, false);
        } else if (lowerName === 'set-cookie') {
            const cookie = translateCookie(value, target);
            if (cookie === undefined) {
                continue;
            }
            value = cookie;
        }
        headers.push(name, value);
    }
    return headers;
}

/** Copies an upgrade response (e.g. `101 Switching Protocols`) to the client, translating its head. */
export function relayUpgradeResponse(upstream: Duplex, client: Duplex, target: ForwardTarget): void {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        const headEnd = buffered.indexOf('\r\n\r\n');
        if (headEnd < 0) {
            if (buffered.length > MAX_UPGRADE_RESPONSE_HEAD_BYTES) {
                upstream.destroy(new Error('Upgrade response head is too large'));
            }
            return;
        }
        upstream.off('data', onData);
        const [statusLine, ...lines] = buffered.subarray(0, headEnd).toString('latin1').split('\r\n');
        const rawHeaders = lines.flatMap(line => {
            const separator = line.indexOf(':');
            return separator < 0 ? [] : [line.slice(0, separator), line.slice(separator + 1).trim()];
        });
        client.write(serializeHead(statusLine, translateResponseHeaders(rawHeaders, target, { keepUpgradeHeaders: true })));
        const rest = buffered.subarray(headEnd + 4);
        if (rest.length > 0) {
            client.write(rest);
        }
        upstream.pipe(client);
    };
    upstream.on('data', onData);
}

export function serializeHead(startLine: string, rawHeaders: readonly string[]): Buffer {
    const lines = [startLine];
    for (let index = 0; index < rawHeaders.length; index += 2) {
        lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
    }
    lines.push('', '');
    return Buffer.from(lines.join('\r\n'), 'latin1');
}

/** Maps an exported URL of the same service to the target's loopback; `undefined` if it has no counterpart there. */
async function toTargetUrl(value: string, target: ForwardTarget, resolve: ServiceResolver, keepPath: boolean): Promise<string | undefined> {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return value;
    }
    const parsed = url.protocol === 'http:' ? parseHttpExportHost(url.host, target.baseDomain) : undefined;
    if (parsed?.kind === 'service') {
        // Exported names are the same on every machine, so another service's name stays meaningful.
        const sameTarget = parsed.params.port !== undefined
            && (url.port ? `:${url.port}` : '') === target.gatewayPortSuffix
            && await resolve(parsed.service) === target.serviceId;
        if (!sameTarget) {
            return value;
        }
        const origin = `http://${loopbackHost(parsed.params.port!)}`;
        return keepPath ? `${origin}${url.pathname}${url.search}` : origin;
    }
    return isLoopbackHostname(url.hostname) ? undefined : value;
}

/** Maps a URL naming the target machine's loopback to the exported name of that port. */
function toExportedUrl(value: string, target: ForwardTarget, keepPath: boolean): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return value;
    }
    if (url.protocol !== 'http:' || !isTargetLoopbackHostname(url.hostname)) {
        return value;
    }
    const port = Number(url.port || 80);
    const origin = `http://${formatHttpExportHost({ serviceId: target.serviceId, params: { port } }, target.baseDomain)}${target.gatewayPortSuffix}`;
    return keepPath ? `${origin}${url.pathname}${url.search}${url.hash}` : origin;
}

/**
 * On its own machine, a cookie that is host-only or scoped to `localhost` reaches every port, so
 * here it is scoped to the service label, which covers all of the service's exported ports. A
 * browser there rejects other domains, so such cookies are dropped. `__Host-` cookies must stay
 * host-only and so remain limited to one exported port.
 */
function translateCookie(value: string, target: ForwardTarget): string | undefined {
    const [pair, ...attributes] = value.split(';');
    const kept = [pair.trim()];
    let domain: string | undefined;
    for (const attribute of attributes) {
        const separator = attribute.indexOf('=');
        const name = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
        if (name === 'domain') {
            domain = attribute.slice(separator + 1).trim().replace(/^\./, '').toLowerCase();
        } else if (attribute.trim()) {
            kept.push(attribute.trim());
        }
    }
    if (domain !== undefined && domain !== 'localhost') {
        return undefined;
    }
    if (!/^__host-/i.test(pair.trim())) {
        kept.push(`Domain=${formatHttpExportHost({ serviceId: target.serviceId, params: {} }, target.baseDomain)}`);
    }
    return kept.join('; ');
}

function loopbackHost(port: number): string {
    return port === 80 ? 'localhost' : `localhost:${port}`;
}

function isTargetLoopbackHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

function isLoopbackHostname(hostname: string): boolean {
    return isTargetLoopbackHostname(hostname) || hostname.endsWith('.localhost');
}
