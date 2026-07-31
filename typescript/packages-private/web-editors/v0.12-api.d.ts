/**
 * Web Editor Protocol — v0.12 (API-style)
 * =======================================
 *
 * Same wire protocol as `v0.12.d.ts`, expressed as TypeScript interfaces with
 * methods. Each method corresponds to one JSON-RPC method (the method name on
 * the wire matches the TS method name; dotted names become nested namespaces).
 *
 *   - `IEditor`   — methods the editor exposes; the host calls these.
 *   - `IHost`     — methods the host  exposes; the editor calls these.
 *   - `IVSCode`   — VS Code–specific subset of `IHost`, namespaced under `host.vscode.*`.
 *
 * Notifications return `void`. Requests return `Promise<T>`. This is the only
 * way the two are distinguished in the API shape.
 *
 * For the semantics (revisions, conflict policy, lifecycle, force-update, etc.)
 * see the header of `v0.12.d.ts`.
 */

// -- Shared types ------------------------------------------------------------

/** Any JSON value. Kept as `unknown` to force callers to narrow. */
export type JsonValue = unknown;

export interface EditorCapabilities {
    /** Editor can apply incremental edits from the host. */
    supportsContentEdits?: boolean;
    /** Editor consumes `options`. */
    supportsOptions?: boolean;
}

export interface HostCapabilities {
    /** Host accepts incremental edits from the editor. */
    supportsContentEdits?: boolean;
    /** Host may push `options` updates. */
    supportsOptions?: boolean;
    /** Host may set `force: true` on `update`. */
    supportsForceUpdate?: boolean;
}

/**
 * A targeted edit within the JSON document.
 *
 * `path` is the sequence of keys / stringified indices from the root.
 * The empty array `[]` refers to the root.
 *
 * Two edits CONFLICT iff one `path` is a prefix of the other (or equal).
 * String edits at the same path always conflict.
 */
export type IContentEdit =
    | {
        kind: "replace";
        path: string[];
        newValue: JsonValue;
    }
    | {
        kind: "stringEdits";
        path: string[];
        stringEdits: ITextEdit[];
    };

export interface ITextEdit {
    /** UTF-16 code-unit offset into the string. */
    offset: number;
    /** Length in UTF-16 code units. */
    length: number;
    newText: string;
}

export interface ILineColumnPos {
    /** 0-based line index. */
    line: number;
    /** 0-based UTF-16 code-unit offset within the line. */
    character: number;
}

// -- IHost — editor → host ---------------------------------------------------

/**
 * The host exposes these methods to the editor.
 * The editor invokes them via JSON-RPC requests / notifications.
 */
export interface IHost {
    /**
     * MUST be the first call the editor makes after load.
     * Re-invoking it instructs the host to reset its view of the editor.
     */
    initialized(params: {
        protocolVersion: "web-editor/0.12";
        contentType: "text" | "json";
        capabilities?: EditorCapabilities;
    }): Promise<{
        protocolVersion: "web-editor-host/0.12";
        capabilities?: HostCapabilities;
    }>;

    /**
     * Reports the editor's current state. Sent:
     *   - whenever the user makes a change, OR
     *   - after processing a host-initiated update (even if `edits` is empty),
     *     in which case it acts as the acknowledgement.
     *
     * The host applies `edits` deterministically; combined with the revision
     * fields this reconciles both sides without a separate ack message.
     */
    applyContentEdit(params: {
        edits: IContentEdit[];
        /** Editor's revision AFTER applying `edits`. Monotonic. */
        clientRevision: number;
        /** Highest serverRevision the editor has integrated. */
        basedOnServerRevision: number;
    }): void;
}


// -- IEditor — host → editor -------------------------------------------------

/**
 * The editor exposes these methods to the host.
 * The host invokes them via JSON-RPC requests / notifications.
 */
export interface IEditor {
    /**
     * Replaces content, options, and/or readOnly state on the editor.
     *
     * `content` is subject to the client-authority conflict policy: it is
     * dropped if the editor has pending edits, UNLESS `force` is true.
     * `options` and `readOnly` are always applied.
     */
    update(params: {
        /** New content. Initial value is the empty string / null. */
        content?: JsonValue;
        /** New options. Initial value is `undefined`. */
        options?: JsonValue;
        /** Read-only flag. Initial value is `false`. */
        readOnly?: boolean;

        /** Server revision AFTER this update. Required iff `content` is set. */
        serverRevision?: number;
        /** Highest clientRevision the host had integrated when producing this update. */
        acknowledgedClientRevision?: number;

        /**
         * If true, this update overrides any pending client edits.
         * Use only when the user has explicitly accepted overwriting local
         * changes (e.g. "Reload from disk" prompt).
         */
        force?: boolean;
    }): void;

    /**
     * Applies edits on top of the editor's current content.
     * Subject to the client-authority conflict policy: edits whose paths
     * conflict with pending client edits are silently dropped by the editor.
     */
    applyContentEdits(params: {
        edits: IContentEdit[];
        /** Server revision AFTER these edits. */
        serverRevision: number;
        /** Highest clientRevision the host had integrated when producing these edits. */
        acknowledgedClientRevision: number;
    }): void;

    /** Requests the JSON schema describing the editor's content shape. */
    getContentSchema(): Promise<{ schema: unknown }>;
}
