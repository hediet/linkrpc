import type { DaemonStatus, DesktopState, HubDesktopBridge, LogLine, ServiceStatus } from '../protocol';

const bridge = (window as unknown as { hubDesktop: HubDesktopBridge; }).hubDesktop;
const LOG_REFRESH_MS = 2_000;

/** The management window: renders main-process state and invokes actions. */
class ManagerView {
    private _state: DesktopState | undefined;
    private _logsFor: string | undefined;
    private _logLines: LogLine[] = [];
    private _localError: string | undefined;
    private readonly _editor = new ConfigEditor(message => this._showError(message));

    constructor() {
        bridge.onState(state => this._setState(state));
        void bridge.invoke('getState').then(state => this._setState(state));
        setInterval(() => void this._refreshLogs(), LOG_REFRESH_MS);
        _byId('config').replaceChildren(this._editor.element);
    }

    private _setState(state: DesktopState): void {
        this._state = state;
        this._editor.onStatus(state.status);
        this._render();
    }

    private _render(): void {
        const state = this._state;
        if (!state) return;
        const status = state.connection === 'connected' ? state.status : undefined;
        _byId('header').replaceChildren(...this._header(state, status));
        _byId('banners').replaceChildren(...this._banners(state, status));
        _byId('services').replaceChildren(...this._services(status));
        _byId('hub').replaceChildren(...this._hub(state, status));
        _byId('startup').replaceChildren(...this._startup(state));
        this._renderLogs();
    }

    private _header(state: DesktopState, status: DaemonStatus | undefined): Node[] {
        const busy = state.busy !== undefined;
        const label = status ? 'Running' : state.connection === 'connecting' ? 'Connecting…' : 'Stopped';
        const pillClass = status ? 'state-running' : state.connection === 'connecting' ? 'state-connecting' : 'state-stopped';
        return [
            h('h1', {}, 'LinkRPC Hub'),
            h('span', { class: `pill ${pillClass}` }, state.busy ?? label),
            h('span', { class: 'spacer' }),
            ...(status
                ? [
                    h('button', { disabled: busy, onClick: () => this._invoke(() => bridge.invoke('restartHub')) }, 'Restart'),
                    h('button', { disabled: busy, onClick: () => this._invoke(() => bridge.invoke('stopHub')) }, 'Stop'),
                ]
                : [h('button', { class: 'primary', disabled: busy || state.connection === 'connecting', onClick: () => this._invoke(() => bridge.invoke('startHub')) }, 'Start')]),
        ];
    }

    private _banners(state: DesktopState, status: DaemonStatus | undefined): Node[] {
        const banners: Node[] = [];
        const error = (text: string) => banners.push(h('div', { class: 'banner error' }, text));
        if (state.error) error(state.error);
        if (this._localError) error(this._localError);
        if (status?.config.error) error(`The config file is not applied; the previous configuration keeps running.\n${status.config.error}`);
        if (status?.hub.error) error(`The hub failed to start: ${status.hub.error}`);
        return banners;
    }

    private _services(status: DaemonStatus | undefined): Node[] {
        const title = h('h2', {}, 'Services', h('span', { class: 'spacer' }),
            status ? h('span', { class: 'muted' }, `${status.services.filter(s => s.state === 'running').length} of ${status.services.length} running`) : undefined);
        if (!status) return [title, h('div', { class: 'empty' }, 'Start the hub to manage its services.')];
        if (status.services.length === 0) {
            return [title, h('div', { class: 'empty' }, 'No services configured yet. Add them under "services" in the configuration below.')];
        }
        const rows = status.services.map(service => this._serviceRow(service));
        return [title, h('table', {},
            h('thead', {}, h('tr', {}, ...['Service', 'State', 'PID', 'Restarts', 'Details', ''].map(text => h('th', {}, text)))),
            h('tbody', {}, ...rows))];
    }

