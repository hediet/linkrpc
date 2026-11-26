import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { killProcessTree, releaseProcessTree, trackProcessTree } from './processTree';

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

it.skipIf(process.platform !== 'win32')('kills orphaned grandchildren via Windows Job Object on releaseProcessTree', async () => {
    // Parent spawns a detached long-lived grandchild, prints grandchild PID, then exits.
    const parent = spawn(process.execPath, ['-e', `
        const { spawn } = require('node:child_process');
        const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
        gc.unref();
        console.log(String(gc.pid));
        setTimeout(() => process.exit(0), 2000);
    `], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

    const parentPid = parent.pid!;
    trackProcessTree(parentPid);

    let out = '';
    parent.stdout!.on('data', chunk => { out += chunk.toString('utf8'); });
    await vi.waitFor(() => expect(Number(out.trim())).toBeGreaterThan(0), { timeout: 5000 });
    const grandchildPid = Number(out.trim());
    expect(isAlive(grandchildPid)).toBe(true);

    // Wait for parent to exit on its own, leaving grandchild orphaned.
    await new Promise<void>(resolve => parent.once('exit', () => resolve()));
    expect(isAlive(grandchildPid)).toBe(true);

    // Closing the Job Object terminates the orphaned grandchild even though parent is already gone.
    releaseProcessTree(parentPid);
    await vi.waitFor(() => expect(isAlive(grandchildPid)).toBe(false), { timeout: 5000 });
}, 15_000);

it.skipIf(process.platform !== 'win32')('kills child and grandchild on killProcessTree', async () => {
    const parent = spawn(process.execPath, ['-e', `
        const { spawn } = require('node:child_process');
        const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        console.log(String(gc.pid));
        setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

    const parentPid = parent.pid!;
    trackProcessTree(parentPid);

    let out = '';
    parent.stdout!.on('data', chunk => { out += chunk.toString('utf8'); });
    await vi.waitFor(() => expect(Number(out.trim())).toBeGreaterThan(0), { timeout: 5000 });
    const grandchildPid = Number(out.trim());

    await killProcessTree(parentPid);
    await vi.waitFor(() => expect(isAlive(parentPid)).toBe(false), { timeout: 5000 });
    await vi.waitFor(() => expect(isAlive(grandchildPid)).toBe(false), { timeout: 5000 });
}, 15_000);
