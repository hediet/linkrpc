/**
 * Pre-processor for `--p:<name>[=<value>]` shortcuts on the CLI. Rewrites
 * them to commander-friendly `--param <name>=<value>` pairs *before*
 * commander sees the argv, so we don't have to teach commander about them
 * (which is awkward given they're dynamic per-method).
 *
 * Forms accepted:
 *   --p:to=a@b.c        single token, kept verbatim → `--param to=a@b.c`
 *   --p:to a@b.c        two tokens, joined → `--param to=a@b.c`
 *   --p:dryRun          boolean shortcut (no value) → `--param dryRun=true`
 *
 * Nested keys keep working through the existing `mergeParams` dot-path
 * support: `--p:user.name=alice` → `--param user.name=alice`.
 *
 * Anything past a literal `--` token is left alone (POSIX end-of-options).
 * Tokens that look like the start of the next flag (e.g. `--p:dryRun
 * --verbose`) are treated as the "no value" form so `--verbose` keeps its
 * intended role.
 */

const FLAG_PREFIX = '--p:';

/**
 * Transform `argv`, expanding every `--p:<name>` token to `--param key=value`.
 * Non-matching tokens pass through unchanged. Returns a new array; never
 * mutates the input.
 */
export function rewriteParamShortcuts(argv: readonly string[]): string[] {
    const out: string[] = [];
    let stopExpanding = false;

    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];

        if (!stopExpanding && tok === '--') {
            stopExpanding = true;
            out.push(tok);
            continue;
        }
        if (stopExpanding || !tok.startsWith(FLAG_PREFIX)) {
            out.push(tok);
            continue;
        }

        const rest = tok.slice(FLAG_PREFIX.length);
        if (rest.length === 0) {
            // Bare `--p:` is meaningless; leave it for commander to error on.
            out.push(tok);
            continue;
        }

        const eq = rest.indexOf('=');
        if (eq >= 0) {
            const name = rest.slice(0, eq);
            const value = rest.slice(eq + 1);
            if (name.length === 0) {
                out.push(tok); // malformed `--p:=value`; let commander complain
                continue;
            }
            out.push('--param', `${name}=${value}`);
            continue;
        }

        // `--p:name` with no inline value. Use the next token unless it looks
        // like another flag (then assume boolean shortcut).
        const name = rest;
        const peek = argv[i + 1];
        if (peek === undefined || peek.startsWith('-')) {
            out.push('--param', `${name}=true`);
            continue;
        }
        out.push('--param', `${name}=${peek}`);
        i += 1;
    }
    return out;
}
