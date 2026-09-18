import { readFileSync } from 'node:fs';
import {
    computeInterfaceHash,
    type LinkRpcInterfaceSchema,
    type LinkRpcJsonSchema,
} from '@hediet/linkrpc';
import { importCdpProtocol, importLspProtocol } from './contracts';
import { componentClosure } from './contracts/common';
import type { ContractImportDiagnostic } from './contracts/types';

export type InteropProtocol = 'cdp' | 'lsp';

const corpusRoot = new URL('../../../../../conformance/protocols/', import.meta.url);
const readCorpus = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(name, corpusRoot), 'utf8'));

export function importedInteropContracts() {
    const cdp = importCdpProtocol(
        readCorpus('cdp-0.0.1677763/browser_protocol.json'),
        readCorpus('cdp-0.0.1677763/js_protocol.json'),
    );
    const lsp = importLspProtocol(readCorpus('lsp-3.17.5/metaModel.json'));
    return {
        full: [...Object.values(cdp.interfaces), ...Object.values(lsp.interfaces)],
        selected: {
            cdp: select(cdp.interfaces['cdp.dom'], ['getDocument', 'documentUpdated']),
            lsp: select(lsp.interfaces['lsp.textdocument'], [
                'selectionRange', 'didOpen', 'publishDiagnostics',
            ]),
        },
    };
}

function select(schema: LinkRpcInterfaceSchema, names: string[]): LinkRpcInterfaceSchema {
    const selected: LinkRpcInterfaceSchema = {
        ...schema,
        hash: '',
        methods: Object.fromEntries(names.map((name) => {
            const method = schema.methods[name];
            if (!method) throw new Error(`Missing imported method ${schema.id}::${name}`);
            return [name, method];
        })),
    };
    const roots: LinkRpcJsonSchema[] = [];
    for (const method of Object.values(selected.methods)) {
        roots.push(method.params);
        for (const value of [method.result, method.clientStream, method.serverStream]) {
            if (value !== undefined) roots.push(value);
        }
        for (const error of method.errors ?? []) {
            if (error.data !== undefined) roots.push(error.data);
        }
    }
    const diagnostics: ContractImportDiagnostic[] = [];
    selected.components = {
        schemas: componentClosure(schema.components?.schemas ?? {}, roots, diagnostics, schema.id),
    };
    if (diagnostics.length > 0) {
        throw new Error(`Invalid selected protocol schema: ${JSON.stringify(diagnostics)}`);
    }
    selected.hash = computeInterfaceHash(selected);
    return selected;
}

export const cdpDocument = {
    root: {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 9,
        nodeName: '#document',
        localName: '',
        nodeValue: '',
        children: [{
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'HTML',
            localName: 'html',
            nodeValue: '',
        }],
    },
};

export const lspSelectionRanges = [{
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
    parent: {
        range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
    },
}];

export const lspDidOpen = {
    textDocument: {
        uri: 'file:///interop.json',
        languageId: 'json',
        version: 1,
        text: '{}',
    },
};

export const lspDiagnostics = { uri: 'file:///interop.json', diagnostics: [] };
