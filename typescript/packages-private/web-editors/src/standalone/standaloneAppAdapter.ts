/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone app adapter — the "from source" bridge for a `*.vscode-app.html`.
 *
 * Authored apps add this as a source-only script that the packager strips from
 * the bundled output (the bundle does this work itself):
 *
 * ```html
 * <script data-vscode-app-unbundled
 *         src="https://unpkg.com/@hediet/web-editors/standalone-app-adapter.js"></script>
 * ```
 *
 * When the HTML is opened directly in a browser (i.e. NOT packaged), this
 * adapter makes the file self-contained enough to run, and to boot the optional
 * Component Explorer:
 *
 *  1. marks the runtime as `dev` (`globalThis.VSCODE_APP_ENV = 'dev'`), so
 *     branches gated on `globalThis.VSCODE_APP_ENV !== 'prod'` — e.g. the
 *     Component Explorer's dynamic `import()` — run from source;
 *  2. injects a small host CSS shim (theme variable fallbacks + reset) so apps
 *     styled against `var(--vscode-*)` are legible without the real host;
 *  3. transforms inline `lang="ts" | "tsx"` scripts with Babel (loaded from a
 *     CDN) and re-injects them as real ES modules so the browser runs them;
 *  4. installs a no-op host shim for `window.parent` RPC so apps that probe the
 *     host don't hang on a silent channel (full host emulation is out of scope).
 *
 * In a packaged app this script does not exist (the packager strips the
 * `data-vscode-app-unbundled` element), but the adapter ALSO self-guards on
 * `globalThis.VSCODE_APP_ENV === 'prod'` as defense in depth: if the tag is ever
 * left in, it no-ops.
 */

import darkThemeCss from "./themes/default-dark-plus.css?raw";
import lightThemeCss from "./themes/default-light-plus.css?raw";

declare global {
    // eslint-disable-next-line no-var
    var VSCODE_APP_ENV: "dev" | "prod" | undefined;
    // eslint-disable-next-line no-var
    var Babel: BabelStandalone | undefined;
    /**
     * Contribution API installed by the standalone adapter when running from
     * source. Apps use it to add buttons to the floating dev toolbar. Absent in
     * a packaged app (the adapter is stripped), so always access it optionally:
     * `globalThis.vscodeAppAdapter?.…`.
     */
    // eslint-disable-next-line no-var
    var vscodeAppAdapter: VsCodeAppAdapter | undefined;
}

/** A button contributed to the adapter's floating dev toolbar. */
interface ToolbarItem {
    /** Stable id; re-adding the same id replaces the previous contribution. */
    readonly id: string;
    /** Button label. A function is re-evaluated on every render (dynamic text). */
    readonly label: string | (() => string);
    /** Tooltip. A function is re-evaluated on every render. */
    readonly title?: string | (() => string);
    /** Sort key; lower sorts further left. Default `100`. */
    readonly order?: number;
    /** Invoked on click (suppressed if the press was actually a drag). */
    readonly onClick: () => void;
}

interface VsCodeAppAdapter {
    /** Add (or replace, by `id`) a toolbar button. Returns a disposer. */
    addToolbarItem(item: ToolbarItem): () => void;
    /**
     * Contribute the standard Explorer/Back toggle (flips the `?fixtures`
     * query param) and return whether the page is currently in explorer mode.
     * Call this only from an explorer-capable app — apps that don't call it get
     * no Explorer button. Must remain inside a
     * `globalThis.VSCODE_APP_ENV !== 'prod'` gate so the explorer import is
     * dead-code-eliminated in a packaged build.
     */
    enableComponentExplorer(): boolean;
}

interface BabelStandalone {
    transform(
        code: string,
        options: Record<string, unknown>,
    ): { code: string | null };
}

/** CDN URL of Babel standalone used to transform inline TS/JSX from source. */
const BABEL_STANDALONE_URL = "https://unpkg.com/@babel/standalone@7/babel.min.js";

/** React CDN base used for the automatic JSX runtime when none is detected. */
const DEFAULT_REACT_CDN = "https://esm.sh/react@18.3.1";

/**
 * The bundled VS Code theme stylesheets (Default Dark+/Light+), each scoped to a
 * `.vscode-theme.<id>` wrapper class. Applying both classes to `<html>` cascades
 * that theme's full `--vscode-*` variable set to the whole page. This is the same
 * snapshot the Component Explorer ships, so app-mode and explorer-mode match.
 */
