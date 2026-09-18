import {
    InterfaceDefinition,
    type BareInterfaceTarget,
    type LinkRpcInterfaceSchema,
    type MemberMap,
} from "@hediet/linkrpc";
import * as linkRpc from "@hediet/linkrpc";
import { generateTsInterface } from "../../../../linkrpc/src/schema/codegen/generateTsInterface";
import ts from "typescript";
import * as zod from "zod";

const definitions = new WeakMap<LinkRpcInterfaceSchema, InterfaceDefinition<MemberMap>>();

/**
 * Test-only bridge that compiles and executes the real generated TypeScript
 * against the installed LinkRPC and Zod modules.
 */
export function createGeneratedProtocolInterfaceDefinition(
    schema: LinkRpcInterfaceSchema,
): InterfaceDefinition<MemberMap> {
    const cached = definitions.get(schema);
    if (cached !== undefined) return cached;

    const source = generateTsInterface(schema, {
        exportName: "generatedProtocolInterface",
        preserveWireSchema: true,
    });
    const exported = evaluateGeneratedModule(source).generatedProtocolInterface;
    if (!(exported instanceof InterfaceDefinition)) {
        throw new Error("Generated module did not export an InterfaceDefinition");
    }

    // instanceof validates the dynamic module boundary; the generic member map
    // is intentionally erased by JavaScript evaluation.
    const definition: InterfaceDefinition<MemberMap> = exported;
    definitions.set(schema, definition);
    return definition;
}

/** Compile and execute a generated module that exports a bare target. */
export function createGeneratedProtocolBareTarget(
    schema: LinkRpcInterfaceSchema,
    prefix: string,
): BareInterfaceTarget<InterfaceDefinition<MemberMap>> {
    const source = generateTsInterface(schema, {
        exportName: "generatedProtocolInterface",
        preserveWireSchema: true,
        bareTarget: {
            exportName: "generatedProtocolTarget",
            prefix,
        },
    });
    const exports = evaluateGeneratedModule(source);
    const target = exports.generatedProtocolTarget;
    if (!isGeneratedBareTarget(target)) {
        throw new Error("Generated module did not export a bare interface target");
    }
    return target;
}

function evaluateGeneratedModule(source: string): Record<string, unknown> {
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
        },
        reportDiagnostics: true,
    });
    const errors = transpiled.diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ) ?? [];
    if (errors.length > 0) {
        throw new Error(errors.map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        ).join("\n"));
    }

    const generatedModule: { exports: Record<string, unknown> } = { exports: {} };
    const requireGeneratedDependency = (specifier: string): unknown => {
        if (specifier === "@hediet/linkrpc") return linkRpc;
        if (specifier === "zod") return zod;
        throw new Error(`Unexpected generated dependency: ${specifier}`);
    };
    new Function("require", "module", "exports", transpiled.outputText)(
        requireGeneratedDependency,
        generatedModule,
        generatedModule.exports,
    );
    return generatedModule.exports;
}

function isGeneratedBareTarget(
    value: unknown,
): value is BareInterfaceTarget<InterfaceDefinition<MemberMap>> {
    return typeof value === "object"
        && value !== null
        && "mode" in value
        && value.mode === "bare"
        && "interface" in value
        && value.interface instanceof InterfaceDefinition
        && "prefix" in value
        && typeof value.prefix === "string";
}
