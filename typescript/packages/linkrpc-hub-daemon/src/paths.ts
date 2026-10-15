import { createHash, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

/** Overrides every hub location with one directory (tests, portable installs). */
export const LINKRPC_HUB_HOME_VAR = 'LINKRPC_HUB_HOME';

/** Unix domain socket paths longer than this fail to bind on macOS. */
const MAX_UNIX_SOCKET_PATH = 103;

/**
 * Where one per-user hub keeps its configuration, state, and local sockets.
 * All daemon, CLI, and desktop processes of a user resolve the same home.
 */
export class HubHome {
    /**
     * The per-user default:
     * - Windows: `%LOCALAPPDATA%\linkrpc\hub`
     * - macOS: `~/Library/Application Support/linkrpc/hub`
     * - Linux: `$XDG_CONFIG_HOME/linkrpc/hub` (config), `$XDG_STATE_HOME/linkrpc/hub`
     *   (state), `$XDG_RUNTIME_DIR/linkrpc-hub` (sockets)
     *
     * `LINKRPC_HUB_HOME` places everything under one directory instead.
     */
    public static resolve(
        env: NodeJS.ProcessEnv = process.env,
        platform: NodeJS.Platform = process.platform,
        homedir: string = os.homedir(),
    ): HubHome {
        const p = platform === 'win32' ? path.win32 : path.posix;
        const override = env[LINKRPC_HUB_HOME_VAR];
        if (override) return HubHome.at(override, platform);
        if (platform === 'win32') {
            const base = p.join(env.LOCALAPPDATA ?? p.join(homedir, 'AppData', 'Local'), 'linkrpc', 'hub');
            return new HubHome(p.join(base, 'config.json'), base, p.join(base, 'run'), platform, undefined);
        }
        if (platform === 'darwin') {
            const base = p.join(homedir, 'Library', 'Application Support', 'linkrpc', 'hub');
            return new HubHome(p.join(base, 'config.json'), base, p.join(base, 'run'), platform, undefined);
        }
        const configDir = p.join(env.XDG_CONFIG_HOME || p.join(homedir, '.config'), 'linkrpc', 'hub');
        const stateDir = p.join(env.XDG_STATE_HOME || p.join(homedir, '.local', 'state'), 'linkrpc', 'hub');
        const runtimeDir = env.XDG_RUNTIME_DIR ? p.join(env.XDG_RUNTIME_DIR, 'linkrpc-hub') : p.join(stateDir, 'run');
        return new HubHome(p.join(configDir, 'config.json'), stateDir, runtimeDir, platform, undefined);
    }

    /** A custom home with config, state, and sockets all below `dir`. */
    public static at(dir: string, platform: NodeJS.Platform = process.platform): HubHome {
        const p = platform === 'win32' ? path.win32 : path.posix;
        return new HubHome(p.join(dir, 'config.json'), dir, p.join(dir, 'run'), platform, dir);
    }

    private constructor(
        public readonly configFile: string,
        public readonly stateDir: string,
        /** Private (0700) directory for Unix sockets. Unused on Windows. */
        public readonly runtimeDir: string,
        private readonly _platform: NodeJS.Platform,
        /** The directory of a custom home (`--home`, `LINKRPC_HUB_HOME`); `undefined` for the default. */
        public readonly customDir: string | undefined,
    ) { }

    private get _path(): path.PlatformPath {
        return this._platform === 'win32' ? path.win32 : path.posix;
    }

    public get configDir(): string {
        return this._path.dirname(this.configFile);
    }

    /** JSON Schema written next to the config for editor validation. */
    public get configSchemaFile(): string {
        return this._path.join(this.configDir, 'config.schema.json');
    }

    /** Endpoint + token for applications; present while the daemon runs. */
    public get discoveryFile(): string {
        return this._path.join(this.stateDir, 'hub.json');
    }

    /** Endpoint + token for the management API; present while the daemon runs. */
    public get managementFile(): string {
        return this._path.join(this.stateDir, 'management.json');
    }

    public get logFile(): string {
        return this._path.join(this.stateDir, 'daemon.log');
    }

    /** Persistent managed identities of services. */
    public get identityDir(): string {
        return this._path.join(this.stateDir, 'identities');
    }

    /** Distinguishes OS registrations (autostart entries) of custom homes from the default one. */
    public get instanceName(): string {
        if (this.customDir === undefined) return 'linkrpc-hub';
        return `linkrpc-hub-${createHash('sha256').update(this.customDir).digest('hex').slice(0, 8)}`;
    }

    /**
     * The single-instance lock endpoint. Fixed per home so that a second daemon
     * for the same home fails to bind it.
     */
    public get lockEndpoint(): string {
        if (this._platform === 'win32') {
            const key = createHash('sha256').update(this.stateDir.toLowerCase()).digest('hex').slice(0, 24);
            return `\\\\.\\pipe\\linkrpc-hub-lock-${key}`;
        }
        return this._unixSocketPath('daemon.lock');
    }

    /**
     * A fresh endpoint for a daemon listener. Windows pipe names are random
     * (pipes are a global namespace); Unix sockets live in the private runtime dir.
     */
    public allocEndpoint(name: string): string {
        if (this._platform === 'win32') return `\\\\.\\pipe\\linkrpc-hub-${name}-${randomUUID()}`;
        return this._unixSocketPath(`${name}.sock`);
    }

    private _unixSocketPath(name: string): string {
        const socketPath = this._path.join(this.runtimeDir, name);
        if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH) {
            throw new Error(`socket path is too long for this platform: ${socketPath}`);
        }
        return socketPath;
    }
}
