import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';

export interface TestProcess {
    readonly child: ChildProcessWithoutNullStreams;
    readonly stderr: () => string;
    stop(): Promise<void>;
}

export function startLanguageServer(): Promise<TestProcess> {
    const require = createRequire(import.meta.url);
    const main = require.resolve('vscode-json-languageserver/out/node/jsonServerMain.js');
    return startProcess([main, '--stdio']);
}

export async function startInspector(): Promise<TestProcess & { url: string }> {
    const process = await startProcess([
        '--inspect=127.0.0.1:0',
        '-e',
        'setInterval(() => {}, 1000);',
    ]);
    try {
        const url = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error(
                `Node inspector did not start: ${process.stderr()}`,
            )), 10_000);
            const onData = (): void => {
                const match = /Debugger listening on (ws:\/\/[^\s]+)/.exec(process.stderr());
                if (match) finish(match[1]);
            };
            const onExit = (): void => finish(new Error(
                `Node inspector exited before listening: ${process.stderr()}`,
            ));
            const onError = (error: Error): void => finish(error);
            const finish = (result: Error | string): void => {
                clearTimeout(timer);
                process.child.stderr.off('data', onData);
                process.child.off('exit', onExit);
                process.child.off('error', onError);
                if (result instanceof Error) reject(result);
                else resolve(result);
            };
            process.child.stderr.on('data', onData);
            process.child.once('exit', onExit);
            process.child.once('error', onError);
            onData();
        });
        return { ...process, url };
    } catch (error) {
        await process.stop();
        throw error;
    }
}

async function startProcess(args: string[]): Promise<TestProcess> {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-32_768);
    });
    await once(child, 'spawn');
    return {
        child,
        stderr: () => stderr,
        async stop(): Promise<void> {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
            try {
                await exited;
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