const THEME_STYLES: Record<Theme, { css: string; class: string }> = {
    dark: { css: darkThemeCss, class: "default-dark-plus" },
    light: { css: lightThemeCss, class: "default-light-plus" },
};

const SCRIPT_LANGS = new Set(["ts", "tsx", "jsx", "js"]);

/**
 * Inject the bundled theme stylesheets once. Skipped if the document already
 * defines `--vscode-foreground` (a real host or the app itself provides theming).
 */
function injectThemeStyles(): void {
    if (document.querySelector('style[data-vscode-app-adapter="themes"]')) return;
    const probe = getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-foreground")
        .trim();
    if (probe) return;
    const style = document.createElement("style");
    style.setAttribute("data-vscode-app-adapter", "themes");
    style.textContent =
        THEME_STYLES.dark.css + "\n" + THEME_STYLES.light.css + "\n" +
        // Give the page itself a themed canvas (the wrapper snapshots only define
        // variables, not a background on the wrapper element).
        "html.vscode-theme{background:var(--vscode-editor-background);color:var(--vscode-foreground);}";
    document.head.appendChild(style);
}

function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(el);
    });
}

async function ensureBabel(): Promise<BabelStandalone> {
    if (globalThis.Babel) return globalThis.Babel;
    await loadScript(BABEL_STANDALONE_URL);
    if (!globalThis.Babel) {
        throw new Error("Babel standalone did not initialize.");
    }
    return globalThis.Babel;
}

/**
 * Detect a CDN URL importing `react` in `source` and return its
 * `package@version` URL prefix, so the automatic JSX runtime resolves
 * `/jsx-runtime` against the same CDN the app already imports React from.
 */
