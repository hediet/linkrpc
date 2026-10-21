import type { CallFilter, CallLogLevel, CallRecord, DaemonStatus } from '../protocol';
import { bridge, errorMessage, h } from './dom';

const PAGE = 200;
const MAX_SHOWN = 500;
const FILTER_DEBOUNCE_MS = 300;

const LEVELS: ReadonlyArray<readonly [CallLogLevel, string]> = [
    ['error', 'Failed calls'],
    ['warn', 'Failed calls'],
    ['info', 'All requests'],
    ['debug', 'Requests and notifications'],
    ['trace', 'Everything, with stream frames'],
];

/**
 * Recorded hub calls, read from the daemon's call-log files: recording toggle
 * and level (persisted in the config), filters, a live tail, and the folder.
 */
export class CallsView {
    public readonly element: HTMLElement;
    private readonly _calls = new Map<string, CallRecord>();
    private readonly _recording = h('input', { type: 'checkbox' });
    private readonly _level = h('select', { title: 'What to record' });
    private readonly _text = h('input', { type: 'search', placeholder: 'Filter: method, caller, target, principal, or error' });
    private readonly _errorsOnly = h('input', { type: 'checkbox' });
    private readonly _live = h('input', { type: 'checkbox', checked: true });
    private readonly _info = h('div', { class: 'row muted' });
    private readonly _table = h('div', { class: 'calls' });
    private _status: DaemonStatus | undefined;
    private _selected: string | undefined;
    private _truncated = false;
    private _loads = 0;
    private _debounce: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly _onError: (message: string) => void) {
        this._recording.addEventListener('change', () => void this._setLevel(this._recording.checked ? this._chosenLevel() : 'off'));
        this._level.addEventListener('change', () => void this._setLevel(this._chosenLevel()));
        this._text.addEventListener('input', () => {
            clearTimeout(this._debounce);
            this._debounce = setTimeout(() => void this._reload(), FILTER_DEBOUNCE_MS);
        });
        this._errorsOnly.addEventListener('change', () => void this._reload());
        this._live.addEventListener('change', () => void this._reload());
        bridge.onCall(call => {
            this._calls.set(call.id, call);
            this._renderTable();
        });
        this.element = h('div', {},
            h('h2', {}, 'Calls', h('span', { class: 'spacer' }),
                h('label', { class: 'sub', title: 'Saved in the config as callLog.level' }, this._recording, ' Record calls'),
                this._level,
                h('button', { class: 'small', onClick: () => void this._run(() => bridge.invoke('openCallLogFolder')) }, 'Open Folder')),
            h('div', { class: 'row toolbar' },
                this._text,
                h('label', { class: 'sub' }, this._errorsOnly, ' Errors only'),
                h('label', { class: 'sub', title: 'Show new calls as they are recorded' }, this._live, ' Live'),
                h('button', { class: 'small', onClick: () => void this._reload() }, 'Refresh')),
            this._table,
            this._info);
    }

    public onStatus(status: DaemonStatus | undefined): void {
        const wasConnected = this._status !== undefined;
        this._status = status;
        const level = status?.callLog.level ?? 'off';
        this._recording.checked = level !== 'off';
        this._recording.disabled = !status;
        this._level.replaceChildren(...LEVELS
            .filter(([value]) => value !== 'warn' || level === 'warn')
            .map(([value, label]) => h('option', { value, selected: value === level }, label)));
        if (level === 'off') this._level.value = 'info';
        this._level.disabled = !status || level === 'off';
        if (status && !wasConnected) void this._reload();
        this._renderInfo();
    }

    private _chosenLevel(): CallLogLevel {
        return this._level.value as CallLogLevel;
    }

    private async _setLevel(level: CallLogLevel): Promise<void> {
        await this._run(() => bridge.invoke('setCallLogLevel', { level }));
    }

    private _filter(): CallFilter {
        const text = this._text.value.trim();
        return {
            ...(text ? { text } : {}),
            ...(this._errorsOnly.checked ? { minLevel: 'error' as const } : {}),
        };
    }

    /** Restart the live watch and read the newest matching calls from the files. */
    private async _reload(): Promise<void> {
        if (!this._status) return;
        const load = ++this._loads;
        const filter = this._filter();
        this._calls.clear();
        this._selected = undefined;
        await this._run(async () => {
            if (this._live.checked) await bridge.invoke('watchCalls', { filter });
            else await bridge.invoke('unwatchCalls');
            const { calls, truncated } = await bridge.invoke('queryCalls', { filter, limit: PAGE });
            if (load !== this._loads) return;
            for (const call of calls) {
                if (!this._calls.has(call.id)) this._calls.set(call.id, call);
            }
            this._truncated = truncated;
        });
        this._renderTable();
    }

    private _renderTable(): void {
        const calls = [...this._calls.values()].sort((a, b) => b.at - a.at);
        for (const stale of calls.slice(MAX_SHOWN)) this._calls.delete(stale.id);
        if (calls.length === 0) {
            this._table.replaceChildren(h('div', { class: 'empty' }, this._status
                ? 'No recorded calls match. Turn on "Record calls" to log calls routed through the hub.'
                : 'Start the hub to view its call log.'));
        } else {
            this._table.replaceChildren(h('table', {},
                h('thead', {}, h('tr', {}, ...['Time', 'Status', 'Caller → Target', 'Method', 'Duration', 'Size'].map(text => h('th', {}, text)))),
                h('tbody', {}, ...calls.slice(0, MAX_SHOWN).flatMap(call => this._rows(call)))));
        }
        this._renderInfo(calls.length);
    }

    private _rows(call: CallRecord): Node[] {
        const selected = this._selected === call.id;
        const row = h('tr', {
            class: `call${selected ? ' selected' : ''}`,
            title: 'Show details',
            onClick: () => {
                this._selected = selected ? undefined : call.id;
                this._renderTable();
            },
        },
        h('td', { class: 'nowrap' }, _time(call.at)),
        h('td', {}, h('span', { class: `pill ${_statusClass(call)}`, title: call.error?.message }, call.status)),
        h('td', { title: _peersTitle(call) },
            h('div', {}, call.from.label, h('span', { class: 'muted' }, ' → '), call.to?.label ?? '–'),
            call.principal ? h('div', { class: 'sub' }, _shortPrincipal(call.principal)) : undefined),
        h('td', {}, h('code', {}, call.method),
            call.error ? h('div', { class: 'sub error' }, call.error.message) : undefined),
        h('td', { class: 'nowrap' }, call.status === 'pending' ? `${call.durationMs} ms…` : `${call.durationMs} ms`),
        h('td', { class: 'nowrap sub' }, `${_bytes(call.paramsBytes)} → ${_bytes(call.resultBytes)}`));
        if (!selected) return [row];
        return [row, h('tr', { class: 'details' }, h('td', { colSpan: 6 }, _details(call)))];
    }

    private _renderInfo(shown = this._calls.size): void {
        const callLog = this._status?.callLog;
        this._info.replaceChildren(...[
            callLog ? h('span', {}, 'Files: ', h('code', {}, callLog.directory)) : undefined,
            callLog?.serviceId ? h('span', {}, ' · served as linkrpc.logging at ', h('code', {}, callLog.serviceId)) : undefined,
            shown > 0 ? h('span', {}, ` · ${shown} shown${this._truncated ? ', older calls in the files' : ''}`) : undefined,
            callLog?.error ? h('span', { class: 'error' }, ` · ${callLog.error}`) : undefined,
        ].filter(node => node !== undefined));
    }

    private async _run(action: () => Promise<unknown>): Promise<void> {
        try {
            await action();
        } catch (error) {
            this._onError(errorMessage(error));
        }
    }
}

