import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LinkRpcConnection } from '@hediet/linkrpc';
import { connectToHub } from '@hediet/linkrpc/node';
import { parseHubConfig, runHub } from '@hediet/linkrpc-hub';
import {
    computeNodeCommandInterface,
    computeNodePowerInterface,
    computeNodeStatusInterface,
    type ComputeNodeKeepAwakeEvent,
} from '@hediet/linkrpc-infra/compute-node';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
/** Platforms whose sleep prevention works without extra permissions (Linux needs polkit authorization). */
const canKeepAwake = process.platform === 'darwin' || process.platform === 'win32';

it('serves the compute node under the granted service ID', async () => {
    await withComputeNode(async ({ service }) => {
        const status = await service.get(computeNodeStatusInterface).getStatus({});
        expect(status.hostname).toBe(os.hostname());
        const result = await service.get(computeNodeCommandInterface).run({ command: process.execPath, args: ['-e', 'console.log("hi")'] });
        expect(result).toMatchObject({ exitCode: 0, stdout: 'hi\n' });
    });
});

it.runIf(canKeepAwake)('keeps the machine awake until the caller disconnects', async () => {
    await withComputeNode(async ({ service, client }) => {
        const { helperPid } = await startKeepAwake(service);
        expect(isRunning(helperPid)).toBe(true);

        client.close();
        await waitUntil(() => !isRunning(helperPid));
    });
});

it.runIf(canKeepAwake)('stops keeping the machine awake when the compute node exits', async () => {
    await withComputeNode(async ({ service, computeNode }) => {
        const { helperPid } = await startKeepAwake(service);

        computeNode.kill('SIGKILL');
        await waitUntil(() => !isRunning(helperPid));
    });
});

type ComputeNodeService = ReturnType<LinkRpcConnection['service']>;

/** Runs the CLI as a hub daemon would and connects a client to it through the hub. */
async function withComputeNode(
    test: (context: { service: ComputeNodeService; client: { close(): void; }; computeNode: ChildProcess; }) => Promise<void>,
): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrcn-'));
    const hub = await runHub({ config: parseHubConfig({ hubServiceId: 'me/pc', forwardChecking: false }), identityStoreDir: dir, log: () => { } });
    const serviceSocket = await hub.openParticipantSocket({ provision: { grantedServiceId: 'me/pc/compute' } });
    const computeNode = spawn(process.execPath, ['--import', 'tsx', cli], { env: { ...process.env, ...serviceSocket.env }, stdio: 'ignore' });
    const clientSocket = await hub.openParticipantSocket({ provision: {} });
    const client = await connectToHub({ endpoint: clientSocket.path, token: clientSocket.token });
    try {
        const service = client.connection.service('me/pc/compute');
        await waitUntilServed(service);
        await test({ service, client, computeNode });
    } finally {
        client.close();
        computeNode.kill();
        hub.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function waitUntilServed(service: ComputeNodeService): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await service.get(computeNodeStatusInterface).getStatus({});
            return;
        } catch (error) {
            if (attempt > 200) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

/** Starts a keep-awake call that stays open, and resolves once sleep prevention is in effect. */
function startKeepAwake(service: ComputeNodeService): Promise<ComputeNodeKeepAwakeEvent> {
    return new Promise((resolve, reject) => {
        service.get(computeNodePowerInterface)
            .keepAwake({ reason: 'linkrpc-compute-node test' }, { onMessage: resolve })
            .then(result => reject(new Error(`keepAwake ended early: ${JSON.stringify(result)}`)), reject);
    });
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
