import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectToHub } from '@hediet/linkrpc/node';
import { readEndpointDiscovery } from './discovery';
import { HubDaemon } from './daemon';
import { managedEndpointsInterface } from './endpointInterface';
import { HubHome } from './paths';
import { findProcHostBinary } from './procHost';

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const procHostBin = findProcHostBinary();

describe.skipIf(!procHostBin)('Rust linkrpc-proc-host handover', () => {
    const cleanup: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const fn of cleanup.splice(0).reverse()) {
            await fn().catch(() => {});
        }
    });

    it('keeps a managed service alive across daemon restart and adopts the same PID', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkrpc-prochost-'));
        cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
        const home = HubHome.at(dir);

        const daemon1 = await HubDaemon.start({ home, procHost: procHostBin });
        let daemon2: HubDaemon | undefined;
        cleanup.push(async () => {
            await daemon2?.shutdown().catch(() => {});
            await daemon1.shutdown().catch(() => {});
        });

        const d1 = readEndpointDiscovery(home.managementFile)!;
        const mgmt1 = await connectToHub({ endpoint: d1.endpoint, token: d1.token ?? '' });
        const ep1 = mgmt1.connection.get(managedEndpointsInterface);
        await ep1.create({
            namespace: 'test',
            id: 'long-lived',
            persistent: true,
            restart: 'always',
            source: {
                kind: 'process',
                rpc: false,
                command: [process.execPath, '-e', 'console.log("alive-before-restart"); setInterval(() => {}, 1000);'],
            },
        });

        let originalPid = 0;
        await vi.waitFor(async () => {
            const list = await ep1.list({ namespace: 'test' });
            const item = list.find(e => e.id === 'long-lived');
            expect(item?.runtime.state).toBe('running');
            expect(item?.runtime.pid).toBeGreaterThan(0);
            originalPid = item!.runtime.pid!;
        }, { timeout: 10_000 });
        mgmt1.close();

        // Shut down daemon 1 in handover mode: service must stay alive.
        await daemon1.shutdown({ preserveServices: true });
        expect(isAlive(originalPid)).toBe(true);

        // Start daemon 2 on the same home: must adopt the exact same PID without restarting it.
        daemon2 = await HubDaemon.start({ home, procHost: procHostBin });
        const d2 = readEndpointDiscovery(home.managementFile)!;
        const mgmt2 = await connectToHub({ endpoint: d2.endpoint, token: d2.token ?? '' });
        const ep2 = mgmt2.connection.get(managedEndpointsInterface);
        await vi.waitFor(async () => {
            const list = await ep2.list({ namespace: 'test' });
            const item = list.find(e => e.id === 'long-lived');
            expect(item?.runtime.state).toBe('running');
            expect(item?.runtime.pid).toBe(originalPid);
            expect(item?.runtime.restarts).toBe(0);
        }, { timeout: 10_000 });
        mgmt2.close();

        // Full shutdown (preserveServices: false) must terminate the service tree.
        await daemon2.shutdown();
        daemon2 = undefined;
        await vi.waitFor(() => expect(isAlive(originalPid)).toBe(false), { timeout: 5_000 });
    }, 30_000);
});
