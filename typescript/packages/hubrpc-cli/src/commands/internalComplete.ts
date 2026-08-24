/**
 * `hub _complete --line <line> --point <cursor>` — internal completion
 * resolver invoked by the shell scripts emitted by `hub completions`.
 *
 * Reads the line + cursor, optionally connects to whatever endpoint the line
 * already names (via `--endpoint*` flags or `HUBRPC_ENDPOINT`), and prints
 * one candidate per line as `text\ttooltip`. Empty output on any error —
 * the completer that invokes us must never disturb the user's prompt.
 *
 * The actual resolution lives in `../completions/runComplete.ts`; this command
 * just formats the structured result for stdout.
 */
import { type Completion } from '../completions/complete';
import { completeForLine, type CompleteForLineOptions } from '../completions/runComplete';
import { type DirectorySource } from '../completions/directorySource';

export interface InternalCompleteOptions {
    readonly line: string;
    readonly point: number;
    /** Override the directory source (tests). */
    readonly directoryOverride?: DirectorySource;
    /** Suppress the connect attempt entirely (tests). */
    readonly skipConnect?: boolean;
}

/**
 * Compute completions and return them as a `\n`-joined `text\ttooltip` string
 * ready for stdout. Returns `''` when there are no candidates so callers can
 * unconditionally write the result.
 */
export async function internalCompleteCommand(opts: InternalCompleteOptions): Promise<string> {
    const runOpts: CompleteForLineOptions = {
        line: opts.line,
        point: opts.point,
        ...(opts.directoryOverride !== undefined ? { directoryOverride: opts.directoryOverride } : {}),
        ...(opts.skipConnect !== undefined ? { skipConnect: opts.skipConnect } : {}),
    };
    const result = await completeForLine(runOpts);
    return _formatCandidates(result.candidates);
}

function _formatCandidates(candidates: readonly Completion[]): string {
    return candidates
        .map((c) => (c.tooltip ? `${c.text}\t${c.tooltip}` : c.text))
        .join('\n');
}
