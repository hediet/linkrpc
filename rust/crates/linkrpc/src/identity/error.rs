//! Error types for the identity and signing layer.

use crate::protocol::jcs::JcsError;

/// Errors raised by identity operations, signing, key loading, or storage.
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("invalid base64url encoding: {0}")]
    InvalidBase64Url(String),
    #[error("invalid key length: expected {expected} bytes, got {actual}")]
    InvalidKeyLength { expected: usize, actual: usize },
    #[error("invalid signature length: expected {expected} bytes, got {actual}")]
    InvalidSignatureLength { expected: usize, actual: usize },
    #[error("malformed principal (missing \"id:\" prefix): {0}")]
    MalformedPrincipal(String),
    #[error("unsupported keyId (expected \"key:\" prefix): {0}")]
    UnsupportedKeyId(String),
    #[error("signed object must be a JSON object")]
    SignedObjectMustBeObject,
    #[error("linkrpc: user params must be a plain JSON object or undefined")]
    ParamsMustBeObject,
    #[error("canonicalization failed: {0}")]
    Jcs(#[from] JcsError),
    #[error("malformed identity file: {0}")]
    MalformedIdentityFile(String),
    #[error("identity storage I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("identity storage JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("remote identity service error: {0}")]
    Remote(String),
    #[error("signing failed: {0}")]
    Signing(String),
}
