import type { LinkRpcInterfaceSchema, IRequestSender, SigningCallCtx } from '@hediet/linkrpc';
import { generateTsInterface } from '@hediet/linkrpc';
import { type DiscoveredListing, fetchSchema, walkHubDetailed } from '@hediet/linkrpc-client';

interface ExploreCommonArgs {
    /** Exact directory-level filters, applied before browsing or searching. */
    readonly serviceId?: string;
    readonly interfaceId?: string;
    /** Include reflection plumbing such as `linkrpc.directory` and `linkrpc.schemas`. */
    readonly includeInternal?: boolean;
    /** Request one broad reflection grant when a gated directory is encountered. */
    readonly requestPermission?: boolean;
}

export interface ExploreBrowseArgs extends ExploreCommonArgs {
    readonly kind: 'browse';
    /** Number of interfaces to return. Defaults to 20; maximum 100. */
    readonly limit?: number;
    /** Opaque continuation cursor returned by a previous browse call. */
    readonly cursor?: string;
}

export interface ExploreGrepArgs extends ExploreCommonArgs {
    readonly kind: 'grep';
    /** Pattern searched against the generated `defineInterface` source, one line at a time. */
    readonly pattern: string;
    /** Defaults to `regex`. Both modes are case-insensitive. */
    readonly syntax?: 'regex' | 'literal';
    /** Number of matching virtual documents to return. Defaults to 20; maximum 100. */
    readonly limit?: number;
    /** Opaque continuation cursor returned by a previous grep call. */
    readonly cursor?: string;
    /** Source lines included before and after each match. Defaults to 1; maximum 5. */
    readonly contextLines?: number;
}

export interface ExploreInspectArgs extends ExploreCommonArgs {
    readonly kind: 'inspect';
    readonly serviceId: string;
    readonly interfaceId: string;
    /** Generated `defineInterface` source by default; use `schema` for the raw wire schema. */
    readonly format?: 'source' | 'schema';
}

export type ExploreArgs = ExploreBrowseArgs | ExploreGrepArgs | ExploreInspectArgs;

export interface ExploreDeps {
    requestReflectionAccess(): Promise<boolean>;
}

export interface ExploreListing {
    readonly serviceId: string;
    readonly serviceDescription?: string;
    readonly interfaceId: string;
    readonly interfaceHash: string;
    readonly documentId: string;
}

export interface ExploreGrepMatch {
    /** Matching source plus the requested surrounding context, joined with newlines. */
    readonly searchResult: string;
    /** Inclusive, 1-based line range of `searchResult` in the virtual document. */
    readonly lineRange: readonly [start: number, end: number];
    /** LinkRPC member containing every matched line in this chunk, when unambiguous. */
    readonly member?: string;
}

export interface ExploreGrepEntry extends ExploreListing {
    readonly matches: readonly ExploreGrepMatch[];
    /** True when this document contains more matches than were returned. */
    readonly matchesTruncated?: boolean;
}

export interface ExploreDocumentError {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly error: string;
}

export interface ExploreInaccessible {
    readonly serviceId: string;
    readonly reason: string;
    readonly hint: string;
}

export interface ExploreBrowseResult {
    readonly kind: 'browse';
    readonly total: number;
    readonly entries: readonly ExploreListing[];
    readonly nextCursor?: string;
    readonly inaccessible?: readonly ExploreInaccessible[];
}

export interface ExploreGrepResult {
    readonly kind: 'grep';
    readonly pattern: string;
    readonly syntax: 'regex' | 'literal';
    readonly total: number;
    readonly entries: readonly ExploreGrepEntry[];
    readonly nextCursor?: string;
    readonly documentErrors?: readonly ExploreDocumentError[];
    readonly inaccessible?: readonly ExploreInaccessible[];
}

export interface ExploreInspectResult extends ExploreListing {
    readonly kind: 'inspect';
    readonly format: 'source' | 'schema';
    readonly source?: string;
    readonly schema?: LinkRpcInterfaceSchema;
    readonly inaccessible?: readonly ExploreInaccessible[];
}

export type ExploreResult = ExploreBrowseResult | ExploreGrepResult | ExploreInspectResult;

interface CachedInterface {
    readonly schema: LinkRpcInterfaceSchema;
    readonly generatedSource: string;
}

