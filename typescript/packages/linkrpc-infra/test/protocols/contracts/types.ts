import type { LinkRpcInterfaceSchema } from '@hediet/linkrpc';

export type ProtocolDirection = "clientToServer" | "serverToClient";

/**
 * Connects a protocol's wire method to the dot-free local member of a
 * generated LinkRPC interface.
 */
export interface ProtocolMethodBinding {
    wireMethod: string;
    interfaceId: string;
    member: string;
    kind: "request" | "notification";
    direction: ProtocolDirection;
    source: "cdp" | "lsp";
}

export interface ContractImportDiagnostic {
    severity: "warning" | "error";
    path: string;
    message: string;
    /** The conservative schema used when the source construct was not exact. */
    approximation?: "true" | "structural";
}

/** Deterministic, network-independent output shared by protocol importers. */
export interface ProtocolContractImport {
    interfaces: Record<string, LinkRpcInterfaceSchema>;
    bindings: ProtocolMethodBinding[];
    diagnostics: ContractImportDiagnostic[];
    /** Provenance/codegen data. Non-normative and not part of interface hashes. */
    metadata: Record<string, unknown>;
}
