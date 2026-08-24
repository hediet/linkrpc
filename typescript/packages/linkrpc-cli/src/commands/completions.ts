/**
 * `hub completions <shell>` — print the shell-completion registration script
 * for the requested shell.
 *
 * No connection required. Currently supports `powershell` only.
 */
import { emitCompletionScript, isSupportedShell } from '../completions/shellScripts';

export interface CompletionsCommandOptions {
    readonly shell: string;
}

export function completionsCommand(opts: CompletionsCommandOptions): string {
    if (!isSupportedShell(opts.shell)) {
        throw new Error(
            `unsupported shell "${opts.shell}". Supported: powershell.`,
        );
    }
    return emitCompletionScript(opts.shell);
}
