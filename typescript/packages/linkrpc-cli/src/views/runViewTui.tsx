import React from "react";
import { render } from "ink";
import { emitKeypressEvents, type Key } from "node:readline";
import { stdin, stdout } from "node:process";
import type { ViewSession } from "./types";
import { dispatchHostKey } from "./commands";
import { ViewFrame } from "./ViewFrame";

/** Runs any contributed view and drains its I/O before returning connection ownership. */
export async function runViewTui(session: ViewSession): Promise<void> {
    let instance: ReturnType<typeof render> | undefined;
    let ownsInput = false;
    const raw = stdin.isRaw;
    const flowing = stdin.readableFlowing === true;
    const onKey = (input: string, key: Key) =>
        dispatchHostKey(session, { ...key, input }, { quit: () => instance?.unmount() });
    const element = () => <ViewFrame session={session} rows={stdout.rows || 24} columns={stdout.columns || 80} />;
    const onResize = () => {
        instance?.rerender(element());
    };
    const onStop = () => instance?.unmount();
    try {
        if (!stdin.isTTY || !stdout.isTTY) throw new Error("--tui requires an interactive terminal; omit --tui for a snapshot");
        onResize();
        instance = render(element(), { stdin, stdout, exitOnCtrlC: false });
        emitKeypressEvents(stdin);
        stdin.setRawMode(true);
        ownsInput = true;
        stdin.resume();
        stdin.on("keypress", onKey);
        stdout.on("resize", onResize);
        process.once("SIGINT", onStop);
        process.once("SIGTERM", onStop);
        await instance.waitUntilExit();
    } finally {
        session.dispose();
        stdin.off("keypress", onKey);
        stdout.off("resize", onResize);
        process.off("SIGINT", onStop);
        process.off("SIGTERM", onStop);
        if (ownsInput) {
            stdin.setRawMode(raw ?? false);
            if (!flowing) stdin.pause();
        }
        instance?.unmount();
        await session.disposeAsync?.();
    }
}