interface VirtualDocument extends CachedInterface {
    readonly listing: DiscoveredListing;
    readonly source: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_MATCHES_PER_DOCUMENT = 20;
const interfaceCache = new WeakMap<object, Map<string, Promise<CachedInterface>>>();

/**
 * Browse the reflected directory, grep generated interface source, or inspect
 * one exact virtual document. Generated source is cached by the directory
 * route and interface hash; every call still walks the live directory.
 */
export async function explore(
    channel: IRequestSender<SigningCallCtx>,
    args: ExploreArgs,
    deps?: ExploreDeps,
): Promise<ExploreResult> {
    if (args === undefined || typeof args !== 'object' || !('kind' in args)) {
        throw new Error('explore requires `kind: "browse" | "grep" | "inspect"`.');
    }

    const unlockGatedDirectory = args.requestPermission === true && deps !== undefined
        ? (_serviceId: string) => deps.requestReflectionAccess()
        : undefined;
    const walked = await walkHubDetailed(channel, { unlockGatedDirectory });
    const listings = _filterAndSort(walked.listings, args);
    const inaccessible = _inaccessible(walked.inaccessible);

    switch (args.kind) {
        case 'browse': {
            const page = _page(listings, args.limit, args.cursor);
            return {
                kind: 'browse',
                total: listings.length,
                entries: page.items.map(_toListing),
                ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
                ...(inaccessible !== undefined ? { inaccessible } : {}),
            };
        }
        case 'grep': {
            if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
                throw new Error('explore grep requires a non-empty `pattern`.');
            }
            const syntax = args.syntax ?? 'regex';
            const matchesLine = _createLineMatcher(args.pattern, syntax);
            const contextLines = _boundedInteger(args.contextLines ?? 1, 0, 5, 'contextLines');
            const loaded = await Promise.all(listings.map(async (listing) => {
                try {
                    return { document: await _loadDocument(channel, listing) };
                } catch (error) {
                    return {
                        error: {
                            serviceId: listing.serviceId,
                            interfaceId: listing.interfaceId,
                            error: (error as Error).message,
                        },
                    };
                }
            }));
            const entries: ExploreGrepEntry[] = [];
            const documentErrors: ExploreDocumentError[] = [];
            for (const item of loaded) {
                if (item.error !== undefined) {
                    documentErrors.push(item.error);
                    continue;
                }
                const document = item.document!;
                const matches = _grepDocument(document, matchesLine, contextLines);
                if (matches.length === 0) continue;
                entries.push({
                    ..._toListing(document.listing),
                    matches: matches.slice(0, MAX_MATCHES_PER_DOCUMENT),
                    ...(matches.length > MAX_MATCHES_PER_DOCUMENT ? { matchesTruncated: true } : {}),
                });
            }
            const page = _page(entries, args.limit, args.cursor);
            return {
                kind: 'grep',
                pattern: args.pattern,
                syntax,
                total: entries.length,
                entries: page.items,
                ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
                ...(documentErrors.length > 0 ? { documentErrors } : {}),
                ...(inaccessible !== undefined ? { inaccessible } : {}),
            };
        }
        case 'inspect': {
            const listing = listings.find((item) =>
                item.serviceId === args.serviceId && item.interfaceId === args.interfaceId,
            );
            if (listing === undefined) {
                throw new Error(
                    `Interface not found: ${args.serviceId}::${args.interfaceId}. `
                    + 'Browse first, or set `requestPermission: true` if its directory is gated.',
                );
            }
            const document = await _loadDocument(channel, listing);
            const format = args.format ?? 'source';
            return {
                kind: 'inspect',
                format,
                ..._toListing(listing),
                ...(format === 'source' ? { source: document.source } : { schema: document.schema }),
                ...(inaccessible !== undefined ? { inaccessible } : {}),
            };
        }
        default:
            throw new Error(`Unknown explore kind: ${String((args as { kind?: unknown }).kind)}`);
    }
}

function _filterAndSort(
    listings: readonly DiscoveredListing[],
    args: ExploreArgs,
): DiscoveredListing[] {
    const includeInternal = args.includeInternal === true
        || (args.interfaceId !== undefined && _isHubrpcInternalInterface(args.interfaceId));
    return listings
        .filter((listing) => {
            if (args.serviceId !== undefined && listing.serviceId !== args.serviceId) return false;
            if (args.interfaceId !== undefined && listing.interfaceId !== args.interfaceId) return false;
            return includeInternal || !_isHubrpcInternalInterface(listing.interfaceId);
        })
        .sort((a, b) =>
            a.serviceId.localeCompare(b.serviceId)
            || a.interfaceId.localeCompare(b.interfaceId)
            || a.hash.localeCompare(b.hash),
        );
}

function _toListing(listing: DiscoveredListing): ExploreListing {
    return {
        serviceId: listing.serviceId,
        ...(listing.serviceDescription !== undefined
            ? { serviceDescription: listing.serviceDescription }
            : {}),
        interfaceId: listing.interfaceId,
        interfaceHash: listing.hash,
        documentId: _documentId(listing),
    };
}

async function _loadDocument(
    channel: IRequestSender<SigningCallCtx>,
    listing: DiscoveredListing,
): Promise<VirtualDocument> {
    let cache = interfaceCache.get(channel as object);
    if (cache === undefined) {
        cache = new Map();
        interfaceCache.set(channel as object, cache);
    }
    const cacheKey = `${listing.discoveredFrom}\u0000${listing.interfaceId}\u0000${listing.hash}`;
    let pending = cache.get(cacheKey);
    if (pending === undefined) {
        pending = (async () => {
            const target = listing.discoveredFrom || listing.serviceId || undefined;
            const schema = await fetchSchema(channel, listing.interfaceId, listing.hash, target);
            return { schema, generatedSource: generateTsInterface(schema) };
        })();
        cache.set(cacheKey, pending);
    }

    let cached: CachedInterface;
    try {
        cached = await pending;
    } catch (error) {
        if (cache.get(cacheKey) === pending) cache.delete(cacheKey);
        throw error;
    }
    const documentId = _documentId(listing);
    return {
        ...cached,
        listing,
        source: `${_documentHeader(listing, documentId)}\n${cached.generatedSource}`,
    };
}

