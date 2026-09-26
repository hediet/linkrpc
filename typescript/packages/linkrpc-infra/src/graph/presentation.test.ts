import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@hediet/linkrpc';
import { evaluateGraphPresentation, mergeGraphPresentations, type GraphPresentation } from './presentation';
import { GraphComposition, LocalGraphSource } from './source';

const part = { kind: 'part', id: 's/part' };
const tool = { kind: 'tool', id: 's/tool' };
const markdown = { kind: 'markdown', id: 's/markdown' };
const unrelated = { kind: 'conversation', id: 's/history' };
const rules: GraphPresentation = { rules: {
    part: { label: [{ path: ['toolCall'], presentation: 'label' }], secondary: [{ path: ['toolCall'], presentation: 'secondary' }] },
    tool: {
        label: [{ path: ['displayName'] }, { path: ['toolName'] }],
        secondary: [{ path: ['pastTenseMessage', 'markdown'] }, { path: ['pastTenseMessage'] },
            { path: ['invocationMessage', 'markdown'] }, { path: ['invocationMessage'] }],
    },
} };

describe('declarative graph presentation', () => {
    it('loads only label dependencies, never secondary or unrelated conversation refs', () => {
        const values = new Map<string, JsonValue>([
            [part.id, { toolCall: tool, conversation: unrelated }],
            [tool.id, { displayName: 'Read file', pastTenseMessage: markdown }],
        ]);
        const result = evaluateGraphPresentation(part, rules, ref => ({ value: values.get(ref.id)! }), { fields: ['label'] });
        expect(result.label).toBe('Read file');
        expect(result.dependencies).toEqual([part, tool]);
        expect(result.pending).toEqual([]);
    });

    it('blocks fallback on pending refs, unwraps intermediate refs and supports strings', () => {
        const values = new Map<string, JsonValue>([[tool.id, {
            displayName: '', toolName: 'read', pastTenseMessage: markdown, invocationMessage: 'Reading',
        }]]);
        const read = (ref: { id: string }) => values.has(ref.id) ? { value: values.get(ref.id)! } : undefined;
        const first = evaluateGraphPresentation(tool, rules, read);
        expect(first.label).toBe('read');
        expect(first.secondary).toBeUndefined();
        expect(first.pending).toEqual([markdown]);
        values.set(markdown.id, { markdown: 'Read the file', unused: unrelated });
        expect(evaluateGraphPresentation(tool, rules, read).secondary).toBe('Read the file');
        values.set(markdown.id, null);
        expect(evaluateGraphPresentation(tool, rules, read).secondary).toBe('Reading');
        values.set(tool.id, { pastTenseMessage: 'Done', invocationMessage: markdown });
        expect(evaluateGraphPresentation(tool, rules, read, { fields: ['secondary'] }).dependencies).toEqual([tool]);
    });

    it('delegates intermediate rules and bounds cycles, depth and work', () => {
        const metadata: GraphPresentation = { rules: { part: { label: [{ path: ['next'], presentation: 'label' }] } } };
        const self = evaluateGraphPresentation(part, metadata, () => ({ value: { next: part } }));
        expect(self.limited).toBe(true);
        expect(self.pending).toEqual([]);
        const chain = (ref: { id: string }) => ({ value: { next: { kind: 'part', id: ref.id + '/next' } } });
        expect(evaluateGraphPresentation(part, metadata, chain, { maxDepth: 2 }).limited).toBe(true);
        expect(evaluateGraphPresentation(part, metadata, chain, { maxWork: 2 }).limited).toBe(true);
        expect(() => evaluateGraphPresentation(part, metadata, chain, { maxWork: Infinity })).toThrow();
        const direct = { rules: { part: { label: [{ path: ['next', 'title'] }] } } };
        expect(evaluateGraphPresentation(part, direct, () => ({ value: { next: part } })).limited).toBe(true);
    });

    it('does not read objects without metadata and never infers property names or positions', () => {
        const read = () => { throw new Error('unexpected read'); };
        expect(evaluateGraphPresentation(tool, undefined, read).dependencies).toEqual([]);
        expect(evaluateGraphPresentation(tool, { rules: {} }, read).label).toBeUndefined();
        const result = evaluateGraphPresentation(tool, { rules: { tool: { label: [{ path: ['explicit'] }] } } },
            () => ({ value: { title: 'Not selected', name: 'Not selected', arbitrary: 'No' } }));
        expect(result.label).toBeUndefined();
    });

    it('composes declarations generically and rejects conflicts atomically, including retained kinds', async () => {
        const first = new LocalGraphSource('a');
        const second = new LocalGraphSource('b');
        const a = { root: first.root, store: first.store, presentation: rules };
        const b = { root: second.root, store: second.store, presentation: rules };
        const composition = new GraphComposition([{ id: 'a', label: 'A', source: a }]);
        try {
            composition.setSources([{ id: 'b', label: 'B', source: b }]);
            expect(composition.presentation).toEqual(rules);
            expect(() => composition.setSources([{ id: 'a', label: 'A', source: {
                ...a, presentation: { rules: { tool: { label: [{ path: ['different'] }] } } },
            } }])).toThrow(/Conflicting.*tool/);
            expect(composition.presentation).toEqual(rules);
            expect(mergeGraphPresentations(rules, rules)).toEqual(rules);
        } finally { await composition.dispose(); first.dispose(); second.dispose(); }
    });
});