function _details(call: CallRecord): HTMLElement {
    const peer = (side: CallRecord['from']) => [side.label, side.transport ? ` (${side.transport})` : ''].join('');
    const rows: Array<[string, string | undefined]> = [
        ['Started', new Date(call.at).toISOString()],
        ['Caller', peer(call.from)],
        ['Target', call.to ? peer(call.to) : undefined],
        ['Principal', call.principal],
        ['Error', call.error ? `${call.error.message} (code ${call.error.code})` : undefined],
        ['Stream frames', call.streamFrames?.toString()],
        ['Record ID', call.id],
    ];
    const payload = (title: string, value: unknown, size: number | undefined) => value === undefined
        ? undefined
        : h('div', {}, h('div', { class: 'sub' }, `${title} (${_bytes(size)})`), h('pre', { class: 'log' }, JSON.stringify(value, null, 2)));
    return h('div', { class: 'call-details' },
        h('dl', {}, ...rows.filter(([, value]) => value !== undefined).flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, value!)])),
        payload('Params', call.params, call.paramsBytes),
        payload('Result', call.result, call.resultBytes));
}

function _statusClass(call: CallRecord): string {
    if (call.status === 'completed') return 'state-running';
    if (call.status === 'pending') return 'state-starting';
    return 'state-failed';
}

function _peersTitle(call: CallRecord): string {
    return [
        `caller: ${call.from.label}${call.from.transport ? ` (${call.from.transport})` : ''}`,
        call.to ? `target: ${call.to.label}${call.to.transport ? ` (${call.to.transport})` : ''}` : undefined,
        call.principal ? `principal: ${call.principal}` : undefined,
    ].filter(line => line !== undefined).join('\n');
}

function _shortPrincipal(principal: string): string {
    return principal.length > 24 ? `${principal.slice(0, 20)}…` : principal;
}

function _time(at: number): string {
    const date = new Date(at);
    return `${date.toLocaleTimeString([], { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function _bytes(size: number | undefined): string {
    if (size === undefined) return '–';
    return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
}
