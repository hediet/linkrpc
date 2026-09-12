import { readFileSync } from "node:fs";
import {
    componentSchemaName,
    computeInterfaceHash,
    InterfaceDefinition,
    notificationType,
    requestType,
    type LinkRpcInterfaceSchema,
} from "@hediet/linkrpc";
import { generateTsInterface } from "../../../../linkrpc/src/schema/codegen/generateTsInterface";
import { materializeJsonSchema } from "../../../../linkrpc/src/schema/materializeJsonSchema";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { safeParse } from "zod/v4/core";
import ts from "typescript";
import {
    createProtocolInterfaceDefinition,
    importCdpProtocol,
    importLspProtocol,
} from "./index";

const corpus = (path: string): unknown =>
    JSON.parse(readFileSync(new URL(`../../../../../../conformance/protocols/${path}`, import.meta.url), "utf8"));

const cdp = () => importCdpProtocol(
    corpus("cdp-0.0.1677763/browser_protocol.json"),
    corpus("cdp-0.0.1677763/js_protocol.json"),
);
const lsp = () => importLspProtocol(corpus("lsp-3.17.5/metaModel.json"));

describe("pinned protocol contract import", () => {
    it("imports every CDP domain, command, event and reachable type", () => {
        const result = cdp();
        expect(Object.keys(result.interfaces)).toHaveLength(58);
        expect(result.bindings).toHaveLength(896);
        expect(result.bindings.find((b) => b.wireMethod === "Runtime.evaluate")).toEqual({
            wireMethod: "Runtime.evaluate",
            interfaceId: "cdp.runtime",
            member: "evaluate",
            kind: "request",
            direction: "clientToServer",
            source: "cdp",
        });
        expect(result.interfaces["cdp.dom"]!.components!.schemas!["DOM.Node"]).toBeDefined();
        expect(Object.values(result.interfaces).reduce(
            (count, schema) => count + Object.keys(schema.components?.schemas ?? {}).length,
            0,
        )).toBeGreaterThan(607);
        expectNoDanglingRefs(result.interfaces);
        expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        expect(result.diagnostics.some((d) => d.approximation === "true")).toBe(true);
    });

    it("imports the official LSP model with both message directions", () => {
        const result = lsp();
        expect(result.bindings).toHaveLength(95);
        expect(Object.keys(result.interfaces)).toEqual(expect.arrayContaining([
            "lsp.lifecycle",
            "lsp.protocol",
            "lsp.textdocument",
            "lsp.workspace",
        ]));
        expect(result.bindings.filter((b) => b.wireMethod === "$/progress")).toHaveLength(2);
        expect(result.interfaces["lsp.lifecycle"]!.methods.initialize).toBeDefined();
        expect(Object.values(result.interfaces).reduce(
            (count, schema) => count + Object.keys(schema.components?.schemas ?? {}).length,
            0,
        )).toBeGreaterThan(382);
        expectNoDanglingRefs(result.interfaces);
        expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    });

    it("has stable hashes and hash-invisible provenance metadata", () => {
        for (const result of [cdp(), lsp()]) {
            for (const schema of Object.values(result.interfaces)) {
                expect(schema.hash).toBe(computeInterfaceHash(schema));
                const edited = structuredClone(schema) as LinkRpcInterfaceSchema & Record<string, unknown>;
                edited["x-test-note"] = { changed: Math.random() };
                expect(computeInterfaceHash(edited)).toBe(schema.hash);
            }
        }
    });

    it("generates executable Zod for recursive representative contracts", () => {
        const cdpResult = cdp();
        const dom = cdpResult.interfaces["cdp.dom"]!;
        const source = generateTsInterface(dom, {
            exportName: "domProtocol",
            preserveWireSchema: true,
        });
        expect(source).toContain("z.lazy");
        expect(source).toContain("requestType(");
        expect(source).toContain("notificationType(");
        const domDefinition = evaluateGenerated(source);
        expect(safeParse(domDefinition.members.getDocument!.paramsSchema, {}).success).toBe(true);

        const lspResult = lsp();
        const workspace = lspResult.interfaces["lsp.workspace"]!;
        const workspaceSource = generateTsInterface(workspace, { preserveWireSchema: true });
        expect(workspaceSource).toContain("export const lspWorkspaceInterface");
        const workspaceDefinition = evaluateGenerated(workspaceSource);
        expect(safeParse(workspaceDefinition.members.didChangeConfiguration!.paramsSchema, {
            settings: {},
        }).success).toBe(true);

        const edit = workspace.components!.schemas!.WorkspaceEdit!;
        const exported = materializeJsonSchema(edit, workspace.components!.schemas);
        expect(exported.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
        expect(Object.keys(exported.$defs ?? {}).length).toBeGreaterThan(0);
    });

    it("type-checks every generated CDP and LSP interface", () => {
        const sources = [...Object.values(cdp().interfaces), ...Object.values(lsp().interfaces)]
            .map((schema, index) => [
                new URL(`generated-${index}.ts`, import.meta.url).pathname,
                generateTsInterface(schema, {
                    linkRpcImport: "../../../../linkrpc/src/index",
                    preserveWireSchema: true,
                }),
            ] as const);
        const virtual = new Map(sources);
        const options: ts.CompilerOptions = {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            strict: true,
            skipLibCheck: true,
            noEmit: true,
        };
        const host = ts.createCompilerHost(options);
        const getSourceFile = host.getSourceFile.bind(host);
        const fileExists = host.fileExists.bind(host);
        const readFile = host.readFile.bind(host);
        host.fileExists = (fileName) => virtual.has(fileName) || fileExists(fileName);
        host.readFile = (fileName) => virtual.get(fileName) ?? readFile(fileName);
        host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
            const source = virtual.get(fileName);
            return source === undefined
                ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
                : ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS);
        };
        const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([...virtual.keys()], options, host));
        expect(diagnostics.map(formatDiagnostic)).toEqual([]);
    }, 15_000);

    it("creates runtime definitions with corpus-derived validators", () => {
        const cdpContracts = cdp();
        const lspContracts = lsp();
        for (const contract of [cdpContracts, lspContracts]) {
            for (const schema of Object.values(contract.interfaces)) {
                expect(createProtocolInterfaceDefinition(schema).schemaHash).toBe(schema.hash);
            }
        }

        const cdpRuntime = cdpContracts.interfaces["cdp.runtime"]!;
        const cdpDefinition = createProtocolInterfaceDefinition(cdpRuntime);
        expect(safeParse(cdpDefinition.members.evaluate!.paramsSchema, {
            expression: "1 + 1",
        }).success).toBe(true);
        expect(safeParse(cdpDefinition.members.evaluate!.paramsSchema, {}).success).toBe(false);
        expect(cdpDefinition.schemaHash).toBe(cdpRuntime.hash);

        const lspTextDocument = lspContracts.interfaces["lsp.textdocument"]!;
        const lspDefinition = createProtocolInterfaceDefinition(lspTextDocument);
        expect(safeParse(lspDefinition.members.didOpen!.paramsSchema, {
            textDocument: {
                uri: "file:///sample.ts",
                languageId: "typescript",
                version: 1,
                text: "const value = 1;",
            },
        }).success).toBe(true);
        expect(safeParse(lspDefinition.members.didOpen!.paramsSchema, {
            textDocument: { uri: "file:///sample.ts" },
        }).success).toBe(false);
        expect(lspDefinition.schemaHash).toBe(lspTextDocument.hash);
    });

    it("preserves omitted LSP params and exports int32 refinements", () => {
        const result = importLspProtocol(lspModel({
            requests: [{
                method: "shutdown",
                messageDirection: "clientToServer",
                result: { kind: "base", name: "null" },
            }, {
                method: "number",
                messageDirection: "clientToServer",
                params: { kind: "base", name: "integer" },
                result: { kind: "base", name: "null" },
            }],
        }));
        expect(result.interfaces["lsp.lifecycle"]!.methods.shutdown!.params).toBe(true);
        const definition = createProtocolInterfaceDefinition(result.interfaces["lsp.lifecycle"]!);
        expect(safeParse(definition.members.shutdown!.paramsSchema, undefined).success).toBe(true);
        expect(safeParse(definition.members.number!.paramsSchema, -2147483648).success).toBe(true);
        expect(materializeJsonSchema(
            result.interfaces["lsp.lifecycle"]!.methods.number!.params,
        ).allOf).toContainEqual({ minimum: -2147483648, maximum: 2147483647 });
    });

    it("rejects duplicate CDP names and invalid reference graphs", () => {
        expect(() => importCdpProtocol(cdpDocument([
            { domain: "Foo" },
            { domain: "foo" },
        ]), cdpDocument([]))).toThrow("collide after normalization");
        expect(() => importCdpProtocol(cdpDocument([{
            domain: "Foo",
            commands: [{ name: "same" }],
            events: [{ name: "same" }],
        }]), cdpDocument([]))).toThrow("duplicate CDP member");
        expect(() => importCdpProtocol(cdpDocument([{
            domain: "Foo",
            commands: [{ name: "run", parameters: [
                { name: "value", type: "string" },
                { name: "value", type: "string" },
            ] }],
        }]), cdpDocument([]))).toThrow("duplicate CDP field");
        expect(() => importCdpProtocol(cdpDocument([{
            domain: "Foo",
            commands: [{ name: "run", parameters: [{ name: "value", $ref: "Missing" }] }],
        }]), cdpDocument([]))).toThrow("Unresolved component reference");
        expect(() => importLspProtocol(lspModel({
            typeAliases: [{ name: "Loop", type: { kind: "reference", name: "Loop" } }],
            requests: [{
                method: "loop",
                messageDirection: "clientToServer",
                params: { kind: "reference", name: "Loop" },
                result: { kind: "base", name: "null" },
            }],
        }))).toThrow("Unguarded recursive schema");
    });
});

