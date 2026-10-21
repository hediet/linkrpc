import type { LinkRpcConnection } from '@hediet/linkrpc';
import type { InspectionHost } from '@hediet/linkrpc/inspection';
import { loggingInterface } from '@hediet/linkrpc-infra/logging';
import { type CallLogConfig, CallLogConfigSchema } from './callLogConfig';
import { CallLogDocument, registerCallLogService } from './callLogService';
import { type CallQueryResult, CallLogStore } from './callLogStore';
import { type CallFilter, type CallLogLevel, type CallRecord, createCallMatcher } from './callRecord';
import { CallRecorder } from './callRecorder';

export interface CallLogStatus {
    readonly level: CallLogLevel;
    readonly directory: string;
    /** `<hubServiceId>/daemon` while the hub runs. */
    readonly serviceId?: string;
    readonly error?: string;
}

interface AttachedHub {
    readonly inspection: InspectionHost;
    readonly serviceId: string;
}

/**
 * The daemon's persistent call log. Owns the files and the `linkrpc.logging`
 * document across hub restarts; records the attached hub's calls while the
 * configured level is not `off`. Configuration changes apply immediately.
 */
export class CallLog {
    private _config: CallLogConfig = CallLogConfigSchema.parse(undefined);
    private readonly _store: CallLogStore;
    private _document: CallLogDocument | undefined;
    private _hub: AttachedHub | undefined;
    private _recorder: CallRecorder | undefined;

    constructor(
        directory: string,
        private readonly _startedAt: number,
        /** Persists a level set over `linkrpc.logging` in the config file. */
        private readonly _persistLevel: (level: CallLogLevel) => Promise<void>,
    ) {
        this._store = new CallLogStore(directory, this._config.rotation);
    }

    public status(): CallLogStatus {
        return {
            level: this._config.level,
            directory: this._store.directory,
            ...(this._hub !== undefined ? { serviceId: this._hub.serviceId } : {}),
            ...(this._store.error !== undefined ? { error: this._store.error } : {}),
        };
    }

    public configure(config: CallLogConfig): void {
        this._config = config;
        this._store.setRotation(config.rotation);
        this._document?.setState(this._documentState());
        this._syncRecorder();
    }

    /**
     * Record the calls of a (re)started hub and serve the log as
     * `linkrpc.logging` under `serviceId` on `connection`.
     */
    public attach(inspection: InspectionHost, connection: LinkRpcConnection, serviceId: string): { dispose(): void; } {
        const hub: AttachedHub = { inspection, serviceId };
        this._hub = hub;
        this._recorder?.dispose();
        this._recorder = undefined;
        this._document?.dispose();
        const document = new CallLogDocument(serviceId, this._startedAt, this._store, this._documentState());
        this._document = document;
        const service = registerCallLogService(connection, serviceId, document, {
            level: () => this._config.level,
            setLevel: level => this._persistLevel(level),
        });
        this._syncRecorder();
        return {
            dispose: () => {
                service.dispose();
                if (this._hub !== hub) return;
                this._hub = undefined;
                this._document = undefined;
                document.dispose();
                this._syncRecorder();
            },
        };
    }

    public query(filter: CallFilter, limit?: number): Promise<CallQueryResult> {
        return this._store.query(filter, limit);
    }

    /** Live records matching `filter`, as they are written. */
    public watch(filter: CallFilter, listener: (record: CallRecord) => void): { dispose(): void; } {
        const matches = createCallMatcher(filter);
        return this._store.onRecord(record => {
            if (matches(record)) listener(record);
        });
    }

    public async close(): Promise<void> {
        this._recorder?.dispose();
        this._recorder = undefined;
        this._document?.dispose();
        await this._store.close();
    }

    private _syncRecorder(): void {
        const hub = this._hub;
        const record = hub !== undefined && this._config.level !== 'off';
        if (record && this._recorder === undefined) {
            this._recorder = new CallRecorder({
                inspection: hub.inspection,
                config: () => this._config,
                onRecord: call => this._store.append(call),
                ownMethodPrefix: `${hub.serviceId}::${loggingInterface.info.id}::`,
            });
        } else if (!record && this._recorder !== undefined) {
            this._recorder.dispose();
            this._recorder = undefined;
        }
    }

    private _documentState(): Readonly<Record<string, unknown>> {
        return { level: this._config.level, directory: this._store.directory, payloads: this._config.payloads.mode };
    }
}
