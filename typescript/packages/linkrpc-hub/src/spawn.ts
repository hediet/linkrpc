/**
 * Minimal child-spawn helper used by the hub engine. Kept free of the CLI's
 * connection machinery so the engine has no heavy dependencies. (Socket-path
 * allocation lives on {@link SocketServer.allocSocketPath}.)
 */
import { type EndpointCommand } from '@hediet/linkrpc/node';
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';

/**
 * Spawn a child from a command spec. `{ command }` is run through the OS shell
 * (so quoting / splitting follows the shell's rules); `{ argv }` is run
 * directly (no shell), except on Windows where `.cmd` shims need one.
 */
export function spawnCommand(command: EndpointCommand, options: SpawnOptions): ChildProcess {
    if ('argv' in command) {
        const [bin, ...args] = command.argv;
        if (!bin) throw new Error('spawnCommand: empty argv command');
        return spawn(bin, args, { ...options, shell: process.platform === 'win32' });
    }
    return spawn(command.command, { ...options, shell: true });
}
