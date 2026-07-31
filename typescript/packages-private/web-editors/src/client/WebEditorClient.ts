import type { LinkRpcConnection } from "@hediet/linkrpc";
import {
    webEditorHostInterface,
    webEditorInterface,
    type ContentType,
    type EditorCapabilities,
    type HostCapabilities,
    type WebEditorHostProxy,
    type ContentEdit,
} from "../protocol";
import { applyContentEdits, type JsonValue } from "../content/contentModel";
import { Emitter, type Event, type IDisposable } from "../utils/event";
import { resolveConnection, type ConnectionInput } from "./connection";

export interface WebEditorClientOptions {
    /**
     * A connection that talks to the host, or the literal `"windowParent"` to
     * build one over a `WindowMessageTransport` to `window.parent` (so the app
     * needn't depend on `@hediet/linkrpc`). The client takes ownership and
     * closes it on dispose.
     */
    connection: ConnectionInput;
    /** Editor's content type. Must match what the host expects. Default `text`. */
    contentType?: ContentType;
    /** Editor capabilities announced to the host. */
    capabilities?: EditorCapabilities;
    /** Optional handler for `getContentSchema` requests from the host. */
    getContentSchema?: () => unknown | Promise<unknown>;
    /** Called when host messages are malformed or inconsistent. */
    onError?: (message: string, detail?: unknown) => void;
}

export interface WebEditorClientState {
    content: JsonValue;
    readOnly: boolean;
}

/**
 * Editor-side façade for the web-editor v0.12 protocol.
 *
 * Calls `host.initialized` immediately, then exposes the current content and
 * read-only flag as observable events. Local edits made through {@link applyEdits}
 * are sent to the host with monotonically increasing client revisions.
 */
export class WebEditorClient implements IDisposable {
    private readonly _connection: LinkRpcConnection;
    private readonly _host: WebEditorHostProxy;
    private readonly _onError: (message: string, detail?: unknown) => void;

    private _content: JsonValue = undefined;
    private _readOnly = false;
    private _options: JsonValue = undefined;
    private _hostCapabilities: HostCapabilities | undefined;

    private _clientRevision = 0;
    private _basedOnServerRevision = 0;
    /** Number of un-acked local revisions. While > 0 the editor has pending edits. */
    private _pendingLocalEdits = 0;

    private readonly _onDidChangeContent = new Emitter<{ content: JsonValue; force: boolean }>();
    public readonly onDidChangeContent: Event<{ content: JsonValue; force: boolean }> = this._onDidChangeContent.event;

    private readonly _onDidApplyHostEdits = new Emitter<{ edits: ContentEdit[]; content: JsonValue }>();
    public readonly onDidApplyHostEdits: Event<{ edits: ContentEdit[]; content: JsonValue }> = this._onDidApplyHostEdits.event;

    private readonly _onDidChangeReadOnly = new Emitter<{ readOnly: boolean }>();
    public readonly onDidChangeReadOnly: Event<{ readOnly: boolean }> = this._onDidChangeReadOnly.event;

    private readonly _onDidChangeOptions = new Emitter<{ options: JsonValue }>();
    public readonly onDidChangeOptions: Event<{ options: JsonValue }> = this._onDidChangeOptions.event;

    /** Resolves once the host has acknowledged `initialized`. */
    public readonly onDidConnect: Promise<{ capabilities: HostCapabilities | undefined }>;

    public static async connect(options: WebEditorClientOptions): Promise<WebEditorClient> {
        const client = new WebEditorClient(options);
        await client.onDidConnect;
        return client;
    }

    constructor(options: WebEditorClientOptions) {
        this._connection = resolveConnection(options.connection);
        this._onError = options.onError ?? ((m, d) => console.error("WebEditorClient:", m, d));
        this._host = this._connection.get(webEditorHostInterface);

        this._connection.register(webEditorInterface, {
            update: (params) => this._handleUpdate(params),
            applyContentEdits: (params) => this._handleApplyContentEdits(params),
            getContentSchema: async () => {
                const schema = options.getContentSchema ? await options.getContentSchema() : null;
                return { schema };
            },
        });

        this.onDidConnect = this._host
            .initialized({
                protocolVersion: "web-editor/0.12",
                contentType: options.contentType ?? "text",
                capabilities: options.capabilities,
            })
            .then((r) => {
                this._hostCapabilities = r.capabilities;
                return { capabilities: r.capabilities };
            });
    }

