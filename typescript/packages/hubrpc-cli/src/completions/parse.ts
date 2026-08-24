/**
 * Tokenize a shell-style command line and locate the token at the cursor.
 *
 * Used by the `_complete` subcommand to figure out what the user is currently
 * typing. Quoting rules are intentionally minimal (POSIX-ish, matching what
 * users actually type at a PowerShell prompt): single/double quoted strings
 * are single tokens; nothing else is special. Cross-shell quoting nuances
 * don't matter for completion — we only need to know where token boundaries
 * are well enough to pick the current word.
 */

export interface Token {
    readonly text: string;
    /** Byte offset where the token starts (including any opening quote). */
    readonly start: number;
    /** Byte offset one past the token end (including any closing quote). */
    readonly end: number;
    readonly quoted: boolean;
}

/** Whitespace per the simple POSIX rule (space, tab, newline). */
function _isWs(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

export function tokenize(line: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < line.length) {
        while (i < line.length && _isWs(line[i])) i++;
        if (i >= line.length) break;
        const start = i;
        const ch = line[i];
        let text = '';
        let quoted = false;
        if (ch === '"' || ch === "'") {
            quoted = true;
            const q = ch;
            i++;
            while (i < line.length && line[i] !== q) {
                text += line[i++];
            }
            if (i < line.length) i++; // consume closing quote
        } else {
            while (i < line.length && !_isWs(line[i])) {
                text += line[i++];
            }
        }
        tokens.push({ text, start, end: i, quoted });
    }
    return tokens;
}

export interface ParsedLine {
    readonly tokens: readonly Token[];
    /**
     * Tokens fully to the left of the cursor (i.e. context — never includes the
     * token the user is currently typing). The first token is the binary name.
     */
    readonly tokensBefore: readonly Token[];
    /**
     * The token the cursor is positioned in / at the right edge of, or
     * `undefined` when the cursor sits in whitespace (a "new" word).
     */
    readonly currentToken: Token | undefined;
    /**
     * Text the user has typed for the current word so far (token start →
     * cursor). Empty when {@link currentToken} is undefined. Used both for
     * prefix-filtering candidates and as the value PowerShell replaces.
     */
    readonly currentWordPrefix: string;
}

/**
 * Split `line` at `point` (0-indexed cursor position) into a previous-tokens
 * list + a possibly in-progress current word. Cursor inside or at the end of
 * a token = that token is the current word; cursor in whitespace = no current
 * token, new empty word at this position.
 */
export function parseLine(line: string, point: number): ParsedLine {
    const tokens = tokenize(line);
    const safePoint = Math.max(0, Math.min(line.length, point));

    // A cursor sitting on whitespace (or at the very start) means we're
    // typing a brand-new word at this column.
    const charLeftOfCursor = safePoint > 0 ? line[safePoint - 1] : ' ';
    const inGap = _isWs(charLeftOfCursor) || safePoint === 0;
    if (inGap) {
        const tokensBefore = tokens.filter((t) => t.end <= safePoint);
        return { tokens, tokensBefore, currentToken: undefined, currentWordPrefix: '' };
    }

    // Cursor is "attached" to a token: find the one containing the char
    // immediately to its left.
    const cur = tokens.find((t) => t.start <= safePoint - 1 && safePoint - 1 < t.end);
    if (!cur) {
        // Defensive: shouldn't happen given the gap check above.
        const tokensBefore = tokens.filter((t) => t.end <= safePoint);
        return { tokens, tokensBefore, currentToken: undefined, currentWordPrefix: '' };
    }
    const tokensBefore = tokens.filter((t) => t.end <= cur.start);
    return {
        tokens,
        tokensBefore,
        currentToken: cur,
        currentWordPrefix: cur.text.slice(0, safePoint - cur.start),
    };
}
