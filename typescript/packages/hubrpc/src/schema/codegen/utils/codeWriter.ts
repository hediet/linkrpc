/**
 * Minimal indentation-aware text builder for code generation.
 *
 * Usage pattern:
 *   - {@link append} extends the *current* (unfinished) line. Indentation
 *     is inserted lazily the first time content lands on a fresh line, so
 *     blank lines stay blank.
 *   - {@link newline} ends the current line.
 *   - {@link writeLine} is `append` + `newline`.
 *   - {@link indent} / {@link dedent} change the indent level used for
 *     *future* fresh lines; they do not retroactively reformat the
 *     in-progress line.
 *
 * Indentation is fixed at four spaces, matching the surrounding codebase.
 */
export class CodeWriter {
    private readonly _lines: string[] = [];
    private _current = "";
    private _indent = 0;
    private _onFreshLine = true;

    public indent(): this {
        this._indent++;
        return this;
    }

    public dedent(): this {
        if (this._indent === 0) throw new Error("CodeWriter: dedent below 0");
        this._indent--;
        return this;
    }

    public append(text: string): this {
        if (text.length === 0) return this;
        if (this._onFreshLine) {
            this._current = "    ".repeat(this._indent);
            this._onFreshLine = false;
        }
        this._current += text;
        return this;
    }

    public newline(): this {
        this._lines.push(this._current);
        this._current = "";
        this._onFreshLine = true;
        return this;
    }

    public writeLine(text = ""): this {
        return this.append(text).newline();
    }

    public toString(): string {
        const lines = [...this._lines];
        if (!this._onFreshLine) lines.push(this._current);
        return lines.join("\n") + "\n";
    }
}
