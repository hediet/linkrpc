// Signed objects: sign an arbitrary JSON object with a LinkRPC identity and verify it against a
// principal, using the standard `$hubrpcSignature` envelope (Ed25519 over canonical JSON).
export {
    signObject,
    verifyObject,
    verifyObjectByPrincipal,
    getKeyId,
    readSignature,
    signedHash,
    signingDomainValue,
    signingInput,
    HUBRPC_SIGNATURE_KEY,
    LINKRPC_SIGNATURE_KEY,
    type SignDomain,
    type SignatureEnvelope,
    type Signatures,
} from "./identity/signedObject";
export type { SigningIdentity } from "./identity/identity";