function detectReactCdnImport(source: string): string {
    const re = /["'](https?:\/\/[^"']*?\breact@[^/?#"']+)(?:[/?#][^"']*)?["']/;
    const m = re.exec(source);
    return m ? m[1] : DEFAULT_REACT_CDN;
}

/**
 * Transform an inline `lang`-tagged script's source to a runnable ES module and
 * append it as a `blob:` module. Note relative imports won't resolve against a
 * blob URL — from-source apps import from absolute CDN URLs (esm.sh, etc.).
 */
async function runInlineScript(babel: BabelStandalone, el: HTMLScriptElement): Promise<void> {
    const lang = el.getAttribute("lang") ?? "tsx";
    const source = el.textContent ?? "";
    const importSource = detectReactCdnImport(source);
    const result = babel.transform(source, {
        filename: `app.${lang}`,
        presets: [
            ["react", { runtime: "automatic", importSource }],
            ["typescript", { isTSX: true, allExtensions: true, onlyRemoveTypeImports: true }],
        ],
    });
    const code = result.code ?? "";
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const module = document.createElement("script");
    module.type = "module";
    module.src = url;
    document.body.appendChild(module);
}

async function transformInlineScripts(): Promise<void> {
    const els = [...document.querySelectorAll("script[lang]")].filter(
        (el): el is HTMLScriptElement =>
            el instanceof HTMLScriptElement &&
            SCRIPT_LANGS.has((el.getAttribute("lang") ?? "").toLowerCase()) &&
            // Only inline scripts (no external src) carry source to transform.
            !el.src,
    );
    if (els.length === 0) return;
    const babel = await ensureBabel();
    for (const el of els) {
        await runInlineScript(babel, el);
    }
}

/**
 * No-op host shim: answer `window.parent` postMessage RPC probes with nothing
 * so an app that opens a host connection from source doesn't hang on a silent
 * channel. This is intentionally minimal — it does not emulate any host method.
 * Only installed when the page is actually the top window (no real parent host).
 */
function installNoopHostShim(): void {
    if (window.parent !== window) return; // a real embedding parent exists.
    window.addEventListener("message", () => {
        // Swallow self-posted messages; no host responses are produced.
    });
}

/** Query-param the toggle flips to switch between the app and the explorer. */
const FIXTURES_PARAM = "fixtures";

/** localStorage key persisting the user's explicit light/dark choice. */
const THEME_KEY = "vscode-app-adapter-theme";

type Theme = "light" | "dark";

function storedTheme(): Theme | undefined {
    try {
        const v = localStorage.getItem(THEME_KEY);
        return v === "light" || v === "dark" ? v : undefined;
    } catch {
        return undefined;
    }
}

/** Resolve the effective theme: explicit choice, else the OS preference. */
function effectiveTheme(): Theme {
    const stored = storedTheme();
    if (stored) return stored;
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
    const root = document.documentElement;
    root.classList.add("vscode-theme");
    root.classList.remove(THEME_STYLES.dark.class, THEME_STYLES.light.class);
    root.classList.add(THEME_STYLES[theme].class);
    root.style.colorScheme = theme;
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch {
        // Persistence is best-effort; the class still applies for this load.
    }
}

/** Apply the explorer-mode page reset so the explorer fills the viewport. */
function injectExplorerReset(): void {
    if (document.querySelector('style[data-vscode-app-adapter="explorer-reset"]')) return;
    // The explorer is a full-window UI, but the page keeps the browser's default
    // body margin (and the app's own `#root` padding), leaving the explorer
    // inset. Normalize the page so the explorer fills the viewport.
    const reset = document.createElement("style");
    reset.setAttribute("data-vscode-app-adapter", "explorer-reset");
    reset.textContent =
        "html,body{margin:0!important;padding:0!important;height:100%!important;" +
        "width:100%!important;overflow:hidden!important;}" +
        // The app mounts the explorer into its root element (the body's first
        // element child); make it fill the viewport regardless of its own id
        // or padding.
        "body>:not(#__vscode_app_adapter_toolbar__):first-child{" +
        "position:fixed!important;inset:0!important;margin:0!important;" +
        "padding:0!important;height:100vh!important;width:100vw!important;}";
    document.head.appendChild(reset);
}

/**
 * The floating dev toolbar: a half-transparent, draggable pill whose buttons are
 * contributed through {@link VsCodeAppAdapter.addToolbarItem}. The adapter adds a
 * built-in light/dark theme toggle; explorer-capable apps add an Explorer toggle
 * via {@link VsCodeAppAdapter.enableComponentExplorer}. Dev-only; never present
 * in a packaged app since the whole adapter is stripped.
 */
class AdapterToolbar {
    private readonly _items: ToolbarItem[] = [];
    private _bar: HTMLDivElement | undefined;
    private _moved = false;

    addItem(item: ToolbarItem): () => void {
        const existing = this._items.findIndex((i) => i.id === item.id);
        if (existing >= 0) {
            this._items.splice(existing, 1, item);
        } else {
            this._items.push(item);
        }
        this._render();
        return () => {
            const idx = this._items.findIndex((i) => i.id === item.id);
            if (idx >= 0) {
                this._items.splice(idx, 1);
                this._render();
            }
        };
    }

    private _ensureBar(): HTMLDivElement {
        if (this._bar) return this._bar;
        const bar = document.createElement("div");
        bar.id = "__vscode_app_adapter_toolbar__";
        bar.style.cssText = [
            "position:fixed",
            "right:16px",
            "bottom:16px",
            "z-index:2147483647",
            "display:flex",
            "align-items:stretch",
            "gap:1px",
            "border:1px solid rgba(128,128,128,.5)",
            "border-radius:999px",
            "overflow:hidden",
            "background:rgba(30,30,30,.55)",
            "color:#fff",
            "font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
            "opacity:.5",
            "backdrop-filter:blur(4px)",
            "-webkit-backdrop-filter:blur(4px)",
            "user-select:none",
            "transition:opacity .15s ease",
            "touch-action:none",
        ].join(";");
        bar.addEventListener("mouseenter", () => { bar.style.opacity = "1"; });
        bar.addEventListener("mouseleave", () => { bar.style.opacity = ".5"; });
        this._installDrag(bar);
        (document.body ?? document.documentElement).appendChild(bar);
        this._bar = bar;
        return bar;
    }

    private _render(): void {
        const bar = this._ensureBar();
        bar.replaceChildren();
        const ordered = [...this._items].sort(
            (a, b) => (a.order ?? 100) - (b.order ?? 100),
        );
        for (const item of ordered) {
            bar.appendChild(this._makeButton(item));
        }
    }

    private _makeButton(item: ToolbarItem): HTMLButtonElement {
        const resolve = (v: string | (() => string) | undefined): string =>
            typeof v === "function" ? v() : v ?? "";
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = resolve(item.label);
        const title = resolve(item.title);
        if (title) b.title = title;
        b.style.cssText = [
            "appearance:none",
            "border:0",
            "background:transparent",
            "color:inherit",
            "font:inherit",
            "padding:6px 12px",
            "cursor:pointer",
            "white-space:nowrap",
        ].join(";");
        b.addEventListener("mouseenter", () => { b.style.background = "rgba(255,255,255,.12)"; });
        b.addEventListener("mouseleave", () => { b.style.background = "transparent"; });
        b.addEventListener("click", (e) => {
            if (this._moved) {
                // The press was a drag, not a click — swallow it.
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            item.onClick();
            // Re-render so dynamic labels/titles reflect any state change.
            this._render();
        });
        return b;
    }

    private _installDrag(bar: HTMLDivElement): void {
        const MARGIN = 4;
        const DRAG_THRESHOLD = 4;
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let startRight = 16;
        let startBottom = 16;

        const setPosition = (right: number, bottom: number): void => {
            const rect = bar.getBoundingClientRect();
            const maxRight = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
            const maxBottom = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
            bar.style.right = `${Math.min(Math.max(MARGIN, right), maxRight)}px`;
            bar.style.bottom = `${Math.min(Math.max(MARGIN, bottom), maxBottom)}px`;
        };

        bar.addEventListener("pointerdown", (e) => {
            dragging = true;
            this._moved = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = bar.getBoundingClientRect();
            startRight = window.innerWidth - rect.right;
            startBottom = window.innerHeight - rect.bottom;
            // Don't capture here — capturing on the bar would steal the ensuing
            // `click` from the child buttons. Capture only once a drag starts.
        });

        bar.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!this._moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
                this._moved = true;
                bar.setPointerCapture(e.pointerId);
            }
            if (!this._moved) return;
            setPosition(startRight - dx, startBottom - dy);
        });

        bar.addEventListener("pointerup", (e) => {
            dragging = false;
            if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
        });

        // Keep the bar fully on screen if the viewport shrinks (resize / rotate).
        window.addEventListener("resize", () => {
            const rect = bar.getBoundingClientRect();
            setPosition(window.innerWidth - rect.right, window.innerHeight - rect.bottom);
        });
    }
}

