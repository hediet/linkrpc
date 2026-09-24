import React from "react";
import { PassThrough } from "node:stream";
import { stdin, stdout } from "node:process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Box, Text, render } from "ink";
import { derived, observableValue } from "@vscode/observables";
import { runViewTui } from "./runViewTui";
import { CommandLegend } from "./CommandLegend";
import { TerminalKeyInput } from "./TerminalKeyInput";
import { dispatchHostKey } from "./commands";
import type { ViewCommand, ViewSession } from "./types";
import { ViewFrame } from "./ViewFrame";

// These fixtures emulate an interactive terminal, including in CI workers.
vi.hoisted(() => { vi.stubEnv("CI", "false"); });
afterAll(() => { vi.unstubAllEnvs(); });

vi.mock("node:process", async () => {
    const { PassThrough } = await import("node:stream");
    return {
        stdin: Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() }),
        stdout: Object.assign(new PassThrough(), { isTTY: true, rows: 30, columns: 160 }),
    };
});

const dispose: (() => void)[] = [];
afterEach(() => { dispose.splice(0).forEach(value => value()); });
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function fixture() {
    const state = observableValue("state", { editing: false, text: "", enabled: true });
    const move = vi.fn();
    const session: ViewSession = {
        element: <Text>Example view</Text>,
        get capturesInput() { return state.get().editing; },
        commands: derived(reader => {
            const value = state.read(reader);
            return (value.editing ? [{
                id: "finish", title: "Finish editing", keybindings: [{ key: "return" }],
                execute: () => state.set({ ...state.get(), editing: false }, undefined),
            }] : [{
                id: "edit", title: "Edit params", keybindings: [{ key: "p" }],
                execute: () => state.set({ ...state.get(), editing: true }, undefined),
            }, {
                id: "end", title: "Last row", keybindings: [{ key: "end" }], enabled: value.enabled, execute: move,
            }]) satisfies readonly ViewCommand[];
        }),
        handleTextInput(event) {
            state.set({ ...state.get(), text: state.get().text + event.input }, undefined);
            return true;
        },
        dispose: vi.fn(),
        setViewport: vi.fn(),
    };
    return { session, state, move };
}

describe("generic Ink view hosts", () => {
    it("measures the actual content container rather than the process terminal width", async () => {
        const { session } = fixture();
        const output = Object.assign(new PassThrough(), { columns: 120 });
        const element = (width: number) => <Box width={width}>
            <ViewFrame session={session} rows={18} />
        </Box>;
        const instance = render(element(57), { stdin, stdout: output as never, stderr: output as never,
            debug: true, exitOnCtrlC: false, patchConsole: false });
        dispose.push(() => { instance.unmount(); output.destroy(); });
        await settle();
        expect(session.setViewport).toHaveBeenLastCalledWith(expect.any(Number), 57);
        instance.rerender(element(33));
        await settle();
        expect(session.setViewport).toHaveBeenLastCalledWith(expect.any(Number), 33);
    });

    it("routes real standalone terminal keys and updates generated help while editing", async () => {
        const { session, state, move } = fixture();
        let output = "";
        const onData = (chunk: Buffer) => { output += String(chunk); };
        stdout.on("data", onData);
        const running = runViewTui(session);
        dispose.push(() => { stdout.off("data", onData); stdin.emit("keypress", "q", { name: "q" }); });
        await settle();
        expect(output).toContain("Edit params");
        (stdin as unknown as PassThrough).write("\x1b[F");
        expect(move).toHaveBeenCalledOnce();
        (stdin as unknown as PassThrough).write("p");
        await settle();
        expect(output).toContain("Finish editing");
        (stdin as unknown as PassThrough).write("qv");
        expect(state.get().text).toBe("qv");
        expect(session.dispose).not.toHaveBeenCalled();
        (stdin as unknown as PassThrough).write("\r");
        (stdin as unknown as PassThrough).write("q");
        await running;
        expect(session.dispose).toHaveBeenCalledOnce();
        expect(stdin.listenerCount("keypress")).toBe(0);
        expect(stdout.listenerCount("resize")).toBe(0);
    });

    it("drains asynchronous cleanup and reserves Ctrl+C even when capturing", async () => {
        const { session, state } = fixture();
        state.set({ ...state.get(), editing: true }, undefined);
        let finish!: () => void;
        const cleanup = new Promise<void>(resolve => { finish = resolve; });
        const disposeAsync = vi.fn(() => cleanup);
        let returned = false;
        const running = runViewTui({ ...session, capturesInput: true, disposeAsync }).then(() => { returned = true; });
        await settle();
        (stdin as unknown as PassThrough).write("\x03");
        await settle();
        expect(disposeAsync).toHaveBeenCalledOnce();
        expect(returned).toBe(false);
        finish();
        await running;
        expect(returned).toBe(true);
    });

    it("routes tab-host commands only once and renders dynamic availability", async () => {
        const { session, state, move } = fixture();
        const quit = vi.fn(), nextTab = vi.fn();
        const output = new PassThrough();
        let text = "";
        output.on("data", chunk => { text += String(chunk); });
        const instance = render(<Box flexDirection="column">
            <TerminalKeyInput onKey={event => dispatchHostKey(session, event, { quit, nextTab })} />
            <CommandLegend session={session} tabbed />
        </Box>, { stdin, stdout: output as never, stderr: output as never, debug: true, exitOnCtrlC: false, patchConsole: false });
        dispose.push(() => { instance.unmount(); output.destroy(); });
        stdin.resume();
        await settle();
        expect(text).toContain("End: Last row");
        (stdin as unknown as PassThrough).write("\x1b[F");
        expect(move).toHaveBeenCalledOnce();
        (stdin as unknown as PassThrough).write("\t");
        expect(nextTab).toHaveBeenCalledOnce();
        state.set({ ...state.get(), enabled: false }, undefined);
        text = "";
        await settle();
        expect(text).not.toContain("Last row");
        (stdin as unknown as PassThrough).write("\x1b[F");
        expect(move).toHaveBeenCalledOnce();
        (stdin as unknown as PassThrough).write("p");
        await settle();
        (stdin as unknown as PassThrough).write("q");
        expect(quit).not.toHaveBeenCalled();
        expect(state.get().text).toBe("q");
        instance.unmount();
        expect(stdin.listenerCount("keypress")).toBe(0);
    });
});