    /**
     * The underlying connection. Reuse it to talk to other host interfaces
     * (e.g. `vscode-app-host`) over the same transport instead of opening a
     * second one.
     */
    public get connection(): LinkRpcConnection {
        return this._connection;
    }

    public getContent(): JsonValue {
        return this._content;
    }

    public getReadOnly(): boolean {
        return this._readOnly;
    }

    public getOptions(): JsonValue {
        return this._options;
    }

    public getHostCapabilities(): HostCapabilities | undefined {
        return this._hostCapabilities;
    }

    /**
     * Apply local edits and notify the host. Updates the local content state
     * synchronously, then sends a single `applyContentEdit` notification.
     */
    public applyEdits(edits: readonly ContentEdit[]): void {
        if (edits.length === 0) return;
        try {
            this._content = applyContentEdits(this._content, edits);
        } catch (e) {
            this._onError("Failed to apply local edits", e);
            return;
        }
        this._clientRevision++;
        this._pendingLocalEdits++;
        this._onDidChangeContent.fire({ content: this._content, force: false });

        this._host.applyContentEdit({
            edits: edits as ContentEdit[],
            clientRevision: this._clientRevision,
            basedOnServerRevision: this._basedOnServerRevision,
        });
    }

    /**
     * Report the editor's current laid-out content height (px) to the host.
     * A host embedding this editor in an iframe uses it to size the frame.
     */
    public reportSize(height: number): void {
        this._host.reportSize({ height });
    }

    public dispose(): void {
        this._onDidChangeContent.dispose();
        this._onDidApplyHostEdits.dispose();
        this._onDidChangeReadOnly.dispose();
        this._onDidChangeOptions.dispose();
        this._connection.close();
    }

    private _handleUpdate(params: {
        content?: JsonValue;
        options?: JsonValue;
        readOnly?: boolean;
        serverRevision?: number;
        acknowledgedClientRevision?: number;
        force?: boolean;
    }): void {
        if (params.acknowledgedClientRevision !== undefined) {
            this._acknowledge(params.acknowledgedClientRevision);
        }
        if (params.serverRevision !== undefined) {
            this._basedOnServerRevision = params.serverRevision;
        }
        if (params.readOnly !== undefined && params.readOnly !== this._readOnly) {
            this._readOnly = params.readOnly;
            this._onDidChangeReadOnly.fire({ readOnly: params.readOnly });
        }
        if (params.options !== undefined) {
            this._options = params.options;
            this._onDidChangeOptions.fire({ options: params.options });
        }
        if (params.content !== undefined) {
            if (this._pendingLocalEdits > 0 && !params.force) {
                // Conflict policy: drop server content while we have pending edits.
                return;
            }
            this._content = params.content;
            this._onDidChangeContent.fire({ content: params.content, force: params.force === true });
        }
    }

    private _handleApplyContentEdits(params: {
        edits: ContentEdit[];
        serverRevision: number;
        acknowledgedClientRevision: number;
    }): void {
        this._acknowledge(params.acknowledgedClientRevision);
        this._basedOnServerRevision = params.serverRevision;
        if (this._pendingLocalEdits > 0) {
            // Conflict policy: drop server edits that may collide with pending local edits.
            return;
        }
        try {
            this._content = applyContentEdits(this._content, params.edits);
        } catch (e) {
            this._onError("Failed to apply host edits", e);
            return;
        }
        this._onDidApplyHostEdits.fire({ edits: params.edits, content: this._content });
    }

    private _acknowledge(ackedClientRevision: number): void {
        // Every applyContentEdit bumps _clientRevision by 1 and _pendingLocalEdits by 1.
        const acked = Math.max(0, this._clientRevision - (this._clientRevision - ackedClientRevision));
        const newPending = Math.max(0, this._clientRevision - acked);
        this._pendingLocalEdits = newPending;
    }
}
