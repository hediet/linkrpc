import { safeTerminalText } from "../../ui/terminalText";
import type { GraphTreeLine } from "./inspectGraphModel";
import type { GraphExplorerModel } from "./inspectGraphView";

export interface GraphFrameOptions {
    readonly title: string;
    readonly params: string;
    readonly version?: number;
    readonly columns: number;
    readonly rows: number;
    readonly scrollTop: number;
    readonly revealSelection?: boolean;
    readonly showObjectIds?: boolean;
    readonly status?: string;
    readonly error?: boolean;
    readonly phase?: string;
}

export interface GraphFrameRow {
    readonly text: string;
    readonly style: "header" | "muted" | "reference" | "value" | "selected" | "error";
    readonly key?: string;
}

export const graphChromeRows = 6;

/** Presentation only: no terminal ownership, input handling or mutable model state. */
export function createGraphFrame(model: GraphExplorerModel | undefined, options: GraphFrameOptions): {
    readonly rows: readonly GraphFrameRow[];
    readonly scrollTop: number;
} {
    const capacity = Math.max(0, options.rows - graphChromeRows);
    const lines = model?.lines ?? [];
    const selected = model?.selectedIndex ?? 0;
    const scrollTop = clampGraphScroll(lines.length, selected, options.scrollTop, capacity, options.revealSelection !== false);
    const separator = " " + "─".repeat(Math.max(0, options.columns - 2));
    const rows: GraphFrameRow[] = [
        { text: ` GRAPH EXPLORER    ${options.phase ?? (options.version === undefined ? "CONNECTING" : `LIVE  v${options.version}`)}`, style: "header" },
        { text: ` ${options.title}  ${options.params}`, style: "muted" },
        { text: separator, style: "muted" },
    ];
    const labels = formatGraphTreeRows(lines, options.showObjectIds === true);
    for (let offset = 0; offset < capacity; offset++) {
        const index = scrollTop + offset;
        const line = lines[index];
        rows.push({
            text: line ? " " + labels[index] : "",
            key: line?.key,
            style: line && index === selected ? "selected" : line?.ref ? "reference" : "value",
        });
    }
    rows.push(
        { text: separator, style: "muted" },
        { text: ` ${options.status ?? (model ? model.selectedKey : "Waiting for first root…")}`, style: options.error ? "error" : "muted" },
        { text: ` ${lines.length === 0 ? 0 : selected + 1}/${lines.length}  ${model?.cachedObjects ?? 0} cached objects`
            + `  IDs:${options.showObjectIds ? "on" : "off"}`, style: "reference" },
    );
    return { rows: rows.slice(0, Math.max(0, options.rows)), scrollTop };
}

export function clampGraphScroll(count: number, selected: number, top: number, capacity: number, reveal = true): number {
    return Math.max(0, Math.min(
        !reveal || capacity === 0 ? top : selected < top ? selected
            : selected >= top + capacity ? selected - capacity + 1 : top,
        Math.max(0, count - capacity),
    ));
}

/** Relative labels and branches are computed before slicing, so scrolled rows retain ancestry. */
export function formatGraphTreeRows(lines: readonly GraphTreeLine[], showObjectIds: boolean): readonly string[] {
    const ancestors: GraphTreeLine[] = [];
    const ancestorIndices: number[] = [];
    const nextSiblings = new Map<number, number>();
    const hasSibling: boolean[] = [];
    for (let index = lines.length - 1; index >= 0; index--) {
        const depth = lines[index]!.depth;
        hasSibling[index] = nextSiblings.has(depth);
        for (const deeper of nextSiblings.keys()) if (deeper > depth) nextSiblings.delete(deeper);
        nextSiblings.set(depth, index);
    }
    return lines.map((line, index) => {
        ancestors.length = line.depth;
        ancestorIndices.length = line.depth;
        const parent = ancestors[line.depth - 1];
        const label = line.key === "$" ? "root" : line.key.slice((parent?.key ?? "$").length).replace(/^\./, "");
        ancestors[line.depth] = line;
        ancestorIndices[line.depth] = index;
        const marker = line.targetKey !== undefined ? "↪" : line.expandable ? line.expanded && line.loaded ? "▾" : "▸" : " ";
        const content = line.ref === undefined ? line.text.slice(line.key.length).replace(/^ = /, "  ")
            : `  ${line.ref.kind}${showObjectIds ? `:${line.ref.id}` : ""}`
                + (line.summary === undefined ? "" : `  ${line.summary}`)
                + (line.description === undefined ? "" : ` — ${line.description}`)
                + (line.loaded ? "" : "  [fetch on expand]")
                + (line.targetKey === undefined ? "" : `  [link to ${line.targetKey}]`);
        const branch = line.depth === 0 ? "" : ancestorIndices.slice(1, line.depth)
            .map(ancestor => hasSibling[ancestor] ? "│  " : "   ").join("")
            + (hasSibling[index] ? "├─ " : "└─ ");
        return `${branch}${marker} ${label}${content}`;
    });
}

export function anchorGraphScrollTop(previous: readonly GraphTreeLine[], next: readonly GraphTreeLine[], scrollTop: number): number {
    const indices = new Map(next.map((line, index) => [line.key, index]));
    for (let distance = 0; distance < previous.length; distance++) {
        for (const index of distance === 0 ? [scrollTop] : [scrollTop + distance, scrollTop - distance]) {
            const line = previous[index];
            const position = line === undefined ? undefined : indices.get(line.key);
            if (position !== undefined) return position;
        }
    }
    return scrollTop;
}

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function cellWidth(text: string): number {
    const code = text.codePointAt(0)!;
    if (/^\p{Mark}+$/u.test(text)) return 0;
    if (/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(text)) return 2;
    return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
        || code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f
        || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff
        || code >= 0xfe10 && code <= 0xfe19 || code >= 0xfe30 && code <= 0xfe6f
        || code >= 0xff00 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6
        || code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
}

/** Sanitize first, then clip/pad by terminal cells so Ink never wraps a frame row. */
export function graphFrameText(text: string, columns: number, pad = false): string {
    const width = Math.max(0, columns);
    const characters = [...segments.segment(safeTerminalText(text))].map(value => value.segment);
    let result = "", used = 0;
    const total = characters.reduce((sum, value) => sum + cellWidth(value), 0);
    const clipped = total > width;
    for (const character of characters) {
        const size = cellWidth(character);
        if (used + size > width - (clipped ? 1 : 0)) break;
        used += size;
        result += character;
    }
    if (clipped && width > 0) { result += "…"; used++; }
    return result + (pad ? " ".repeat(Math.max(0, width - used)) : "");
}