function cdpDocument(domains: unknown[]): unknown {
    return { version: { major: "1", minor: "3" }, domains };
}

function lspModel(overrides: Record<string, unknown>): unknown {
    return {
        metaData: { version: "test" },
        requests: [],
        notifications: [],
        structures: [],
        enumerations: [],
        typeAliases: [],
        ...overrides,
    };
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1}: ${message}`;
}

function evaluateGenerated(source: string): {
    members: Record<string, { paramsSchema: z.ZodType }>;
} {
    const js = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
    const body = js
        .replace(/^import [^\n]*\n/gm, "")
        .replace(/^export const /m, "return ");
    const evaluate = new Function(
        "z",
        "InterfaceDefinition",
        "requestType",
        "notificationType",
        body,
    );
    return evaluate(z, InterfaceDefinition, requestType, notificationType);
}

function expectNoDanglingRefs(interfaces: Record<string, LinkRpcInterfaceSchema>): void {
    for (const schema of Object.values(interfaces)) {
        const definitions = schema.components?.schemas ?? {};
        const inspect = (value: unknown): void => {
            if (value === null || typeof value !== "object") return;
            if (Array.isArray(value)) {
                value.forEach(inspect);
                return;
            }
            const record = value as Record<string, unknown>;
            if (typeof record.$ref === "string" && record.$ref.startsWith("#/components/schemas/")) {
                const name = componentSchemaName(record.$ref);
                expect(definitions[name], `${schema.id}: ${record.$ref}`).toBeDefined();
            }
            for (const [key, child] of Object.entries(record)) {
                if (!key.startsWith("x-")) inspect(child);
            }
        };
        inspect(schema.methods);
        inspect(definitions);
    }
}
