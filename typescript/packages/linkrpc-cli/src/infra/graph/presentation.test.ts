import { describe, expect, it } from 'vitest';
import { LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { connectViaTransport } from '@hediet/linkrpc-client';
import { graphPresentationInterface, type GraphPresentation } from '@hediet/linkrpc-infra/graph';
import { LazyGraphSource, registerGraphSource } from '@hediet/linkrpc-infra/graph/source';
import { GraphLoader } from './inspectGraphModel';
import { GraphExplorerModel, renderGraphJson, renderGraphTree } from './inspectGraphView';
import { createGraphRuntime } from '@hediet/linkrpc-infra/graph/source';
import { formatGraphTreeRows } from './graphFrame';
import { graphView, resolveGraphRoots } from './contribution';
import { resolveViewSelection } from '../../views/discovery';
import { inspectGraphCommand } from './inspectGraph';

const metadata: GraphPresentation = { rules: {
    part: { label: [{ path: ['toolCall'], presentation: 'label' }], secondary: [{ path: ['toolCall'], presentation: 'secondary' }] },
    tool: { label: [{ path: ['displayName'] }], secondary: [{ path: ['message', 'markdown'] }] },
} };

function fixture() {
    const source = new LazyGraphSource('presentation');
    const loaded: string[] = [];
    const history = source.defer('history', async () => { loaded.push('history'); return { text: 'unrelated' }; });
    const message = source.defer('markdown', async () => { loaded.push('markdown'); return { markdown: 'Read package.json' }; });
    const tool = source.defer('tool', async () => {
        loaded.push('tool'); return { displayName: 'Read file', message, history };
    });
    const part = source.defer('part', async () => { loaded.push('part'); return { toolCall: tool, history }; });
    source.root.set(source.put('root', { responseParts: [part] }), undefined);
    return { source, loaded, history, presentation: { root: source.root, store: source.store, presentation: metadata } };
}

describe('shared graph presentation in CLI', () => {
    it('loads only displayed labels, keeps property names and leaves raw JSON as data', async () => {
        const { source, loaded, history } = fixture();
        const runtime = createGraphRuntime(source);
        const loader = new GraphLoader(request => runtime.batchObjGet(request));
        try {
            await loader.load([{ ref: source.root.get(), paths: ['/'] }]);
            const model = new GraphExplorerModel(source.root.get(), loader, undefined, undefined, undefined, metadata);
            await model.restoreExpanded();
            expect(loaded).toEqual(['part', 'tool', 'markdown']);
            expect(loader.cache.has(history)).toBe(false);
            expect(model.lines[1]).toMatchObject({ key: '$.responseParts[0]', summary: 'Read file', description: 'Read package.json' });
            const rows = formatGraphTreeRows(model.lines, false).join('\n');
            expect(rows).toContain('responseParts[0]');
            expect(rows).toContain('Read file — Read package.json');
            expect(renderGraphTree(model)).toContain('$.responseParts[0]');
            const raw = JSON.parse(renderGraphJson(source.root.get(), loader));
            expect(raw).toHaveProperty('responseParts');
            expect(renderGraphJson(source.root.get(), loader)).not.toContain('Read file —');
        } finally { source.dispose(); }
    });

    it.each(['interface', 'service'] as const)('discovers optional metadata for %s targets and never fetches it for JSON', async kind => {
        const { source, presentation } = fixture();
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.b);
        const registration = registerGraphSource(server, presentation);
        server.enableReflection();
        const client = connectViaTransport(pair.a);
        try {
            const context = await resolveViewSelection(client.channel, graphView, kind === 'interface'
                ? { interface: 'linkrpc.graph.v1' } : { service: '' });
            const targets = resolveGraphRoots(context).filter(target => target.interfaceId === 'linkrpc.graph.v1');
            expect(targets[0]?.presentationMethod).toBe(`${graphPresentationInterface.info.id}::get`);
            const text = await inspectGraphCommand(client.channel, { targets, root: 'workspace', depth: 1 });
            expect(text).toContain('Read file');
            expect(text).toContain('Read package.json');
            const raw = await inspectGraphCommand(client.channel, { targets, root: 'workspace', depth: 1, json: true });
            expect(raw).not.toContain('Read file');
            const old = await inspectGraphCommand(client.channel, {
                targets: targets.map(target => ({ ...target, presentationMethod: undefined })), root: 'workspace', depth: 1,
            });
            expect(old).not.toContain('Read file');
        } finally { client.close(); registration.dispose(); server.close(); source.dispose(); }
    });
});
