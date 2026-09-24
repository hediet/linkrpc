import type { ViewCommand, ViewKeybinding, ViewKeyEvent, ViewSession } from "./types";

export interface ViewHostActions {
    readonly quit: () => void;
    readonly nextTab?: () => void;
    readonly toggleScope?: () => void;
    readonly back?: () => void;
}

export function matchesKey(binding: ViewKeybinding, event: ViewKeyEvent): boolean {
    return (binding.key.length === 1 && !binding.ctrl && !binding.meta ? event.input === binding.key
        : event.name === binding.key || event.input === binding.key)
        && !!binding.ctrl === !!event.ctrl && !!binding.meta === !!event.meta
        // Terminals often infer shift for uppercase letters. The literal already encodes it.
        && (binding.shift === undefined && binding.key.length === 1 || !!binding.shift === !!event.shift);
}

/** Host bindings take precedence; capture only releases ordinary keys, never Ctrl+C. */
export function hostCommands(actions: ViewHostActions, capturesInput = false): readonly ViewCommand[] {
    return [
        { id: "host.quit", title: "Quit", keybindings: [{ key: "c", ctrl: true }, ...capturesInput ? [] : [{ key: "q" }]], execute: actions.quit },
        ...capturesInput ? [] : [
            ...actions.nextTab ? [{ id: "host.nextTab", title: "Next view", keybindings: [{ key: "tab" }], execute: actions.nextTab }] : [],
            ...actions.toggleScope ? [{ id: "host.scope", title: "Switch scope", keybindings: [{ key: "v" }], execute: actions.toggleScope }] : [],
            ...actions.back ? [{ id: "host.back", title: "Services", keybindings: [{ key: "escape" }], execute: actions.back }] : [],
        ],
    ];
}

export function availableViewCommands(
    commands: readonly ViewCommand[], reserved: readonly ViewCommand[] = [],
): readonly ViewCommand[] {
    const claimed = reserved.filter(command => command.enabled !== false).flatMap(command => command.keybindings);
    const result: ViewCommand[] = [];
    for (const command of commands) {
        if (command.enabled === false) continue;
        const keybindings = command.keybindings.filter(binding => !claimed.some(key =>
            key.key === binding.key && !!key.ctrl === !!binding.ctrl && !!key.meta === !!binding.meta
            && (key.key.length === 1 && (key.shift === undefined || binding.shift === undefined)
                || !!key.shift === !!binding.shift)));
        claimed.push(...keybindings);
        if (keybindings.length > 0) result.push({ ...command, keybindings });
    }
    return result;
}

function dispatch(commands: readonly ViewCommand[], event: ViewKeyEvent): boolean {
    const command = commands.find(command => command.enabled !== false
        && command.keybindings.some(binding => matchesKey(binding, event)));
    if (!command) return false;
    command.execute();
    return true;
}

export function dispatchViewKey(session: ViewSession, event: ViewKeyEvent): boolean {
    if (dispatch(session.commands.get(), event)) return true;
    return session.capturesInput === true && session.handleTextInput?.(event) === true;
}

/** A true result means consumed: callers must not dispatch the event a second time. */
export function dispatchHostKey(session: ViewSession | undefined, event: ViewKeyEvent, actions: ViewHostActions): boolean {
    if (dispatch(hostCommands(actions, session?.capturesInput), event)) return true;
    return session ? dispatchViewKey(session, event) : false;
}

export function formatKeybinding(binding: ViewKeybinding): string {
    const labels: Record<string, string> = {
        up: "↑", down: "↓", left: "←", right: "→", return: "Enter", escape: "Esc",
        pageup: "PgUp", pagedown: "PgDn", home: "Home", end: "End", tab: "Tab",
        backspace: "Backspace", delete: "Delete", " ": "Space",
    };
    return `${binding.ctrl ? "Ctrl+" : ""}${binding.meta ? "Alt+" : ""}${binding.shift ? "Shift+" : ""}${labels[binding.key] ?? binding.key}`;
}

export function formatCommandLegend(commands: readonly ViewCommand[]): string {
    return availableViewCommands(commands).map(command =>
        `${command.keybindings.map(formatKeybinding).join("/")}: ${command.title}`).join(" · ");
}
