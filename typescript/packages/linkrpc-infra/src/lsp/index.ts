/**
 * Language Server Protocol (LSP) host interfaces. Browser-safe; the Node.js
 * host implementation is `@hediet/linkrpc-infra/lsp/node`.
 *
 * All URIs on the hub side are plain `file://` URIs on the host machine.
 * LSP JSON-RPC traffic flows unchanged over `jsonRpcConnection::connectRaw`
 * with {@link LspConnectParams} as `params`.
 */
import { defineInterface, requestType } from '@hediet/linkrpc';
import { z } from 'zod';

const empty = z.object({});

export const languageServerInfoSchema = z.object({
    id: z.string().min(1),
    languages: z.array(z.string().min(1)).optional(),
});

export const lspConnectParamsSchema = z.object({
    server: z.string().min(1),
    rootUri: z.string().min(1),
});

export const lspInterface = defineInterface(
    {
        id: 'lsp.v1',
        description: [
            'Discovery interface for a LinkRPC language-server host.',
            'Start an LSP session by calling `jsonRpcConnection::connectRaw` on the same service',
            'with `{ server, rootUri }` where `rootUri` is a `file://` URI inside the host allow-list.',
        ].join(' '),
    },
    {
        listServers: requestType(empty, z.object({ servers: z.array(languageServerInfoSchema) })),
    },
);

export type LanguageServerInfo = z.infer<typeof languageServerInfoSchema>;
export type LspConnectParams = z.infer<typeof lspConnectParamsSchema>;
