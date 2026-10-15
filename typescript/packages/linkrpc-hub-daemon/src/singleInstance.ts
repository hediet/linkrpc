import * as fs from 'node:fs';
import * as net from 'node:net';

export class AlreadyRunningError extends Error {
    constructor() {
        super('The LinkRPC hub daemon is already running.');
    }
}

/**
 * Process-lifetime mutex: a bound local socket. The OS releases it when the
 * process dies, so no stale lock survives a crash (a stale Unix socket file is
 * detected by a refused probe connection and replaced).
 */
export class SingleInstanceLock {
    public static async acquire(endpoint: string): Promise<SingleInstanceLock> {
        try {
            return new SingleInstanceLock(await _listen(endpoint), endpoint);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        }
        if (process.platform === 'win32' || await _isAlive(endpoint)) throw new AlreadyRunningError();
        fs.rmSync(endpoint, { force: true });
        try {
            return new SingleInstanceLock(await _listen(endpoint), endpoint);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new AlreadyRunningError();
            throw error;
        }
    }

    private constructor(
        private readonly _server: net.Server,
        private readonly _endpoint: string,
    ) { }

    public dispose(): void {
        this._server.close();
        if (process.platform !== 'win32') fs.rmSync(this._endpoint, { force: true });
    }
}

function _listen(endpoint: string): Promise<net.Server> {
    return new Promise((resolve, reject) => {
        const server = net.createServer(socket => socket.destroy());
        server.once('error', reject);
        server.listen(endpoint, () => {
            server.off('error', reject);
            resolve(server);
        });
    });
}

function _isAlive(endpoint: string): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.connect(endpoint);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}
