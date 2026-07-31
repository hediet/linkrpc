import type { LinkRpcConnection } from "@hediet/linkrpc";
import {
    vscodeAppHostInterface,
    type ContentType,
    type EditorAssociationResult,
    type EditorRegistrationStatus,
    type VsCodeAppHostProxy,
} from "../protocol";
import { HostConnection, type ConnectionInput } from "./connection";

export interface VsCodeAppHostClientOptions {
    /**
     * A connection that talks to the host, or the literal `"windowParent"` to
     * build one over a `WindowMessageTransport` to `window.parent` (so the app
     * needn't depend on `@hediet/linkrpc`).
     */
    connection: ConnectionInput;
}

/** The data document an app `.vscode-app.html` is bound to, if any. */
export interface AppContext {
    /**
     * The bound data document, or `null` when the app was opened directly
     * (i.e. not editing a file) — in which case it may offer to
     * {@link VsCodeAppHostClient.configureEditorAssociation associate} itself
     * with the file extensions it can edit.
     */
    dataDocument: { contentType: ContentType } | null;
}

/**
 * Editor-side façade for the `vscode-app-host` interface that every
 * `.vscode-app.html` host registers.
 *
 * Use {@link getContext} to detect whether the app was opened bound to a data
 * file (drive a {@link import("./WebEditorClient").WebEditorClient} over the
 * same {@link connection}) or opened directly (call
 * {@link configureEditorAssociation}).
 */
export class VsCodeAppHostClient {
    private readonly _hostConnection: HostConnection;
    private readonly _host: VsCodeAppHostProxy;

    constructor(options: VsCodeAppHostClientOptions) {
        this._hostConnection = HostConnection.from(options.connection);
        this._host = this._hostConnection.connection.get(vscodeAppHostInterface);
    }

    /**
     * The underlying connection. Reuse it (e.g. for a `WebEditorClient`) instead
     * of opening a second transport to the same host.
     */
    public get connection(): LinkRpcConnection {
        return this._hostConnection.connection;
    }

    /** Ask the host for the app's context (whether it is bound to a data file). */
    public getContext(): Promise<AppContext> {
        return this._host.getContext({});
    }

    /**
     * This app's registration for `extension` (e.g. `".csv"`), per scope. A
     * lightweight, ungated read served on the app's own root overlay — never
     * prompts the user and needs no managed identity. Each scope reports
     * `registered` (toolbar button) and `isDefault` (auto-open); `hasWorkspace`
     * tells whether a workspace-scoped action is meaningful.
     */
    public async getEditorRegistration(extension: string): Promise<EditorRegistrationStatus> {
        return this._host.getEditorRegistration({ extension });
    }

    /**
     * Ask the host to show its trusted, host-rendered editor-association dialog
     * for `extension` (e.g. `".csv"`). The host owns the UI and applies any
     * change itself — the app never writes settings and needs no capability.
     *
     * Pass `dismissable: false` to request an unclosable dialog; the host only
     * honours that when the app was opened directly (no bound data document).
     * When opened directly the dialog is always unclosable (the user can still
     * close the editor tab). Resolves once the dialog is dismissed, reporting
     * the final per-scope registration and whether anything `changed`.
     */
    public async configureEditorAssociation(
        extension: string,
        options?: { dismissable?: boolean },
    ): Promise<EditorAssociationResult> {
        return this._host.configureEditorAssociation({
            extension,
            dismissable: options?.dismissable,
        });
    }
}
