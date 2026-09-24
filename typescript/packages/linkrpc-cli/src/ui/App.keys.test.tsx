import React from "react";
import { PassThrough } from "node:stream";
import { stdin, stdout } from "node:process";
import { stripVTControlCharacters } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Box, Text, render } from "ink";
import { derived, observableValue } from "@vscode/observables";
import { z } from "zod";
import { defineInterface, LinkRpcConnection, requestType, TransportPair } from "@hediet/linkrpc";
import { connectViaTransport } from "@hediet/linkrpc-client";
import { App, uiLayout } from "./App";
import { UiModel } from "./UiModel";
import type { ViewCommand, ViewSession } from "../views/types";

// Ink suppresses intermediate frames in CI unless interactive mode is explicit.
vi.hoisted(() => { vi.stubEnv("CI", "false"); });
afterAll(() => { vi.unstubAllEnvs(); });

vi.mock("node:process", async () => {
    const { PassThrough } = await import("node:stream");
    return {
        stdin: Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() }),
        stdout: Object.assign(new PassThrough(), { isTTY: true, rows: 38, columns: 150 }),
    };
});
const sessions: ReturnType<typeof createSession>[] = [];
function createSession() {
    const state = observableValue("state", { editing: false, text: "" });
    const move = vi.fn(), dispose = vi.fn(), setViewport = vi.fn();
    const session: ViewSession = {
        element: <Text>Contributed content</Text>,
        commands: derived(reader => state.read(reader).editing ? [{
            id: "finish", title: "Finish parameters", keybindings: [{ key: "return" }],
            execute: () => state.set({ ...state.get(), editing: false }, undefined),
        }] : [
            { id: "last", title: "Last row", keybindings: [{ key: "end" }], execute: move },
            { id: "params", title: "Edit parameters", keybindings: [{ key: "p" }],
                execute: () => state.set({ ...state.get(), editing: true }, undefined) },
        ] satisfies readonly ViewCommand[]),
        get capturesInput() { return state.get().editing; },
        handleTextInput(event) { state.set({ ...state.get(), text: state.get().text + event.input }, undefined); return true; },
        dispose,
        setViewport,
    };
    return { session, state, move, dispose, setViewport };
}
vi.mock("../views/registry", () => ({
    views: [{
        id: "probe", title: "Probe", modes: ["tui"], conditions: [{ kind: "interface", interface: { tag: "probe" } }],
        createSession() { const fixture = createSession(); sessions.push(fixture); return fixture.session; },
    }],
}));
async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("UI did not settle");
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const write = (value: string) => (stdin as unknown as PassThrough).write(value);