/** Install the built-in light/dark theme toggle on the toolbar. */
function addThemeToggle(toolbar: AdapterToolbar): void {
    let theme = effectiveTheme();
    toolbar.addItem({
        id: "theme",
        order: 100,
        label: () => (theme === "light" ? "☾ Dark" : "☀ Light"),
        title: "Toggle light / dark theme (drag the bar to move)",
        onClick: () => {
            theme = theme === "light" ? "dark" : "light";
            applyTheme(theme);
        },
    });
}

/** Build the adapter's contribution API around a live {@link AdapterToolbar}. */
function createAdapterApi(toolbar: AdapterToolbar): VsCodeAppAdapter {
    return {
        addToolbarItem: (item) => toolbar.addItem(item),
        enableComponentExplorer: () => {
            const inExplorer = new URLSearchParams(location.search).has(FIXTURES_PARAM);
            if (inExplorer) injectExplorerReset();
            toolbar.addItem({
                id: "component-explorer",
                order: 0,
                label: inExplorer ? "← Back to app" : "◫ Explorer",
                title: inExplorer
                    ? "Leave the Component Explorer (drag the bar to move)"
                    : "Open the Component Explorer (drag the bar to move)",
                onClick: () => {
                    const next = new URLSearchParams(location.search);
                    if (inExplorer) {
                        next.delete(FIXTURES_PARAM);
                    } else {
                        next.set(FIXTURES_PARAM, "");
                    }
                    const qs = next.toString().replace(/=(?=&|$)/g, ""); // tidy `fixtures=` → `fixtures`
                    location.search = qs;
                },
            });
            return inExplorer;
        },
    };
}

async function boot(): Promise<void> {
    // Defense in depth: a packaged app strips this script, but if it survives,
    // do nothing in prod.
    if (globalThis.VSCODE_APP_ENV === "prod") return;
    globalThis.VSCODE_APP_ENV = "dev";

    injectThemeStyles();
    installNoopHostShim();

    // Apply the effective theme up front (stored choice, else OS preference).
    // Unlike the old media-query fallback, the wrapper-class approach needs an
    // explicit apply for the variables to take effect.
    applyTheme(effectiveTheme());

    // Install the contribution API synchronously so it's available when the
    // app's (adapter-transformed) inline scripts run.
    const toolbar = new AdapterToolbar();
    globalThis.vscodeAppAdapter = createAdapterApi(toolbar);

    const start = (): void => {
        addThemeToggle(toolbar);
        void transformInlineScripts();
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
}

void boot();

export {};
