#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { LinkRpcConnection } from '@hediet/linkrpc';
import { createManagedSigningChannel } from '@hediet/linkrpc/hub/common';
import { connectToHub, openHubChannel } from '@hediet/linkrpc/node';
import { hostVncDesktop } from './service';
import { startDesktopViewer } from './viewer';

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        endpoint: { type: 'string' },
        service: { type: 'string' },
        source: { type: 'string' },
        dpi: { type: 'string' },
        title: { type: 'string', default: 'Desktop' },
        interface: { type: 'string' },
        instance: { type: 'string' },
        params: { type: 'string', default: '{}' },
        transport: { type: 'string', default: 'webrtc' },
        help: { type: 'boolean' },
        'managed-identity': { type: 'boolean' },
        'negotiate-caps': { type: 'boolean' },
    },
});

async function main() {
    if (values.help) {
        console.log(`linkrpc-desktop serve --source ws://127.0.0.1:6080/websockify [--dpi http://127.0.0.1:6080/api/dpi]
linkrpc-desktop view --service SERVICE [--interface ID --instance NAME --params '{}' --transport webrtc|hub]
Both commands use --endpoint or LINKRPC_ENDPOINT and LINKRPC_TOKEN. Serve claims the hub-granted namespace.
--managed-identity signs with a provisioned identity. --negotiate-caps explicitly enables interactive capability requests.`);
        return;
    }
    const control = new AbortController();
    const stop = () => control.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (positionals[0] === 'serve') {
        if (!values.source) throw new Error('serve requires --source (trusted WebSocket RFB endpoint)');
        const host = await hostVncDesktop({
            title: values.title!, websocketUrl: values.source, dpiUrl: values.dpi,
        }, {
            endpoint: values.endpoint ? { endpoint: values.endpoint } : undefined,
            serviceId: values.service, signal: control.signal, managedIdentity: values['managed-identity'],
        });
        console.log('Desktop service registered');
        await host.done;
    } else if (positionals[0] === 'view') {
        if (!values.service) throw new Error('view requires --service');
        if (values.transport !== 'webrtc' && values.transport !== 'hub') throw new Error('Expected --transport webrtc or hub');
        console.log('Discovering desktop template...');
        const viewer = await startDesktopViewer({
            connect: async () => {
                if (!values['managed-identity']) return connectToHub({ endpoint: values.endpoint });
                const raw = await openHubChannel({ endpoint: values.endpoint });
                try {
                    const signed = await createManagedSigningChannel(raw, {
                        autoNegotiateCaps: values['negotiate-caps'] === true, consumer: { name: 'LinkRPC Desktop Viewer' },
                    });
                    return { connection: new LinkRpcConnection(signed.channel), close: () => raw.close() };
                } catch (error) { raw.close(); throw error; }
            },
            serviceId: values.service, params: JSON.parse(values.params!),
            interfaceId: values.interface, instance: values.instance,
            transport: values.transport,
        });
        console.log(viewer.url);
        try {
            if (!control.signal.aborted) await new Promise<void>(resolve => control.signal.addEventListener('abort', () => resolve(), { once: true }));
        } finally { await viewer.dispose(); }
    } else {
        throw new Error('Expected serve or view; use --help');
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
