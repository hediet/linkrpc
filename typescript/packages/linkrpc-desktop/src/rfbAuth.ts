import { Duplex } from 'node:stream';
import { desEncryptBlock } from './des';

const RFB_VERSION = Buffer.from('RFB 003.008\n', 'latin1');
const SECURITY_NONE = 1;
const SECURITY_VNC_AUTH = 2;

/**
 * Authenticates to an RFB server with a trusted, administrator-configured password, then
 * presents the viewer an already authenticated RFB 3.8 server that offers only security
 * type None. The password never reaches the viewer.
 */
export class PreauthenticatedRfbStream extends Duplex {
    private _state: 'server-handshake' | 'client-version' | 'client-security' | 'open' = 'server-handshake';
    private _serverBytes = Buffer.alloc(0);
    private _serverWaiter: { readonly length: number; readonly resolve: (bytes: Buffer) => void } | undefined;
    private _clientBytes = Buffer.alloc(0);

    constructor(private readonly _source: Duplex, private readonly _password: string) {
        super();
        _source.on('data', (chunk: Buffer) => this._onSourceData(chunk));
        _source.on('end', () => this.push(null));
        _source.on('error', error => this.destroy(error));
        _source.on('close', () => this.destroy(this._state === 'open' ? undefined : new Error('VNC source closed during authentication')));
        this._authenticate().then(() => {
            this._state = 'client-version';
            this.push(RFB_VERSION);
            this._processClientBytes();
        }).catch(error => this.destroy(error instanceof Error ? error : new Error(String(error))));
    }

    private async _authenticate(): Promise<void> {
        const version = (await this._readServer(12)).toString('latin1');
        const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(version);
        // RFB 3.8 is the first version that reports a SecurityResult for every security type.
        if (!match || Number(match[1]) !== 3 || Number(match[2]) < 8) {
            throw new Error(`Unsupported RFB server version ${JSON.stringify(version.trim())}`);
        }
        this._source.write(RFB_VERSION);
        const count = (await this._readServer(1))[0];
        if (count === 0) throw new Error(`VNC source refused the connection: ${await this._readReason()}`);
        const types = [...await this._readServer(count)];
        if (types.includes(SECURITY_NONE)) {
            this._source.write(Buffer.from([SECURITY_NONE]));
        } else if (types.includes(SECURITY_VNC_AUTH)) {
            this._source.write(Buffer.from([SECURITY_VNC_AUTH]));
            this._source.write(vncAuthResponse(this._password, await this._readServer(16)));
        } else {
            throw new Error(`VNC source offers no supported security type (${types.join(', ')})`);
        }
        if ((await this._readServer(4)).readUInt32BE(0) !== 0) {
            throw new Error(`VNC authentication failed: ${await this._readReason()}`);
        }
    }

    private async _readReason(): Promise<string> {
        const length = (await this._readServer(4)).readUInt32BE(0);
        return (await this._readServer(length)).toString('utf8');
    }

    private _readServer(length: number): Promise<Buffer> {
        return new Promise(resolve => {
            this._serverWaiter = { length, resolve };
            this._serveWaiter();
        });
    }

    private _onSourceData(chunk: Buffer): void {
        if (this._state === 'open') {
            if (!this.push(chunk)) this._source.pause();
            return;
        }
        this._serverBytes = Buffer.concat([this._serverBytes, chunk]);
        this._serveWaiter();
    }

    private _serveWaiter(): void {
        const waiter = this._serverWaiter;
        if (!waiter || this._serverBytes.length < waiter.length) return;
        this._serverWaiter = undefined;
        const bytes = this._serverBytes.subarray(0, waiter.length);
        this._serverBytes = this._serverBytes.subarray(waiter.length);
        waiter.resolve(bytes);
    }

    private _processClientBytes(): void {
        if (this._state === 'client-version' && this._clientBytes.length >= RFB_VERSION.length) {
            const version = this._clientBytes.subarray(0, RFB_VERSION.length);
            if (!version.equals(RFB_VERSION)) throw new Error(`Viewer must speak RFB 3.8, got ${JSON.stringify(version.toString('latin1').trim())}`);
            this._clientBytes = this._clientBytes.subarray(RFB_VERSION.length);
            this._state = 'client-security';
            this.push(Buffer.from([1, SECURITY_NONE]));
        }
        if (this._state === 'client-security' && this._clientBytes.length >= 1) {
            if (this._clientBytes[0] !== SECURITY_NONE) throw new Error(`Viewer chose unsupported security type ${this._clientBytes[0]}`);
            const pending = this._clientBytes.subarray(1);
            this._clientBytes = Buffer.alloc(0);
            this._state = 'open';
            this.push(Buffer.alloc(4));
            if (pending.length) this._source.write(pending);
            if (this._serverBytes.length) this.push(this._serverBytes);
            this._serverBytes = Buffer.alloc(0);
        }
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (this._state === 'open') {
            this._source.write(chunk, callback);
            return;
        }
        this._clientBytes = Buffer.concat([this._clientBytes, chunk]);
        try {
            if (this._state !== 'server-handshake') this._processClientBytes();
            callback();
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    override _read(): void {
        this._source.resume();
    }

    override _final(callback: (error?: Error | null) => void): void {
        this._source.end();
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this._source.destroy();
        callback(error);
    }
}

/** The RFB "VNC Authentication" response: DES-ECB of the challenge, keyed by the bit-reversed password bytes. */
export function vncAuthResponse(password: string, challenge: Uint8Array): Buffer {
    const passwordBytes = Buffer.from(password, 'utf8');
    const key = new Uint8Array(8);
    for (let i = 0; i < 8; i++) key[i] = reverseBits(passwordBytes[i] ?? 0);
    return Buffer.concat([desEncryptBlock(key, challenge.subarray(0, 8)), desEncryptBlock(key, challenge.subarray(8, 16))]);
}

function reverseBits(byte: number): number {
    let result = 0;
    for (let i = 0; i < 8; i++) result |= ((byte >> i) & 1) << (7 - i);
    return result;
}
