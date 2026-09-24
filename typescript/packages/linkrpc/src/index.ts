export * from "./schema/linkRpcJsonSchema";
export * from "./schema/linkRpcInterfaceSchema";
export {
    INTERFACE_TEMPLATES_EXTENSION, validateInterfaceTemplates,
    interfaceTemplateMemberName, interfaceTemplateArgumentsEquivalent, interfaceTemplatesEqual,
    type SchemaParameterReference, type InterfaceTemplateJsonSchema, type InterfaceTemplateMethodSchema,
    type InterfaceTemplateErrorSchema, type InterfaceTemplateSchema, type InterfaceTemplateArgument,
    type InterfaceTemplateInstance, type InterfaceTemplatesMetadata, type MappedInterfaceTemplate,
} from "./schema/interfaceTemplates";
export * from "./schema/defineInterfaceTemplate";
export type { InterfaceTemplateGroup } from "./schema/interfaceTemplateGroup";
export * from "./schema/memberTypes";
export * from "./connection/interfaceDefinition";
export * from "./connection/nonCompliantServerError";
export * from "./schema/hash";
export * from "./schema/normalize";
export * from "./schema/assignability";
export * from "./schema/assertSchemaReferences";
export * from "./schema/materializeJsonSchema";
export * from "./schema/schemaToZod";
export * from "./schema/codegen/generateTsInterface";
export * from "./schema/codegen/generateTsContract";
export * from "./schema/staticHubSchema";
export * from "./schema/exportStaticHubSchema";
export * from "./hub/common/reflection.interfaces";
export * from "./inspection/node.interfaces";
export * from "./inspection/inspection.interfaces";
export * from "./connection/streaming";
export * from "./protocol";
export * from "./connection";
export * from "./crypto/cryptoProvider";
export * as crypto from "./crypto/crypto";
export * from "./identity/identity";
export * from "./identity/identity.interfaces";
// `verifyChain` (and its `ChainResult` / `VerifyChainOptions`) is module-private:
// the public authorization entry point is `permits`. The capability/protocol
// *types* below remain public via `export * from "./protocol"`.
export {
    type AcceptedRootIssuer,
    type IssueCapabilityOptions,
    type ParamMatcherFor,
    type ParamMatchers,
    type PermitResult,
    capabilityFreshAt,
    capBagFreshAt,
    invoke,
    issueCapability,
    permits,
    prefix,
    signCapability,
} from "./identity/capability";
export * from "./identity/metaEnvelope";
export * from "./identity/signedRpcEnvelope";
export * from "./identity/managedIdentity";
export * from "./identity/managedPrincipal";
export * from "./identity/seededPrincipal";
export * from "./identity/capBag";
