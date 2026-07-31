import type { LinkRpcConnection } from "@hediet/linkrpc";
import {
    webEditorHostInterface,
    webEditorInterface,
    type ContentType,
    type HostCapabilities,
    type EditorCapabilities,
    type WebEditorProxy,
    type ContentEdit,
} from "../protocol";
import { applyContentEdits, type JsonValue } from "../content/contentModel";
import {
    decodeFromEditor,
    encodeForEditor,
    type JsonFormatOptions,
} from "../content/textJsonCodec";
import { Emitter, type Event, type IDisposable } from "../utils/event";

export interface WebEditorHostOptions {
    /**
     * A connection wired up with a {@link IMessageTransport} that talks to the editor.
     * The host takes ownership and closes it on dispose.
     */
    connection: LinkRpcConnection;
    /**
     * What the host stores. `text` is plain text; `json` is round-tripped through
     * `JSON.parse` / `JSON.stringify`. Default `text`.
     *
     * The editor announces its own `contentType` in `initialized`. They must match.
     */
    contentType?: ContentType;
    /** Initial text. Default `""`. */
    initialText?: string;
    /** Initial read-only state. Default `false`. */
    readOnly?: boolean;
    /** Indentation for JSON content. Ignored for text. */
    jsonFormat?: JsonFormatOptions;
    /** Host capabilities advertised on `initialized`. */
    capabilities?: HostCapabilities;
    /** Called when the editor sends malformed input. Defaults to `console.error`. */
    onError?: (message: string, detail?: unknown) => void;
}

/**
 * Host-side façade for the web-editor v0.12 protocol.
 *
 * Owns the canonical text content. Translates between text/JSON form and the
 * structural edits exchanged with the editor. Maintains the revision pair
 * required by the client-authority conflict policy.
 */
export class WebEditorHost implements IDisposable {
    private readonly _connection: LinkRpcConnection;
    private readonly _editor: WebEditorProxy;
    private readonly _contentType: ContentType;
    private readonly _jsonFormat: JsonFormatOptions;
    private readonly _onError: (message: string, detail?: unknown) => void;
    private readonly _capabilities: HostCapabilities;

    private _text: string;
    private _readOnly: boolean;
    private _serverRevision = 0;
    private _acknowledgedClientRevision = 0;
    private _editorInitialized = false;
    private _editorCapabilities: EditorCapabilities | undefined;

    private readonly _onDidChangeText = new Emitter<{ text: string }>();
    public readonly onDidChangeText: Event<{ text: string }> = this._onDidChangeText.event;

    private readonly _onDidInitialize = new Emitter<{ capabilities: EditorCapabilities | undefined }>();
    public readonly onDidInitialize: Event<{ capabilities: EditorCapabilities | undefined }> = this._onDidInitialize.event;

    private readonly _onDidReportSize = new Emitter<{ height: number }>();
    public readonly onDidReportSize: Event<{ height: number }> = this._onDidReportSize.event;

    constructor(options: WebEditorHostOptions) {
        this._connection = options.connection;
        this._contentType = options.contentType ?? "text";
        this._text = options.initialText ?? "";
        this._readOnly = options.readOnly ?? false;
        this._jsonFormat = options.jsonFormat ?? {};
        this._onError = options.onError ?? ((m, d) => console.error("WebEditorHost:", m, d));
        this._capabilities = options.capabilities ?? { supportsForceUpdate: true };

        this._editor = this._connection.get(webEditorInterface);

        this._connection.register(webEditorHostInterface, {
            initialized: (params) => {
                if (params.contentType !== this._contentType) {
                    this._onError(
                        `Editor contentType "${params.contentType}" does not match host "${this._contentType}"`,
                    );
                }
                this._editorCapabilities = params.capabilities;
                this._editorInitialized = true;
                this._serverRevision = 0;
                this._acknowledgedClientRevision = 0;

                this._pushFullUpdate();
                this._onDidInitialize.fire({ capabilities: params.capabilities });

                return {
                    protocolVersion: "web-editor-host/0.12",
                    capabilities: this._capabilities,
                };
            },

            applyContentEdit: (params) => {
                if (this._readOnly) {
                    this._onError("Editor sent applyContentEdit while readOnly");
                    return;
                }
                let newValue: JsonValue;
                try {
                    const current = encodeForEditor(this._text, this._contentType);
                    newValue = applyContentEdits(current, params.edits);
                } catch (e) {
                    this._onError("Failed to apply content edits from editor", e);
                    return;
                }
                let newText: string;
                try {
                    newText = decodeFromEditor(newValue, this._contentType, this._jsonFormat);
                } catch (e) {
                    this._onError("Failed to decode editor content", e);
                    return;
                }

                this._acknowledgedClientRevision = params.clientRevision;
                if (newText !== this._text) {
                    this._text = newText;
                    this._onDidChangeText.fire({ text: newText });
                }
            },

            reportSize: (params) => {
                this._onDidReportSize.fire({ height: params.height });
            },
        });
    }

    /** The text the host believes the document currently holds. */
    public getText(): string {
        return this._text;
    }

    /**
     * Push a new full text to the editor. Sent as a `replace` at the document
     * root. If `force`, the editor must adopt it even with pending local edits.
     */
    public setText(text: string, opts: { force?: boolean } = {}): void {
        if (text === this._text) return;
        this._text = text;
        this._pushFullUpdate(opts.force);
    }

    public getReadOnly(): boolean {
        return this._readOnly;
    }

    public setReadOnly(readOnly: boolean): void {
        if (this._readOnly === readOnly) return;
        this._readOnly = readOnly;
        if (this._editorInitialized) {
            this._editor.update({
                readOnly,
                acknowledgedClientRevision: this._acknowledgedClientRevision,
            });
        }
    }

    /**
     * Push fine-grained edits to the editor.
     * The host is responsible for keeping its own `_text` consistent with these edits.
     */
    public applyEdits(edits: readonly ContentEdit[]): void {
        if (edits.length === 0 || !this._editorInitialized) return;
        let newValue: JsonValue;
        try {
            const current = encodeForEditor(this._text, this._contentType);
            newValue = applyContentEdits(current, edits);
            this._text = decodeFromEditor(newValue, this._contentType, this._jsonFormat);
        } catch (e) {
            this._onError("Failed to apply outgoing edits to local text", e);
            return;
        }
        this._serverRevision++;
        this._editor.applyContentEdits({
            edits: edits as ContentEdit[],
            serverRevision: this._serverRevision,
            acknowledgedClientRevision: this._acknowledgedClientRevision,
        });
    }

    public dispose(): void {
        this._onDidChangeText.dispose();
        this._onDidInitialize.dispose();
        this._onDidReportSize.dispose();
        this._connection.close();
    }

    private _pushFullUpdate(force?: boolean): void {
        if (!this._editorInitialized) return;
        this._serverRevision++;
        let content: JsonValue;
        try {
            content = encodeForEditor(this._text, this._contentType);
        } catch (e) {
            this._onError("Failed to encode text for editor", e);
            return;
        }
        this._editor.update({
            content,
            readOnly: this._readOnly,
            serverRevision: this._serverRevision,
            acknowledgedClientRevision: this._acknowledgedClientRevision,
            force,
        });
    }
}
