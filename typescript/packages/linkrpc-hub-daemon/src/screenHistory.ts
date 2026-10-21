import * as headlessModule from '@xterm/headless';
import * as serializeModule from '@xterm/addon-serialize';
import {
    encodeConsoleData,
    type ConsoleHistory,
    type ConsoleRecord,
    type ConsoleServerMessage,
    type ConsoleSize,
} from '@hediet/linkrpc-infra/console';

// Node loads these packages as CommonJS (exports on `default`); bundlers may pick their ESM builds.
const { Terminal } = commonJsInterop(headlessModule);
const { SerializeAddon } = commonJsInterop(serializeModule);

/**
 * Replays a TTY as its current screen and scrollback instead of raw bytes, so
 * that full-screen programs render correctly for attachments that join late.
 */
export class ScreenHistory implements ConsoleHistory {
    private readonly _terminal: InstanceType<typeof Terminal>;
    private readonly _serializer = new SerializeAddon();

    constructor(size: ConsoleSize, scrollback = 1000) {
        this._terminal = new Terminal({ cols: size.cols, rows: size.rows, scrollback, allowProposedApi: true });
        this._terminal.loadAddon(this._serializer);
    }

    append(record: ConsoleRecord): void {
        if (record.type === 'output') this._terminal.write(record.data);
    }

    resize(size: ConsoleSize): void {
        this._terminal.resize(size.cols, size.rows);
    }

    snapshot(): Promise<readonly ConsoleServerMessage[]> {
        // Writes parse in order: this callback runs after earlier output and before later output.
        return new Promise(resolve => this._terminal.write('', () => {
            const screen = this._serializer.serialize();
            resolve([{ t: 'screen', data: encodeConsoleData(new TextEncoder().encode(screen)) }]);
        }));
    }

    dispose(): void {
        this._terminal.dispose();
    }
}

function commonJsInterop<T extends object>(module: T): T {
    return (module as { default?: T }).default ?? module;
}
