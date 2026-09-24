import React from "react";
import { stdin } from "node:process";
import { emitKeypressEvents, type Key } from "node:readline";
import type { ViewKeyEvent } from "./types";

/** Readline preserves named keys such as Home/End that Ink's Key type omits. */
export class TerminalKeyInput extends React.Component<{ readonly onKey: (event: ViewKeyEvent) => void }> {
    private readonly onKey = (input: string, key: Key) => this.props.onKey({ ...key, input });
    componentDidMount(): void {
        emitKeypressEvents(stdin);
        stdin.on("keypress", this.onKey);
    }
    componentWillUnmount(): void { stdin.off("keypress", this.onKey); }
    render(): React.ReactNode { return null; }
}
