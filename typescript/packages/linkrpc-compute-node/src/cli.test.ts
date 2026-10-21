import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectToHub } from '@hediet/linkrpc/node';
import { parseHubConfig, runHub } from '@hediet/linkrpc-hub';
import { computeNodeCommandInterface, computeNodeStatusInterface } from '@hediet/linkrpc-infra/compute-node';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));

it('serves the compute node under the granted service ID', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrcn-'));
    const hub = await runHub({ config: parseHubConfig({ hubServiceId: 'me/pc', forwardChecking: false }), identityStoreDir: dir, log: () => { } });
    const serviceSocket = await hub.openParticipantSocket({ provision: { grantedServiceId: 'me/pc/compute' } });
    const child = spawn(process.execPath, ['--import', 'tsx', cli], { env: { ...process.env, ...serviceSocket.env }, stdio: 'ignore' });
    const clientSocket = await hub.openParticipantSocket({ provision: {} });
    const client = await connectToHub({ endpoint: clientSocket.path, token: clientSocket.token });
    try {
        const service = client.connection.service('me/pc/compute');
        let status;
        for (let attempt = 0; status === undefined; attempt++) {
            try {
                status = await service.get(computeNodeStatusInterface).getStatus({});
            } catch (error) {
                if (attempt > 200) throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        expect(status.hostname).toBe(os.hostname());
        const result = await service.get(computeNodeCommandInterface).run({ command: process.execPath, args: ['-e', 'console.log("hi")'] });
        expect(result).toMatchObject({ exitCode: 0, stdout: 'hi\n' });
    } finally {
        client.close();
        child.kill();
        hub.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
