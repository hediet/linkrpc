import { LinkRpcConnection } from '@hediet/linkrpc';
import { HubDirectoryExplorer } from '@hediet/linkrpc/hub/common';
import { computeNodePortsInterface, computeNodeTcpForwardInterface } from '@hediet/linkrpc-infra/compute-node';
import { startHttpExport, type HttpExport, type HttpExportServiceList } from '@hediet/linkrpc-infra/http-export/node';
import type { CliConnection } from '@hediet/linkrpc-client-internal';

const SERVICE_LIST_TTL_MS = 30_000;
const SERVICE_LIST_TIMEOUT_MS = 20_000;

export async function httpExportCommand(options: {
    readonly local: Pick<CliConnection, 'channel' | 'rpcChannel'>;
    /** Unlocks a capability-gated directory; returns whether it may be listed now. */
    readonly requestDirectoryAccess?: (serviceId: string) => Promise<boolean>;
    readonly port: number;
    readonly hosts: readonly string[];
    readonly baseDomain: string;
    readonly onError: (error: Error) => void;
}): Promise<HttpExport> {
    const connection = new LinkRpcConnection(options.local.rpcChannel);
    const services = new ForwardableServices(options.local.channel, options.requestDirectoryAccess, options.onError);
    return startHttpExport({
        listen: options.hosts.map(host => ({ host, port: options.port })),
        baseDomain: options.baseDomain,
        getTcpForward: serviceId => connection.service(serviceId).get(computeNodeTcpForwardInterface),
        listServices: () => services.get(),
        listPorts: async serviceId => (await connection.service(serviceId).get(computeNodePortsInterface).listListening({})).ports,
        onError: options.onError,
    });
}

/** Caches the services that implement `tcpForward`; a slow or partial walk returns what it found. */
class ForwardableServices {
    private _cached: { readonly value: HttpExportServiceList; readonly at: number } | undefined;
    private _pending: Promise<HttpExportServiceList> | undefined;

    constructor(
        private readonly _channel: CliConnection['channel'],
        private readonly _requestDirectoryAccess: ((serviceId: string) => Promise<boolean>) | undefined,
        private readonly _onError: (error: Error) => void,
    ) { }

    get(): Promise<HttpExportServiceList> {
        if (this._cached && Date.now() - this._cached.at < SERVICE_LIST_TTL_MS) {
            return Promise.resolve(this._cached.value);
        }
        this._pending ??= this._load().finally(() => { this._pending = undefined; });
        return this._pending;
    }

    private async _load(): Promise<HttpExportServiceList> {
        const explorer = new HubDirectoryExplorer(this._channel, {
            interfaceId: computeNodeTcpForwardInterface.info.id,
            timeoutMs: 5_000,
            unlockGatedDirectory: this._requestDirectoryAccess,
            log: message => this._onError(new Error(message)),
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const walked = await Promise.race([
                explorer.explore(),
                new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), SERVICE_LIST_TIMEOUT_MS); }),
            ]);
            const listings = (walked?.listings ?? explorer.result.listings).filter(listing => listing.serviceId !== '');
            const value: HttpExportServiceList = {
                serviceIds: [...new Set(listings.map(listing => listing.serviceId))],
                complete: walked !== undefined && walked.inaccessible.length === 0,
            };
            this._cached = { value, at: Date.now() };
            return value;
        } finally {
            clearTimeout(timer);
            explorer.dispose();
        }
    }
}
