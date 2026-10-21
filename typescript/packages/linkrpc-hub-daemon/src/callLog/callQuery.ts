/**
 * The call-log query language, shared by the daemon (which filters) and UIs
 * (which build terms). Dependency-free so sandboxed renderers can bundle it.
 *
 * A query is a list of space-separated terms that must all match:
 * - `text`: case-insensitive substring of the method, caller, target,
 *   principal, or error message. Quote terms with spaces: `"no route"`.
 * - `method:<glob>`: matches `service::interface::member` (the service is
 *   empty for root-form calls); `*` matches any characters.
 * - `service:<name>`: the call came from or went to that configured daemon
 *   service (e.g. `service:devtunnel`); case-insensitive, no wildcards.
 * - `-<term>` negates a term, e.g. `-method:hediet/devbox::*`.
 */
import type { CallRecord } from './callRecord';

/** A call's method split at its parts. */
export interface CallTarget {
    /** Absent for root-form calls (`interface::member`). */
    readonly serviceId: string | undefined;
    readonly interfaceId: string | undefined;
    readonly member: string;
}

export function callTargetOf(record: Pick<CallRecord, 'method' | 'serviceId'>): CallTarget {
    const { serviceId } = record;
    const rest = serviceId !== undefined && record.method.startsWith(`${serviceId}::`)
        ? record.method.slice(serviceId.length + 2)
        : record.method.replace(/^::/, '');
    const separator = rest.lastIndexOf('::');
    return separator < 0
        ? { serviceId, interfaceId: undefined, member: rest }
        : { serviceId, interfaceId: rest.slice(0, separator), member: rest.slice(separator + 2) };
}

/**
 * A `method:` glob for the given parts; omitted parts match anything, e.g.
 * `{ serviceId: 'a' }` → `a::*`, `{ interfaceId: 'i', member: 'm' }` → `*::i::m`.
 */
export function methodPattern(target: Partial<CallTarget>): string {
    const parts = [target.serviceId ?? '*', target.interfaceId ?? '*', target.member ?? '*'];
    while (parts.length > 1 && parts.at(-1) === '*' && parts.at(-2) === '*') parts.pop();
    return parts.join('::');
}

/** The term that excludes calls matching `methodPattern(target)`. */
export function excludeMethodTerm(target: Partial<CallTarget>): string {
    return `-method:${methodPattern(target)}`;
}

/** The term that limits the log to calls through a configured daemon service. */
export function serviceTerm(name: string): string {
    return `service:${name}`;
}

interface Term {
    readonly negated: boolean;
    readonly test: (record: CallRecord) => boolean;
}

const TERM = /(-?)(?:(method|service):)?("[^"]*"?|\S+)/g;

export class CallQuery {
    public static parse(text: string): CallQuery {
        const terms: Term[] = [];
        for (const [, negation, qualifier, raw] of text.matchAll(TERM)) {
            const value = _unquote(raw!);
            if (value === '') continue;
            terms.push({
                negated: negation === '-',
                test: qualifier === 'method' ? _methodTest(value)
                    : qualifier === 'service' ? _serviceTest(value.toLowerCase())
                        : _textTest(value.toLowerCase()),
            });
        }
        return new CallQuery(terms);
    }

    /** `text` with `term` appended, unless an equal term is already present. */
    public static appendTerm(text: string, term: string): string {
        const existing = [...text.matchAll(TERM)].map(match => match[0]);
        return existing.includes(term) ? text : [text.trim(), term].filter(part => part !== '').join(' ');
    }

    private constructor(private readonly _terms: readonly Term[]) { }

    public matches(record: CallRecord): boolean {
        return this._terms.every(term => term.test(record) !== term.negated);
    }
}

function _textTest(needle: string): (record: CallRecord) => boolean {
    return record => [record.method, record.from.label, record.to?.label, record.principal, record.error?.message]
        .some(value => value?.toLowerCase().includes(needle));
}

function _serviceTest(name: string): (record: CallRecord) => boolean {
    return record => [record.from.service, record.to?.service].some(service => service?.toLowerCase() === name);
}

function _methodTest(glob: string): (record: CallRecord) => boolean {
    const escaped = glob.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    const pattern = new RegExp(`^${escaped}$`, 'i');
    return record => {
        const { serviceId, interfaceId, member } = callTargetOf(record);
        return pattern.test([serviceId ?? '', interfaceId ?? '', member].join('::'));
    };
}

function _unquote(raw: string): string {
    return raw.startsWith('"') ? raw.slice(1, raw.endsWith('"') && raw.length > 1 ? -1 : undefined) : raw;
}