function _documentHeader(listing: DiscoveredListing, documentId: string): string {
    return [
        `// virtualDocument: ${JSON.stringify(documentId)}`,
        `// serviceId: ${JSON.stringify(listing.serviceId)}`,
        ...(listing.serviceDescription !== undefined
            ? [`// serviceDescription: ${JSON.stringify(listing.serviceDescription)}`]
            : []),
        `// interfaceId: ${JSON.stringify(listing.interfaceId)}`,
        `// interfaceHash: ${JSON.stringify(listing.hash)}`,
        `// discoveredFrom: ${JSON.stringify(listing.discoveredFrom)}`,
    ].join('\n');
}

function _documentId(listing: DiscoveredListing): string {
    const service = listing.serviceId === '' ? '$root' : encodeURIComponent(listing.serviceId);
    const interfaceId = encodeURIComponent(listing.interfaceId);
    return `linkrpc://${service}/${interfaceId}@${listing.hash}.ts`;
}

function _grepDocument(
    document: VirtualDocument,
    matchesLine: (line: string) => boolean,
    contextLines: number,
): ExploreGrepMatch[] {
    const lines = document.source.split('\n');
    const memberAtLine = _memberMap(lines, document.schema);
    const ranges: Array<{ start: number; end: number; matches: number[] }> = [];
    for (let index = 0; index < lines.length; index++) {
        if (!matchesLine(lines[index])) continue;
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length, index + contextLines + 1);
        const previous = ranges.at(-1);
        if (previous !== undefined && start <= previous.end) {
            previous.end = Math.max(previous.end, end);
            previous.matches.push(index);
        } else {
            ranges.push({ start, end, matches: [index] });
        }
    }
    return ranges.map((range) => {
        const members = new Set(range.matches.map((line) => memberAtLine[line]));
        const member = members.size === 1 ? members.values().next().value : undefined;
        return {
            searchResult: lines.slice(range.start, range.end).join('\n'),
            lineRange: [range.start + 1, range.end],
            ...(member !== undefined ? { member } : {}),
        };
    });
}

function _memberMap(lines: readonly string[], schema: LinkRpcInterfaceSchema): Array<string | undefined> {
    const starts: Array<{ line: number; member: string }> = [];
    let searchFrom = 0;
    for (const methodName of Object.keys(schema.methods)) {
        const barePrefix = `${methodName}: `;
        const quotedPrefix = `${JSON.stringify(methodName)}: `;
        const line = lines.findIndex((value, index) => index >= searchFrom
            && (value.trimStart().startsWith(barePrefix) || value.trimStart().startsWith(quotedPrefix))
            && (value.includes('requestType(') || value.includes('notificationType(')));
        if (line >= 0) {
            starts.push({ line, member: methodName });
            searchFrom = line + 1;
        }
    }

    const result = new Array<string | undefined>(lines.length);
    for (let i = 0; i < starts.length; i++) {
        const end = starts[i + 1]?.line ?? lines.length;
        for (let line = starts[i].line; line < end; line++) result[line] = starts[i].member;
    }
    return result;
}

function _createLineMatcher(
    pattern: string,
    syntax: 'regex' | 'literal',
): (line: string) => boolean {
    if (syntax === 'literal') {
        const needle = pattern.toLocaleLowerCase();
        return (line) => line.toLocaleLowerCase().includes(needle);
    }
    if (syntax !== 'regex') throw new Error(`Unknown grep syntax: ${String(syntax)}`);
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, 'iu');
    } catch (error) {
        throw new Error(`Invalid grep regular expression: ${(error as Error).message}`);
    }
    return (line) => regex.test(line);
}

function _page<T>(
    items: readonly T[],
    requestedLimit: number | undefined,
    cursor: string | undefined,
): { items: readonly T[]; nextCursor?: string } {
    const limit = _boundedInteger(requestedLimit ?? DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
    const offset = _decodeCursor(cursor);
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
        items: page,
        ...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
    };
}

function _decodeCursor(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    if (!/^\d+$/.test(cursor)) throw new Error('Invalid explore cursor.');
    return Number(cursor);
}

function _boundedInteger(value: number, min: number, max: number, name: string): number {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`explore ${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
}

function _inaccessible(
    directories: readonly { serviceId: string; reason: string }[],
): ExploreInaccessible[] | undefined {
    if (directories.length === 0) return undefined;
    return directories.map((directory) => ({
        serviceId: directory.serviceId,
        reason: directory.reason,
        hint: 'Repeat this explore call with `requestPermission: true` to search all gated directories.',
    }));
}

function _isHubrpcInternalInterface(interfaceId: string): boolean {
    return interfaceId.startsWith('linkrpc.');
}
