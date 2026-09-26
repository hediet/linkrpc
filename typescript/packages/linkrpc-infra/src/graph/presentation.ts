import { defineInterface, requestType, type JsonValue } from '@hediet/linkrpc';
import { z } from 'zod';
import type { GraphRef } from './interfaces';
import { isGraphRef, standardGraphRuntimeOptions } from './immutableGraph';

const fieldSchema = z.enum(['label', 'secondary']);
export const graphPresentationCandidateSchema = z.object({
    path: z.array(z.string()),
    presentation: fieldSchema.optional(),
});
export const graphPresentationRuleSchema = z.object({
    label: z.array(graphPresentationCandidateSchema).optional(),
    secondary: z.array(graphPresentationCandidateSchema).optional(),
});
export const graphPresentationSchema = z.object({
    rules: z.record(z.string(), graphPresentationRuleSchema),
});
export type GraphPresentationField = z.infer<typeof fieldSchema>;
export interface GraphPresentationCandidate {
    readonly path: readonly string[];
    readonly presentation?: GraphPresentationField;
}
export interface GraphPresentationRule {
    readonly label?: readonly GraphPresentationCandidate[];
    readonly secondary?: readonly GraphPresentationCandidate[];
}
export interface GraphPresentation {
    readonly rules: Readonly<Record<string, GraphPresentationRule>>;
}

/** Additive metadata, deliberately independent of the canonical graph protocol hash. */
export const graphPresentationInterface = defineInterface({ id: 'linkrpc.graph.presentation.v1' }, {
    get: requestType(z.object({}), graphPresentationSchema).withErrors([]),
});

export interface GraphPresentationResult {
    readonly label?: string;
    readonly secondary?: string;
    /** Every object read, including pending reads. Retain/observe these with the displayed row. */
    readonly dependencies: readonly GraphRef[];
    /** Object-only reads needed before the selected fallback can be resolved. */
    readonly pending: readonly GraphRef[];
    readonly limited: boolean;
}

/**
 * Paths name properties, never property positions. References encountered along a
 * path are read lazily. A terminal `presentation` delegates to that ref's rule.
 * Undefined reads suspend that field rather than incorrectly choosing a fallback.
 */
export function evaluateGraphPresentation(
    ref: GraphRef,
    metadata: GraphPresentation | undefined,
    read: (ref: GraphRef) => { readonly value: JsonValue } | undefined,
    options: { readonly fields?: readonly GraphPresentationField[]; readonly maxDepth?: number; readonly maxWork?: number } = {},
): GraphPresentationResult {
    const maxDepth = options.maxDepth ?? 32;
    const maxWork = options.maxWork ?? 256;
    for (const [name, value] of Object.entries({ maxDepth, maxWork })) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
    const dependencies = new Map<string, GraphRef>();
    const pending = new Map<string, GraphRef>();
    const active = new Set<string>();
    const waiting = Symbol('waiting');
    const exhausted = Symbol('exhausted');
    let work = 0;
    let limited = false;
    const budget = (depth: number) => {
        if (++work > maxWork || depth > maxDepth) { limited = true; return false; }
        return true;
    };
    const lookup = (target: GraphRef) => {
        const key = standardGraphRuntimeOptions.refKey(target);
        dependencies.set(key, target);
        const result = read(target);
        if (result === undefined) { pending.set(key, target); return waiting; }
        return result.value;
    };
    type Outcome = string | undefined | typeof waiting | typeof exhausted;
    const evaluate = (target: GraphRef, field: GraphPresentationField, depth: number): Outcome => {
        if (!budget(depth)) return exhausted;
        const rule = metadata?.rules[target.kind];
        if (!Object.hasOwn(metadata?.rules ?? {}, target.kind) || rule?.[field] === undefined) return undefined;
        const key = JSON.stringify([target.kind, target.id, field]);
        if (active.has(key)) { limited = true; return exhausted; }
        active.add(key);
        try {
            for (const candidate of rule[field]!) {
                if (!budget(depth)) return exhausted;
                let value: JsonValue = target;
                const seen = new Set<string>();
                let traversals = depth;
                const unwrap = (input: JsonValue): JsonValue | typeof waiting | typeof exhausted => {
                    while (isGraphRef(input)) {
                        if (!budget(++traversals)) return exhausted;
                        const refKey = standardGraphRuntimeOptions.refKey(input);
                        if (seen.has(refKey)) { limited = true; return exhausted; }
                        seen.add(refKey);
                        const result = lookup(input);
                        if (result === waiting) return waiting;
                        input = result;
                    }
                    return input;
                };
                let absent = false;
                for (const property of candidate.path) {
                    if (!budget(traversals)) return exhausted;
                    const resolved = unwrap(value);
                    if (resolved === waiting || resolved === exhausted) return resolved;
                    value = resolved;
                    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, property)) {
                        absent = true; break;
                    }
                    value = (value as Record<string, JsonValue>)[property];
                }
                if (absent) continue;
                if (candidate.presentation !== undefined) {
                    if (!isGraphRef(value)) continue;
                    const delegated = evaluate(value, candidate.presentation, traversals + 1);
                    if (delegated !== undefined) return delegated;
                } else {
                    const resolved = unwrap(value);
                    if (resolved === waiting || resolved === exhausted) return resolved;
                    if (typeof resolved === 'string' && resolved.trim().length > 0) return resolved;
                }
            }
            return undefined;
        } finally { active.delete(key); }
    };
    const text: { label?: string; secondary?: string } = {};
    for (const field of options.fields ?? ['label', 'secondary']) {
        const value = evaluate(ref, field, 0);
        if (typeof value === 'string') text[field] = value;
    }
    return { ...text, dependencies: [...dependencies.values()], pending: [...pending.values()], limited };
}

/** Conflicting declarations fail rather than making labels depend on source order. */
export function mergeGraphPresentations(...presentations: readonly (GraphPresentation | undefined)[]): GraphPresentation {
    const rules: Record<string, z.infer<typeof graphPresentationRuleSchema>> = Object.create(null);
    for (const presentation of presentations) {
        if (presentation === undefined) continue;
        const parsed = graphPresentationSchema.parse(presentation);
        for (const [kind, rule] of Object.entries(parsed.rules)) {
            if (Object.hasOwn(rules, kind) && JSON.stringify(rules[kind]) !== JSON.stringify(rule)) {
                throw new Error(`Conflicting graph presentation declaration for kind ${kind}`);
            }
            rules[kind] = rule;
        }
    }
    return { rules };
}
