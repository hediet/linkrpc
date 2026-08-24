/**
 * Slot resolution: given the tokens before the cursor, figure out *what kind
 * of thing* the user is about to type next (a subcommand name, a flag name,
 * a flag value of some known type, or a positional of some known type).
 *
 * Pure function — no I/O. The orchestrator in {@link ./complete.ts} consumes
 * the resulting slot and either looks up static candidates (flag/subcommand
 * names) or queries the hub via a {@link DirectorySource}.
 */
import type { ParsedLine } from './parse';
import { type CommandTree, type FlagDef, findFlag, type SlotType, type SubcommandDef } from './tree';

export type Slot =
    | { readonly kind: 'subcommand' }
    | { readonly kind: 'flag-name'; readonly subcommand: SubcommandDef | undefined }
    | { readonly kind: 'flag-value'; readonly flag: FlagDef; readonly subcommand: SubcommandDef | undefined }
    | {
        readonly kind: 'positional';
        readonly type: SlotType;
        readonly subcommand: SubcommandDef;
        readonly index: number;
    }
    | { readonly kind: 'none' };

export interface ResolvedContext {
    readonly slot: Slot;
    /** Subcommand parsed from the tokens (undefined if none seen yet). */
    readonly subcommand: SubcommandDef | undefined;
    /**
     * Flags already present on the line that take a value, paired with their
     * value (or `undefined` if the value followed in the next token).
     * Useful for extracting `--endpoint` etc. without re-parsing.
     */
    readonly seenFlagValues: ReadonlyMap<string, string | undefined>;
    /**
     * Positional values already typed (after the subcommand). Indexed
     * positionally — `seenPositionals[0]` is the first positional, etc.
     * Used to plumb e.g. the `methodRef` of `call <methodRef>` through to
     * dynamic completion for `--p:<name>` flags.
     */
    readonly seenPositionals: readonly string[];
}

/**
 * Walk the tokens before the cursor, tracking subcommand selection, current
 * positional index, and whether the next token is the value for a flag.
 * Returns the slot the cursor itself is in plus the surrounding context.
 */
export function resolveSlot(parsed: ParsedLine, tree: CommandTree): ResolvedContext {
    const tokens = parsed.tokensBefore;
    let subcommand: SubcommandDef | undefined;
    let positionalIndex = 0;
    let expectingValueFor: FlagDef | undefined;
    const seenFlagValues = new Map<string, string | undefined>();
    const seenPositionals: string[] = [];

    // tokens[0] is the binary name (`hub` / `hubrpc`). Skip it.
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i].text;

        if (expectingValueFor !== undefined) {
            seenFlagValues.set(expectingValueFor.name, t);
            expectingValueFor = undefined;
            continue;
        }

        if (t.startsWith('-') && t.length > 1) {
            const eq = t.indexOf('=');
            const flagName = eq >= 0 ? t.slice(0, eq) : t;
            const flag = findFlag(flagName, subcommand, tree);
            if (flag?.takesValue) {
                if (eq >= 0) {
                    seenFlagValues.set(flag.name, t.slice(eq + 1));
                } else {
                    expectingValueFor = flag;
                }
            } else if (flag) {
                seenFlagValues.set(flag.name, undefined);
            }
            continue;
        }

        // Positional.
        if (subcommand === undefined) {
            const sub = tree.subcommands.find((s) => s.name === t);
            if (!sub) {
                // Unknown subcommand — abandon resolution.
                return {
                    slot: { kind: 'none' },
                    subcommand: undefined,
                    seenFlagValues,
                    seenPositionals,
                };
            }
            subcommand = sub;
            positionalIndex = 0;
        } else {
            seenPositionals.push(t);
            positionalIndex++;
        }
    }

    const word = parsed.currentWordPrefix;

    if (expectingValueFor !== undefined) {
        return {
            slot: { kind: 'flag-value', flag: expectingValueFor, subcommand },
            subcommand,
            seenFlagValues,
            seenPositionals,
        };
    }

    if (word.startsWith('-')) {
        const eq = word.indexOf('=');
        if (eq >= 0) {
            // `--foo=<value>`: still a flag-value slot, but only if `--foo`
            // exists and takes a value. Otherwise treat as flag-name (the
            // user might be mid-type).
            const flag = findFlag(word.slice(0, eq), subcommand, tree);
            if (flag?.takesValue) {
                return {
                    slot: { kind: 'flag-value', flag, subcommand },
                    subcommand,
                    seenFlagValues,
                    seenPositionals,
                };
            }
        }
        return { slot: { kind: 'flag-name', subcommand }, subcommand, seenFlagValues, seenPositionals };
    }

    if (subcommand === undefined) {
        return { slot: { kind: 'subcommand' }, subcommand: undefined, seenFlagValues, seenPositionals };
    }

    const positional = subcommand.positionals[positionalIndex];
    if (positional !== undefined) {
        return {
            slot: { kind: 'positional', type: positional.type, subcommand, index: positionalIndex },
            subcommand,
            seenFlagValues,
            seenPositionals,
        };
    }
    if (subcommand.variadic !== undefined) {
        return {
            slot: { kind: 'positional', type: subcommand.variadic, subcommand, index: positionalIndex },
            subcommand,
            seenFlagValues,
            seenPositionals,
        };
    }
    return { slot: { kind: 'none' }, subcommand, seenFlagValues, seenPositionals };
}
