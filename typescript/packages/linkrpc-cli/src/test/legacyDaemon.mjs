import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineInterface, LinkRpcConnection, requestType } from '@hediet/linkrpc';
import { SocketServer } from '@hediet/linkrpc-hub/hub/server/node';
import { z } from 'zod';

const home = process.argv[2];
fs.mkdirSync(home, { recursive: true });
const file = path.join(home, 'management.json');
const server = await SocketServer.start();
const management = defineInterface({ id: 'linkrpc.hubDaemon' }, {
    getStatus: requestType(z.object({}), z.unknown()),
    shutdown: requestType(z.object({}), z.object({})),
});
server.setConnectionHandler(transport => {
    LinkRpcConnection.fromTransport(transport).register(management, {
        getStatus: () => ({
            pid: process.pid, version: 'legacy', startedAt: Date.now(), endpoint: server.endpoint,
            configFile: path.join(home, 'config.json'), logFile: path.join(home, 'daemon.log'),
            config: {}, hub: { startedAt: Date.now(), listeners: [] }, services: [],
        }),
        shutdown: () => {
            setTimeout(() => {
                fs.rmSync(file, { force: true });
                server.dispose();
                process.exit(0);
            }, 10);
            return {};
        },
    });
});
fs.writeFileSync(file, JSON.stringify({ version: 1, pid: process.pid, endpoint: server.endpoint }));
