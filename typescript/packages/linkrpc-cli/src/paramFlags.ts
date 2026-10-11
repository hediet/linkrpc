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
    return rewriteCapabilityShortcuts(expandParamShortcuts(argv));
}

function expandParamShortcuts(argv: readonly string[]): string[] {
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

const CAPABILITY_SHORTCUTS = new Map([
    ['--cap:allow-prefix', 'prefix'],
    ['--cap:allow-any', 'any'],
    ['--cap:allow-enum', 'enum'],
    ['--cap:allow-subset', 'subsetOf'],
]);

function rewriteCapabilityShortcuts(argv: readonly string[]): string[] {
    const out: string[] = [];
    const constrained = new Set<string>();
    let precedingParam: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--') {
            out.push(...argv.slice(i));
            break;
        }
        const eq = token.indexOf('=');
        const flag = eq < 0 ? token : token.slice(0, eq);
        const matcher = CAPABILITY_SHORTCUTS.get(flag);
        if (matcher !== undefined) {
            if (precedingParam === undefined) {
                throw new Error(`${flag} must immediately follow a --param or --p:<name> assignment.`);
            }
            if (precedingParam.includes('.')) throw new Error(`${flag} only supports top-level parameter names.`);
            if (constrained.has(precedingParam)) throw new Error(`Duplicate --cap:allow-param for ${precedingParam}.`);
            let value: unknown = true;
            if (matcher === 'any') {
                if (eq >= 0) throw new Error('--cap:allow-any takes no value.');
            } else {
                const raw = eq >= 0 ? token.slice(eq + 1) : argv[++i];
                if (raw === undefined || (eq < 0 && raw.startsWith('--'))) {
                    throw new Error(`${flag} requires a value.`);
                }
                if (matcher === 'prefix') {
                    value = raw;
                } else {
                    try { value = JSON.parse(raw); }
                    catch { throw new Error(`${flag} requires a JSON array.`); }
                    if (!Array.isArray(value)
                        || (matcher === 'enum' && value.length === 0)
                        || (matcher === 'subsetOf' && !value.every(item => typeof item === 'string'))) {
                        throw new Error(`${flag} requires ${matcher === 'enum' ? 'a non-empty JSON array' : 'a JSON string array'}.`);
                    }
                }
            }
            constrained.add(precedingParam);
            out.push('--cap:allow-param', `${precedingParam}=${JSON.stringify({ [matcher]: value })}`);
            continue;
        }
        if (flag === '--param' || flag === '--cap:allow-param') {
            const values: string[] = [];
            if (eq >= 0) {
                values.push(token.slice(eq + 1));
                out.push(token);
            } else {
                out.push(token);
                while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
                    const value = argv[++i];
                    values.push(value);
                    out.push(value);
                }
            }
            precedingParam = undefined;
            for (const value of values) {
                const assignment = value.indexOf('=');
                if (assignment <= 0) continue;
                const key = value.slice(0, assignment);
                if (constrained.has(key)) {
                    throw new Error(flag === '--param'
                        ? `Cannot reassign parameter ${key} after an explicit capability constraint.`
                        : `Duplicate --cap:allow-param for ${key}.`);
                }
                if (flag === '--cap:allow-param') constrained.add(key);
                else precedingParam = key;
            }
            continue;
        }
        precedingParam = undefined;
        out.push(token);
    }
    return out;
}