describe("rpc ui contributed keyboard integration", () => {
    it("keeps text capture isolated, dispatches Home/End once, and disposes inactive tabs", async () => {
        const contract = defineInterface({ id: "probe", tags: ["probe"] }, {
            hello: requestType(z.object({}), z.object({})),
        });
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.b);
        server.register(contract, { hello: async () => ({}) });
        server.enableReflection();
        const conn = connectViaTransport(pair.a);
        const model = new UiModel(conn.channel);
        let text = "";
        const paints: string[] = [];
        const capture = (chunk: Buffer) => { text += String(chunk); paints.push(String(chunk)); };
        stdout.on("data", capture);
        // The content container is deliberately narrower than process.stdout.
        const instance = render(<Box width={93}><App model={model} /></Box>, { stdin, stdout, stderr: stdout, exitOnCtrlC: false, patchConsole: false });
        try {
            await waitFor(() => model.servicesPromise.promiseResult.get()?.data !== undefined);
            const service = model.servicesPromise.promiseResult.get()!.data!.find(value => value.interfaceId === "probe")!;
            model.selection.set({ ...service, methodName: undefined }, undefined);
            model.focusColumn(1);
            await waitFor(() => model.currentSchemaState.get().kind === "loaded");
            model.views.tab.set("probe", undefined);
            await waitFor(() => model.views.session.get() !== undefined);
            await waitFor(() => text.includes("Contributed content"));
            const current = sessions.at(-1)!;
            await waitFor(() => (current.setViewport.mock.calls.at(-1)?.[1] ?? 0) > 1);
            const [contentRows, contentColumns] = current.setViewport.mock.calls.at(-1)!;
            expect(contentColumns).toBe(73);
            expect(contentRows).toBeGreaterThan(25); // No eight-row Methods result reservation.
            expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
            expect(text).toContain("Contributed content");
            expect(text).toContain("End:");
            expect(text).toContain("Last row");
            write("\x1b[F");
            await settle();
            expect(current.move).toHaveBeenCalledOnce();
            write("p");
            await settle();
            write("qvr");
            await settle();
            expect(current.state.get().text).toBe("qvr");
            expect(model.views.tab.get()).toBe("probe");
            expect(model.views.kind.get()).toBe("interface");
            expect(current.dispose).not.toHaveBeenCalled();
            write("\r");
            await settle();
            write("\t");
            await settle();
            expect(model.views.tab.get()).toBe("methods");
            expect(current.dispose).toHaveBeenCalledOnce();
            await waitFor(() => {
                const plain = stripVTControlCharacters(text);
                return plain.slice(plain.lastIndexOf("identity:")).includes("Result");
            });
            const plain = stripVTControlCharacters(text);
            const methodsFrame = plain.slice(plain.lastIndexOf("identity:")).split("\n");
            const result = methodsFrame.find(line => line.includes("Result"))!;
            expect(result.indexOf("Result")).toBeGreaterThan(uiLayout(93, 38, 1).sidebarWidth);
            expect(result[0]).toBe("│"); // The full-height Services pane continues beside Result.
            write("\t");
            await waitFor(() => model.views.tab.get() === "schema");
            await waitFor(() => text.includes("SCHEMA probe"));
            expect(model.views.session.get()?.commands.get().some(command => command.id.startsWith("schema."))).toBe(true);
            instance.rerender(<App model={model} />);
            await settle();
            for (const [columns, rows] of [[100, 28], [64, 28], [64, 22], [40, 22], [40, 16], [100, 28]]) {
                paints.length = 0;
                Object.assign(stdout, { columns, rows });
                stdout.emit("resize");
                await settle();
                const frames = paints.map(stripVTControlCharacters).filter(frame => frame.includes("identity:"));
                expect(frames.length).toBeGreaterThan(0);
                for (const frame of frames) {
                    const lines = frame.split("\n");
                    expect(lines.length).toBeLessThanOrEqual(rows!);
                    expect(lines.every(line => [...line].length <= columns!)).toBe(true);
                    expect(frame).not.toContain("Result");
                }
            }
            write("q");
            await instance.waitUntilExit();
            expect(stdin.listenerCount("keypress")).toBe(0);
        } finally {
            instance.unmount();
            model.dispose();
            await model.views.waitForIdle();
            conn.close(); server.close();
            stdout.off("data", capture);
            Object.assign(stdout, { rows: 38, columns: 150 });
        }
    });

    describe("responsive UI geometry", () => {
        it.each([[100, 28], [64, 22], [40, 16], [12, 7], [1, 1]])("bounds every pane at %ix%i", (columns, rows) => {
            for (const focused of [0, 1, 2]) {
                const layout = uiLayout(columns, rows, focused, 20);
                expect(layout.headerRows + layout.bodyRows + layout.footerRows).toBe(rows);
                expect(layout.sidebarWidth + layout.mainWidth).toBe(columns);
                expect(layout.viewHeaderRows + layout.methodRows + layout.resultRows).toBe(layout.bodyRows);
                expect(layout.mainWidth).toBeGreaterThanOrEqual(0);
                expect(layout.resultRows).toBeGreaterThanOrEqual(0);
            }
        });
        it("uses a focus-switched full-width pane rather than an unusable narrow sidebar", () => {
            expect(uiLayout(40, 16, 0)).toMatchObject({ sidebarWidth: 40, mainWidth: 0 });
            expect(uiLayout(40, 16, 1)).toMatchObject({ sidebarWidth: 0, mainWidth: 40, splitMethods: false });
            expect(uiLayout(100, 28, 1)).toMatchObject({ sidebarWidth: 22, mainWidth: 78, splitMethods: true });
        });
    });
});
