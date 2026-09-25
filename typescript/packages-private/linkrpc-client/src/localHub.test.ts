import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { startLocalOverlay } from './localHub';

const lifecycleChild = fileURLToPath(new URL('./fixtures/lifecycleChild.mjs', import.meta.url));

describe('cmd-env overlay startup', () => {
    it('rejects invalid spawn arguments', async () => {
        await expect(startLocalOverlay({
            command: { argv: [] },
            provisionSlot: undefined,
            grantedNamespace: 'local',
        })).rejects.toThrow('empty argv');
    });

    it('rejects a spawn failure without waiting for readiness', async () => {
        await expect(startLocalOverlay({
            command: { argv: ['linkrpc-nonexistent-child-executable'] },
            provisionSlot: undefined,
            grantedNamespace: 'local',
        })).rejects.toThrow(/ENOENT|code 1/);
    });

    it('rejects a child that exits before connecting', async () => {
        await expect(startLocalOverlay({
            command: { argv: [process.execPath, lifecycleChild, 'exit'] },
            provisionSlot: undefined,
            grantedNamespace: 'local',
        })).rejects.toThrow('code 23');
    });

    it('times out and tears down a child that does not connect', async () => {
        await expect(startLocalOverlay({
            command: { argv: [process.execPath, lifecycleChild, 'idle'] },
            provisionSlot: undefined,
            grantedNamespace: 'local',
            readyTimeoutMs: 30,
        })).rejects.toThrow('timed out waiting for cmd-env child to connect');
    });
});
