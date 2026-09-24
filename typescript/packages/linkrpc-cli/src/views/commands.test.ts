import React from "react";
import { describe, expect, it, vi } from "vitest";
import { observableValue } from "@vscode/observables";
import type { ViewCommand, ViewSession } from "./types";
import { availableViewCommands, dispatchHostKey, dispatchViewKey, formatCommandLegend, hostCommands } from "./commands";

function fixture() {
    const execute = vi.fn();
    const commands = observableValue<readonly ViewCommand[]>("commands", [{
        id: "test.refresh", title: "Refresh", keybindings: [{ key: "r" }], execute,
    }]);
    const session: ViewSession = {
        element: React.createElement(React.Fragment), commands, dispose: vi.fn(), handleTextInput: vi.fn(() => true),
    };
    return { session, commands, execute };
}

describe("declarative view commands", () => {
    it("dispatches at most one matching enabled command and reports handled", () => {
        const { session, commands, execute } = fixture();
        const duplicate = vi.fn();
        commands.set([...commands.get(), { id: "second", title: "Second", keybindings: [{ key: "r" }], execute: duplicate }], undefined);
        expect(dispatchViewKey(session, { input: "r" })).toBe(true);
        expect(execute).toHaveBeenCalledOnce();
        expect(duplicate).not.toHaveBeenCalled();
        expect(formatCommandLegend(commands.get())).toBe("r: Refresh");
        expect(session.handleTextInput).not.toHaveBeenCalled();
        expect(dispatchViewKey(session, { input: "R", shift: true })).toBe(false);
        expect(dispatchViewKey(session, { input: "r", ctrl: true })).toBe(false);
    });

    it("does not execute disabled commands or advertise them", () => {
        const { session, commands, execute } = fixture();
        commands.set([{ ...commands.get()[0]!, enabled: false }], undefined);
        expect(dispatchViewKey(session, { input: "r" })).toBe(false);
        expect(execute).not.toHaveBeenCalled();
        expect(formatCommandLegend(commands.get())).toBe("");
        commands.set([{ ...commands.get()[0]!, enabled: true, title: "Resume", context: "Paused" }], undefined);
        expect(formatCommandLegend(commands.get())).toBe("r: Resume");
        expect(dispatchViewKey(session, { input: "r" })).toBe(true);
    });

    it("reserves quit/tab/scope/back for the host and excludes conflicting view help", () => {
        const { session, commands, execute } = fixture();
        commands.set([{
            id: "test.conflict", title: "Conflict",
            keybindings: ["q", "tab", "v", "escape", "r"].map(key => ({ key })), execute,
        }], undefined);
        const actions = { quit: vi.fn(), nextTab: vi.fn(), toggleScope: vi.fn(), back: vi.fn() };
        for (const event of [{ input: "q" }, { input: "", name: "tab" }, { input: "v" }, { input: "", name: "escape" }]) {
            expect(dispatchHostKey(session, event, actions)).toBe(true);
        }
        for (const action of Object.values(actions)) expect(action).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
        expect(formatCommandLegend(availableViewCommands(commands.get(), hostCommands(actions)))).toBe("r: Conflict");
        expect(dispatchHostKey(session, { input: "r" }, actions)).toBe(true);
        expect(execute).toHaveBeenCalledOnce();
    });

    it("allows q/v/tab in capture but never allows overriding Ctrl+C", () => {
        const { session, commands, execute } = fixture();
        const capturing: ViewSession = { ...session, capturesInput: true };
        const actions = { quit: vi.fn(), nextTab: vi.fn(), toggleScope: vi.fn(), back: vi.fn() };
        for (const event of [{ input: "q" }, { input: "v" }, { input: "", name: "tab" }]) {
            expect(dispatchHostKey(capturing, event, actions)).toBe(true);
        }
        expect(session.handleTextInput).toHaveBeenCalledTimes(3);
        expect(actions.quit).not.toHaveBeenCalled();
        expect(actions.nextTab).not.toHaveBeenCalled();
        commands.set([{ id: "intercept", title: "Intercept", keybindings: [{ key: "c", ctrl: true }], execute }], undefined);
        expect(dispatchHostKey(capturing, { input: "\x03", name: "c", ctrl: true }, actions)).toBe(true);
        expect(actions.quit).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
        expect(session.handleTextInput).toHaveBeenCalledTimes(3);
        expect(formatCommandLegend(hostCommands(actions, true))).toBe("Ctrl+c: Quit");
    });
});
