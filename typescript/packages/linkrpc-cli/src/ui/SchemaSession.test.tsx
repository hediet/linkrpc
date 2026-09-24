import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { observableValue } from "@vscode/observables";
import type { SchemaState } from "./UiModel";
import { SchemaSession } from "./SchemaSession";
import { dispatchViewKey } from "../views/commands";
import { defineInterface, type JsonValue } from "@hediet/linkrpc";
import { GraphObjects, GraphRoot, graphRefSchema } from "@hediet/linkrpc-infra/graph";
import { z } from "zod";
import { Box } from "ink";
import { ViewFrame } from "../views/ViewFrame";

describe("Schema view", () => {
    it("bounds a real nested graph schema across container resizes and scroll positions", async () => {
        const objects = GraphObjects({ ref: graphRefSchema, value: z.unknown() as z.ZodType<JsonValue> });
        const root = GraphRoot({ params: z.object({ filter: z.object({
            text: z.string().describe("漢字😀".repeat(30) + "\nA multiline schema description"),
            scope: z.array(z.string()),
        }) }), ref: graphRefSchema });
        const contract = defineInterface({ id: "canonical.graph.schema" }, {
            fetch: objects.members.batchObjGet, watch: root.members.watch,
        }, { templates: { objects: objects.mapMembers({ batchObjGet: "fetch" }), sessions: root.mapMembers({ watch: "watch" }) } });
        const schema = observableValue<SchemaState>("canonical", { kind: "loaded", method: undefined, schema: contract.toSchema() });
        const session = new SchemaSession(schema);
        expect(session.lines.get().length).toBeGreaterThan(400);
        const output = Object.assign(new PassThrough(), { columns: 100 });
        let frame = "";
        output.on("data", chunk => { if (String(chunk).includes("SCHEMA")) frame = stripVTControlCharacters(String(chunk)); });
        const element = (width: number, rows: number) => <Box width={width} height={rows}>
            <ViewFrame session={session} rows={rows} tabbed />
        </Box>;
        const instance = render(element(78, 24), { stdout: output as never, stderr: output as never,
            stdin: new PassThrough() as never, debug: true, exitOnCtrlC: false, patchConsole: false });
        try {
            for (const [width, rows] of [[78, 24], [46, 18], [40, 13], [78, 24]]) {
                instance.rerender(element(width!, rows!));
                await new Promise(resolve => setTimeout(resolve, 30));
                for (const name of ["pagedown", "end", "home"]) {
                    dispatchViewKey(session, { input: "", name });
                    await new Promise(resolve => setTimeout(resolve, 15));
                    const lines = frame.trimEnd().split("\n");
                    expect(lines).toHaveLength(rows!);
                    expect(lines.every(line => [...line].length <= width!)).toBe(true);
                    expect(frame).not.toContain("\\u{000a}");
                    expect(session.viewport.get().columns).toBe(width);
                    expect(session.viewport.get().rows).toBeGreaterThanOrEqual(rows! - 2);
                }
                const unicodeLine = session.lines.get().findIndex(line => line.includes("漢字"));
                session.viewport.set({ ...session.viewport.get(), top: unicodeLine, left: 20 }, undefined);
                await new Promise(resolve => setTimeout(resolve, 15));
                expect(frame.trimEnd().split("\n").every(line => terminalCells(line) <= width!)).toBe(true);
            }
        } finally { instance.unmount(); session.dispose(); output.destroy(); }
    });

    function terminalCells(text: string): number {
        return [...text].reduce((width, character) => width + (/[\p{Mark}]/u.test(character) ? 0
            : /[\p{Extended_Pictographic}\u2e80-\ua4cf]/u.test(character) ? 2 : 1), 0);
    }

    it("preserves JSON lines and scrolls vertically and horizontally within its measured viewport", async () => {
        const schema = observableValue<SchemaState>("schema", {
            kind: "loaded", method: undefined,
            schema: { id: "example.schema", hash: "h", methods: {},
                tags: Array.from({ length: 30 }, (_, index) => `tag${index}-${"long".repeat(20)}`) },
        });
        const session = new SchemaSession(schema);
        session.setViewport(12, 42);
        const initial = await capture(session);
        expect(initial.split("\n")).toHaveLength(12);
        expect(initial).toContain('  "id": "example.schema",');
        expect(initial).not.toContain("\\u{000a}");
        expect(initial.split("\n").every(line => [...line].length <= 42)).toBe(true);
        dispatchViewKey(session, { input: "", name: "pagedown" });
        expect(session.viewport.get().top).toBe(10);
        dispatchViewKey(session, { input: "", name: "end" });
        expect((await capture(session)).split("\n").at(-1)).toContain(`/${session.lines.get().length}`);
        expect(await capture(session)).toContain("\n}\n");
        dispatchViewKey(session, { input: "", name: "right" });
        expect(session.viewport.get().left).toBe(20);
        dispatchViewKey(session, { input: "", name: "left" });
        expect(session.viewport.get().left).toBe(0);
        dispatchViewKey(session, { input: "", name: "home" });
        expect(session.viewport.get().top).toBe(0);
        expect(dispatchViewKey(session, { input: "", name: "up" })).toBe(false);
        session.dispose();
        expect(session.commands.get()).toEqual([]);
    });
});

async function capture(session: SchemaSession): Promise<string> {
    const output = Object.assign(new PassThrough(), { columns: session.viewport.get().columns });
    let frame = "";
    output.on("data", chunk => { if (String(chunk).includes("SCHEMA")) frame = String(chunk); });
    const instance = render(session.element, { stdout: output as never, stderr: output as never,
        stdin: new PassThrough() as never, debug: true, exitOnCtrlC: false, patchConsole: false });
    try {
        await new Promise(resolve => setTimeout(resolve, 20));
        return stripVTControlCharacters(frame).trimEnd();
    } finally { instance.unmount(); output.destroy(); }
}