    private _serviceRow(service: ServiceStatus): Node {
        const enabled = h('input', {
            type: 'checkbox',
            checked: service.enabled,
            title: service.enabled ? 'Disable (saved in the config)' : 'Enable (saved in the config)',
            onChange: () => this._invoke(() => bridge.invoke('setServiceEnabled', { name: service.name, enabled: !service.enabled })),
        });
        return h('tr', { class: this._logsFor === service.name ? 'selected' : '' },
            h('td', {}, h('div', { class: 'name' }, service.name),
                h('div', { class: 'sub' }, service.description ?? `service ID: ${service.serviceId}`)),
            h('td', {}, h('span', { class: `pill state-${service.state}` }, service.state)),
            h('td', {}, service.pid?.toString() ?? '–'),
            h('td', {}, String(service.restarts)),
            h('td', { class: 'sub' }, _serviceDetails(service)),
            h('td', { class: 'actions' },
                h('label', { class: 'sub', title: 'Enabled services start with the hub' }, enabled, ' enabled'),
                h('button', { class: 'small', disabled: !service.enabled, onClick: () => this._invoke(() => bridge.invoke('restartService', { name: service.name })) }, 'Restart'),
                h('button', { class: 'small', onClick: () => this._showLogs(service.name) }, 'Logs')));
    }

    private _hub(state: DesktopState, status: DaemonStatus | undefined): Node[] {
        const rows: Array<[string, Node | string]> = status
            ? [
                ['Version', status.version],
                ['Process', `pid ${status.pid}, since ${new Date(status.startedAt).toLocaleString()}`],
                ['Endpoint', h('code', {}, status.endpoint)],
                ['Config', h('code', {}, status.configFile)],
                ['Log', h('code', {}, status.logFile)],
                ...status.hub.listeners
                    .filter(listener => listener.address !== status.endpoint)
                    .map((listener): [string, Node] => [`Listener (${listener.type})`, h('code', {}, listener.address)]),
            ]
            : [['Status', state.connection === 'connecting' ? 'Connecting…' : 'Not running']];
        return [
            h('h2', {}, 'Hub'),
            h('dl', {}, ...rows.flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, value)])),
            h('div', { class: 'row' },
                h('button', { onClick: () => this._invoke(() => bridge.invoke('openConfigFile')) }, 'Open Config File'),
                h('button', { disabled: !status, onClick: () => this._invoke(() => bridge.invoke('reloadConfig')) }, 'Reload Config'),
                h('button', { onClick: () => this._invoke(() => bridge.invoke('openLogFile')) }, 'Open Log')),
        ];
    }

    private _startup(state: DesktopState): Node[] {
        const toggle = (label: string, hint: string, checked: boolean, onChange: (value: boolean) => Promise<void>) =>
            h('label', { class: 'toggle' },
                h('input', { type: 'checkbox', checked, onChange: (event: Event) => this._invoke(() => onChange((event.target as HTMLInputElement).checked)) }),
                h('span', {}, label, ' ', h('span', { class: 'muted' }, hint)));
        return [
            h('h2', {}, 'Startup'),
            toggle('Start hub at login', `(${state.startup.hubMechanism})`, state.startup.hub,
                enabled => bridge.invoke('setHubAutostart', { enabled })),
            toggle('Start tray at login', '', state.startup.tray,
                enabled => bridge.invoke('setTrayAutostart', { enabled })),
            h('p', { class: 'muted' }, 'The hub runs independently: closing this window keeps the tray, and quitting the tray keeps the hub running.'),
        ];
    }

    private _showLogs(name: string): void {
        this._logsFor = this._logsFor === name ? undefined : name;
        this._logLines = [];
        this._render();
        void this._refreshLogs();
    }

    private async _refreshLogs(): Promise<void> {
        const name = this._logsFor;
        if (name === undefined || this._state?.connection !== 'connected') return;
        try {
            const lines = await bridge.invoke('getServiceLogs', { name });
            if (this._logsFor !== name) return;
            this._logLines = lines;
            this._renderLogs();
        } catch (error) {
            this._showError(_message(error));
        }
    }

    private _renderLogs(): void {
        const section = _byId('logs');
        const name = this._logsFor;
        section.hidden = name === undefined;
        if (name === undefined) return;
        const pre = h('pre', { class: 'log' }, ...(this._logLines.length === 0
            ? ['No output yet.']
            : this._logLines.map(line => h('div', { class: line.stream },
                `${new Date(line.at).toLocaleTimeString()}  ${line.text}`))));
        section.replaceChildren(
            h('h2', {}, `Logs · ${name}`, h('span', { class: 'spacer' }),
                h('button', { class: 'small', onClick: () => this._showLogs(name) }, 'Close')),
            pre);
        pre.scrollTop = pre.scrollHeight;
    }

    private async _invoke(action: () => Promise<unknown>): Promise<void> {
        this._localError = undefined;
        try {
            await action();
        } catch (error) {
            this._showError(_message(error));
        }
        this._render();
    }

    private _showError(message: string): void {
        this._localError = message;
        this._render();
    }
}

