import type { CliChannel } from "@hediet/linkrpc-client-internal";
import type { ExploreGrepArgs, ExploreGrepEntry, ExploreGrepResult } from "@hediet/linkrpc-mcp";
import { formatJson } from "../output";

export interface GrepOptions {
    readonly pattern: string;
    readonly literal: boolean;
    readonly contextLines: number;
    readonly serviceId?: string;
    readonly interfaceId?: string;
    readonly includeInternal: boolean;
    /** Maximum number of matching interfaces; all of them when absent. */
    readonly limit?: number;
    readonly json: boolean;
}

export interface GrepOutput {
    /** Empty when nothing matched. */
    readonly stdout: string;
    readonly warnings: readonly string[];
    readonly matched: boolean;
}

/**
 * Search the generated `defineInterface` source of every reachable interface,
 * with the same semantics as the MCP server's `explore({ kind: "grep" })`.
 */
export async function grepCommand(channel: CliChannel, opts: GrepOptions): Promise<GrepOutput> {
    const { explore, createGrepLineMatcher } = await import("@hediet/linkrpc-mcp");
    const args: ExploreGrepArgs = {
        kind: "grep",
        pattern: opts.pattern,
        syntax: opts.literal ? "literal" : "regex",
        contextLines: opts.contextLines,
        includeInternal: opts.includeInternal,
        ...(opts.serviceId !== undefined ? { serviceId: opts.serviceId } : {}),
        ...(opts.interfaceId !== undefined ? { interfaceId: opts.interfaceId } : {}),
    };

    const entries: ExploreGrepEntry[] = [];
    let cursor: string | undefined;
    let last: ExploreGrepResult;
    do {
        const remaining = opts.limit === undefined ? MAX_PAGE_SIZE : opts.limit - entries.length;
        const result = await explore(channel, {
            ...args,
            limit: Math.min(remaining, MAX_PAGE_SIZE),
            ...(cursor !== undefined ? { cursor } : {}),
        });
        if (result.kind !== "grep") throw new Error(`Unexpected explore result kind: ${result.kind}`);
        last = result;
        entries.push(...result.entries);
        cursor = result.nextCursor;
    } while (cursor !== undefined && (opts.limit === undefined || entries.length < opts.limit));

    const { nextCursor: _nextCursor, ...rest } = last;
    const result: ExploreGrepResult = { ...rest, entries };
    const warnings = _warnings(result);
    if (opts.json) return { stdout: formatJson(result), warnings, matched: entries.length > 0 };

    const matchesLine = createGrepLineMatcher(result.pattern, result.syntax);
    return {
        stdout: entries.map((entry) => _renderEntry(entry, matchesLine)).join("\n\n"),
        warnings,
        matched: entries.length > 0,
    };
}

/** The maximum page size `explore` accepts. */
const MAX_PAGE_SIZE = 100;

function _renderEntry(entry: ExploreGrepEntry, matchesLine: (line: string) => boolean): string {
    const ref = entry.serviceId === "" ? entry.interfaceId : `${entry.serviceId}::${entry.interfaceId}`;
    const blocks: string[][] = [];
    let previousHeader: string | undefined;
    for (const match of entry.matches) {
        const header = match.member !== undefined ? `${ref}::${match.member}` : ref;
        if (header === previousHeader) {
            blocks.at(-1)!.push("--");
        } else {
            blocks.push([header]);
            previousHeader = header;
        }
        const lines = match.searchResult.split("\n");
        const width = String(match.lineRange[0] + lines.length - 1).length;
        blocks.at(-1)!.push(...lines.map((line, index) => {
            const lineNumber = String(match.lineRange[0] + index).padStart(width);
            return `${lineNumber}${matchesLine(line) ? ":" : "-"} ${line}`;
        }));
    }
    if (entry.matchesTruncated === true) {
        blocks.push([`(more matches in ${ref}; narrow the pattern or pass --interface ${entry.interfaceId})`]);
    }
    return blocks.map((block) => block.join("\n")).join("\n\n");
}

function _warnings(result: ExploreGrepResult): string[] {
    return [
        ...(result.inaccessible ?? []).map((directory) =>
            `directory ${JSON.stringify(directory.serviceId)} was not searched: ${directory.reason}`),
        ...(result.documentErrors ?? []).map((error) =>
            `could not load ${error.serviceId}::${error.interfaceId}: ${error.error}`),
        ...(result.entries.length < result.total
            ? [`showing ${result.entries.length} of ${result.total} matching interfaces; raise --limit to see more`]
            : []),
    ];
}
