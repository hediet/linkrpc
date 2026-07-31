import { z } from "zod";
import {
    defineInterface,
    requestType,
    notificationType,
    type InterfaceClient,
} from "@hediet/linkrpc";

// -- Shared zod schemas ------------------------------------------------------

const zJsonValue: z.ZodType<unknown> = z.unknown();

const zEditorCapabilities = z.object({
    supportsContentEdits: z.boolean().optional(),
    supportsOptions: z.boolean().optional(),
});

const zHostCapabilities = z.object({
    supportsContentEdits: z.boolean().optional(),
    supportsOptions: z.boolean().optional(),
    supportsForceUpdate: z.boolean().optional(),
});

const zTextEdit = z.object({
    offset: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
    newText: z.string(),
});

const zContentEdit = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("replace"),
        path: z.array(z.string()),
        newValue: zJsonValue,
    }),
    z.object({
        kind: z.literal("stringEdits"),
        path: z.array(z.string()),
        stringEdits: z.array(zTextEdit),
    }),
]);

export type ContentEdit = z.infer<typeof zContentEdit>;
export type TextEdit = z.infer<typeof zTextEdit>;
export type EditorCapabilities = z.infer<typeof zEditorCapabilities>;
export type HostCapabilities = z.infer<typeof zHostCapabilities>;

export type ContentType = "text" | "json";

// -- IHost (editor -> host) --------------------------------------------------

export const webEditorHostInterface = defineInterface(
    {
        id: "web-editor-host",
        description: "Methods the host exposes to the editor (web-editor/0.12).",
    },
    {
        initialized: requestType(
            z.object({
                protocolVersion: z.literal("web-editor/0.12"),
                contentType: z.enum(["text", "json"]),
                capabilities: zEditorCapabilities.optional(),
            }),
            z.object({
                protocolVersion: z.literal("web-editor-host/0.12"),
                capabilities: zHostCapabilities.optional(),
            }),
        ),

        applyContentEdit: notificationType(
            z.object({
                edits: z.array(zContentEdit),
                clientRevision: z.number().int().nonnegative(),
                basedOnServerRevision: z.number().int().nonnegative(),
            }),
        ),

        /**
         * The editor reports its laid-out content height (px). An embedding host
         * that reserves block space (e.g. an iframe with no intrinsic height)
         * uses this to size the frame once the guest has measured itself.
         */
        reportSize: notificationType(
            z.object({
                height: z.number().nonnegative(),
            }),
        ),
    },
);

// -- IEditor (host -> editor) ------------------------------------------------

export const webEditorInterface = defineInterface(
    {
        id: "web-editor",
        description: "Methods the editor exposes to the host (web-editor/0.12).",
    },
    {
        update: notificationType(
            z.object({
                content: zJsonValue.optional(),
                options: zJsonValue.optional(),
                readOnly: z.boolean().optional(),
                serverRevision: z.number().int().nonnegative().optional(),
                acknowledgedClientRevision: z.number().int().nonnegative().optional(),
                force: z.boolean().optional(),
            }),
        ),

        applyContentEdits: notificationType(
            z.object({
                edits: z.array(zContentEdit),
                serverRevision: z.number().int().nonnegative(),
                acknowledgedClientRevision: z.number().int().nonnegative(),
            }),
        ),

        getContentSchema: requestType(
            z.object({}),
            z.object({ schema: zJsonValue }),
        ),
    },
);

// -- VsCodeAppHost (editor -> host): always registered -----------------------

/** Per-scope registration: `registered` (toolbar button) and `isDefault` (auto-open). */
const zScopeRegistration = z.object({
    registered: z.boolean(),
    isDefault: z.boolean(),
});

export const vscodeAppHostInterface = defineInterface(
    {
        id: "vscode-app-host",
        description: "Methods an app `.vscode-app.html` exposes to the host (vscode-app-host/0.1).",
    },
    {
        getContext: requestType(
            z.object({}),
            z.object({
                dataDocument: z
                    .object({ contentType: z.enum(["text", "json"]) })
                    .nullable(),
            }),
        ),
        /**
         * This app's registration for `extension` (e.g. `".csv"`), reported per
         * scope. Served on the app's own (ungated) root overlay, so it needs no
         * capability. For each scope:
         *   - `registered` — the app is wired up for the type (an "Open as
         *     Custom Editor" toolbar button appears), via the `editorTypes`
         *     setting.
         *   - `isDefault` — the type *auto-opens* in the app (implies
         *     `registered`), via `workbench.editorAssociations`.
         * `hasWorkspace` indicates whether a workspace is open. Changing any of
         * this is done via {@link configureEditorAssociation} (host-rendered).
         */
        getEditorRegistration: requestType(
            z.object({ extension: z.string() }),
            z.object({
                global: zScopeRegistration,
                workspace: zScopeRegistration,
                hasWorkspace: z.boolean(),
            }),
        ),
        /**
         * Ask the host to show its (trusted, host-rendered) editor-association
         * dialog for `extension` (e.g. `".csv"`). The host owns the UI and
         * applies any change to `editorTypes` / `workbench.editorAssociations`
         * itself — the app never writes settings and needs no capability.
         *
         * `dismissable` is a hint: when the app is opened directly (no bound
         * data document) the host shows the dialog *unclosable* (the user can
         * still just close the editor tab) regardless of the hint; when bound to
         * a data document the dialog is dismissable unless `dismissable` is
         * `false`. Resolves once the dialog is dismissed, reporting the final
         * per-scope registration and whether anything `changed`.
         */
        configureEditorAssociation: requestType(
            z.object({
                extension: z.string(),
                dismissable: z.boolean().optional(),
            }),
            z.object({
                global: zScopeRegistration,
                workspace: zScopeRegistration,
                hasWorkspace: z.boolean(),
                changed: z.boolean(),
            }),
        ),
    },
);

// -- Typed call-site shapes --------------------------------------------------

/** Typed proxy used by the editor to invoke host methods. */
export type WebEditorHostProxy = InterfaceClient<typeof webEditorHostInterface>;

/** Typed proxy used by the host to invoke editor methods. */
export type WebEditorProxy = InterfaceClient<typeof webEditorInterface>;

/** Typed proxy used by an app to invoke `vscode-app-host` methods. */
export type VsCodeAppHostProxy = InterfaceClient<typeof vscodeAppHostInterface>;

/** Scope a registration is written to. */
export type EditorScope = "workspace" | "global";

/** This app's registration in one scope. */
export interface ScopeRegistration {
    /** Wired for the type (an "Open as Custom Editor" toolbar button appears). */
    readonly registered: boolean;
    /** The type auto-opens in this app (implies {@link registered}). */
    readonly isDefault: boolean;
}

/** Per-scope registration reported by `getEditorRegistration`. */
export interface EditorRegistrationStatus {
    /** Registration in user (global) settings. */
    readonly global: ScopeRegistration;
    /** Registration in the open workspace's settings. */
    readonly workspace: ScopeRegistration;
    /** Whether a workspace is open (so a workspace-scoped action applies). */
    readonly hasWorkspace: boolean;
}

/** Result of {@link vscodeAppHostInterface.configureEditorAssociation}. */
export interface EditorAssociationResult extends EditorRegistrationStatus {
    /** Whether the registration changed while the dialog was open. */
    readonly changed: boolean;
}