/**
 * Edits the config through the daemon: saves are validated and rejected when
 * the file changed meanwhile. Unmodified text follows external edits.
 */
class ConfigEditor {
    public readonly element: HTMLElement;
    private readonly _textarea = h('textarea', { spellcheck: false });
    private readonly _message = h('span', { class: 'muted' });
    private readonly _saveButton = h('button', { class: 'primary', disabled: true }, 'Save');
    private _revision: string | undefined;
    private _loadedText = '';
    private _connected = false;

    constructor(private readonly _onError: (message: string) => void) {
        this._textarea.addEventListener('input', () => this._updateButtons());
        this._textarea.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                event.preventDefault();
                void this._save();
            }
        });
        this._saveButton.addEventListener('click', () => void this._save());
        this.element = h('div', {},
            h('h2', {}, 'Configuration', h('span', { class: 'spacer' }),
                h('button', { class: 'small', onClick: () => void this._load() }, 'Revert'),
                this._saveButton),
            this._textarea,
            h('div', { class: 'row' }, this._message));
    }

    public onStatus(status: DaemonStatus | undefined): void {
        const wasConnected = this._connected;
        this._connected = status !== undefined;
        this._textarea.disabled = !this._connected;
        if (!this._connected) {
            this._message.textContent = 'Start the hub to edit its configuration here, or open the config file directly.';
            this._updateButtons();
            return;
        }
        const externallyChanged = status!.config.revision !== undefined && status!.config.revision !== this._revision;
        if (!wasConnected || (externallyChanged && !this._dirty)) void this._load();
    }

    private get _dirty(): boolean {
        return this._textarea.value !== this._loadedText;
    }

    private async _load(): Promise<void> {
        try {
            const document = await bridge.invoke('getConfig');
            this._revision = document.revision;
            this._loadedText = document.text;
            this._textarea.value = document.text;
            this._message.textContent = document.path;
        } catch (error) {
            this._onError(_message(error));
        }
        this._updateButtons();
    }

    private async _save(): Promise<void> {
        if (!this._dirty || this._revision === undefined) return;
        const text = this._textarea.value;
        try {
            const { revision } = await bridge.invoke('saveConfig', { text, expectedRevision: this._revision });
            this._revision = revision;
            this._loadedText = text;
            this._message.textContent = `Saved and applied at ${new Date().toLocaleTimeString()}.`;
        } catch (error) {
            this._message.textContent = `Not saved: ${_message(error)}`;
        }
        this._updateButtons();
    }

    private _updateButtons(): void {
        this._saveButton.disabled = !this._connected || !this._dirty;
    }
}

function _serviceDetails(service: ServiceStatus): string {
    if (service.error) return service.error;
    if (service.state === 'running') return `${service.connections} hub connection${service.connections === 1 ? '' : 's'}`;
    if (service.lastExit) {
        const how = service.lastExit.signal ? `killed by ${service.lastExit.signal}` : `exit code ${service.lastExit.code}`;
        return `last ${how} at ${new Date(service.lastExit.at).toLocaleTimeString()}`;
    }
    return '';
}

type Child = Node | string | undefined | false;
type Props = Record<string, unknown> & { class?: string; };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined) continue;
        if (key === 'class') element.className = value as string;
        else if (key.startsWith('on') && typeof value === 'function') {
            element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (key in element) (element as unknown as Record<string, unknown>)[key] = value;
        else element.setAttribute(key, String(value));
    }
    for (const child of children) {
        if (child !== undefined && child !== false) element.append(child);
    }
    return element;
}

function _byId(id: string): HTMLElement {
    return document.getElementById(id)!;
}

function _message(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

new ManagerView();
