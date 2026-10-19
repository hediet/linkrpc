import { createInterface, type Interface, type Key } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

type ConsoleInput = Readable & {
    readonly isTTY?: boolean;
    readonly isRaw?: boolean;
    setRawMode?(mode: boolean): unknown;
    unref?(): unknown;
};

export class ServiceConsoleInput {
    private readonly _readline: Interface | undefined;
    private readonly _wasRaw: boolean;

    constructor(
        private readonly _input: ConsoleInput,
        output: Writable,
        private readonly _send: (data: string) => void,
        private readonly _interrupt: () => void,
        private readonly _close: () => void,
    ) {
        this._wasRaw = _input.isRaw ?? false;
        if (_input.isTTY) {
            this._readline = createInterface({ input: _input, output, terminal: true, prompt: '', historySize: 0 });
            this._readline.on('line', this._onLine);
            this._readline.on('SIGINT', _interrupt);
            this._readline.on('close', _close);
            _input.on('keypress', this._onKeypress);
        } else {
            _input.on('data', this._onData);
            _input.resume();
        }
    }

    dispose(): void {
        if (this._readline) {
            this._readline.removeListener('line', this._onLine);
            this._readline.removeListener('SIGINT', this._interrupt);
            this._readline.removeListener('close', this._close);
            this._readline.close();
            this._input.removeListener('keypress', this._onKeypress);
            this._input.setRawMode?.(this._wasRaw);
        } else {
            this._input.removeListener('data', this._onData);
        }
        this._input.pause();
        // Readline can already have paused stdin during EOF; release any remaining native read handle.
        this._input.unref?.();
    }

    private readonly _onLine = (line: string): void => { this._send(line + '\n'); };
    private readonly _onKeypress = (_text: string | undefined, key: Key): void => {
        if (key.sequence === '\x1d') this._close();
    };
    private readonly _onData = (data: Buffer): void => {
        if (data.includes(29)) this._close();
        else this._send(data.toString('utf8'));
    };
}
