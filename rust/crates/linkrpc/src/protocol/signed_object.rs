//! Pure wire-level signed-object and `$hubrpc` envelope primitives.
//!
//! Port of TypeScript `protocol/signedObject.ts` and `protocol/linkRpcEnvelope.ts`.
//!
//! The LinkRPC signed-object standard defines a single rule for committing a signature (and a
//! content hash) over any JSON object in a domain:
//!
//! ```text
//! signing_input(domain, obj) = jcs({ "hubrpc-sig/v1/<domain>": obj without $hubrpcSignature and $hubrpcUnsigned })
//! signed_hash(domain, obj)   = base64url(sha256(signing_input(domain, obj)))
//! ```
//!
//! This module is pure (no private keys or signature verification); cryptographic signing and
//! verification live in [`crate::identity`].

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::identity::capability::SignedCapability;
use crate::identity::error::IdentityError;
use crate::protocol::jcs::jcs_canonicalize_bytes;
use crate::protocol::json_value::{JsonMap, JsonValue};

/// Reserved wire key: the per-domain signature map `{ [domain]: { keyId, sig } }`.
pub const HUBRPC_SIGNATURE_KEY: &str = "$hubrpcSignature";

/// Reserved wire key: extrinsic unsigned attachments (e.g., presented capabilities).
pub const HUBRPC_UNSIGNED_KEY: &str = "$hubrpcUnsigned";

/// Reserved wire key: signed call metadata carried on JSON-RPC call `params`.
pub const HUBRPC_META_KEY: &str = "$hubrpc";

/// Prefix on an inline [`KeyId`] (`"key:<base64url(publicKey)>"`).
pub const KEY_ID_PREFIX: &str = "key:";

/// Prefix on a [`PrincipalId`] (`"id:<genesis KeyId>"`).
pub const PRINCIPAL_PREFIX: &str = "id:";

/// Encode bytes using unpadded base64url (RFC 4648 §5).
pub fn base64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode unpadded base64url (RFC 4648 §5).
pub fn base64url_decode(encoded: &str) -> Result<Vec<u8>, IdentityError> {
    URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| IdentityError::InvalidBase64Url(e.to_string()))
}

/// Branded signing key identifier.
///
/// In v1 (inline keys), a `KeyId` embeds the raw 32-byte Ed25519 public key verbatim as
/// `"key:<base64url(publicKey)>"`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct KeyId(String);

impl KeyId {
    /// Construct an inline `KeyId` from a raw 32-byte Ed25519 public key.
    pub fn from_public_key(public_key: &[u8; 32]) -> Self {
        Self(format!("{KEY_ID_PREFIX}{}", base64url_encode(public_key)))
    }

    /// Construct a `KeyId` from an already-formatted string (e.g., `"key:..."`).
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    /// Borrow the underlying string representation.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Decode the inline 32-byte Ed25519 public key carried by a `"key:"` `KeyId`.
    pub fn public_key_bytes(&self) -> Result<[u8; 32], IdentityError> {
        let Some(rest) = self.0.strip_prefix(KEY_ID_PREFIX) else {
            return Err(IdentityError::UnsupportedKeyId(self.0.clone()));
        };
        let bytes = base64url_decode(rest)?;
        bytes
            .try_into()
            .map_err(|v: Vec<u8>| IdentityError::InvalidKeyLength {
                expected: 32,
                actual: v.len(),
            })
    }
}

impl fmt::Display for KeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for KeyId {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(s.to_owned()))
    }
}

impl From<String> for KeyId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for KeyId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

/// Branded principal identifier (`"id:<genesis KeyId>"`).
///
/// In v1, every principal is perpetual and self-certifying: its genesis public key is embedded
/// verbatim as `"id:key:<base64url(publicKey)>"`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PrincipalId(String);

impl PrincipalId {
    /// Construct a perpetual `PrincipalId` directly from a 32-byte Ed25519 public key.
    pub fn from_public_key(public_key: &[u8; 32]) -> Self {
        Self::from_key_id(&KeyId::from_public_key(public_key))
    }

    /// Wrap a genesis [`KeyId`] into a `PrincipalId` (`"id:" + key_id`).
    pub fn from_key_id(key_id: &KeyId) -> Self {
        Self(format!("{PRINCIPAL_PREFIX}{}", key_id.as_str()))
    }

    /// Construct a `PrincipalId` from a raw string.
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    /// Borrow the underlying string representation.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Extract the embedded genesis [`KeyId`] (strips the `"id:"` prefix).
    pub fn key_id(&self) -> Result<KeyId, IdentityError> {
        let Some(rest) = self.0.strip_prefix(PRINCIPAL_PREFIX) else {
            return Err(IdentityError::MalformedPrincipal(self.0.clone()));
        };
        Ok(KeyId::new(rest))
    }
}

impl fmt::Display for PrincipalId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for PrincipalId {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(s.to_owned()))
    }
}

impl From<String> for PrincipalId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for PrincipalId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

/// One domain's signature entry on the wire under `$hubrpcSignature[domain]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureEnvelope {
    /// The key claimed to have produced the signature (unsigned routing hint).
    pub key_id: KeyId,
    /// Unpadded base64url of the raw 64-byte Ed25519 signature.
    pub sig: String,
}

/// Per-domain signature map carried under [`HUBRPC_SIGNATURE_KEY`].
pub type Signatures = BTreeMap<String, SignatureEnvelope>;

/// Signed call metadata carried under `params.$hubrpc`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallMeta {
    /// Fully-qualified wire method; verifier asserts this equals the outer JSON-RPC `method`.
    pub method: String,
    /// Replay-protection nonce (unpadded base64url).
    pub nonce: String,
    /// Unix milliseconds when the call was signed.
    pub signed_at_ms: i64,
    /// Authenticated caller principal (present on signed calls; absent on unsigned calls).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub principal: Option<PrincipalId>,
    /// Optional schema-hash assertion matched against `TargetPattern.interfaceHash`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub interface_hash: Option<String>,
}

/// Extrinsic, unsigned attachments carried under `params.$hubrpcUnsigned`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRpcUnsigned {
    /// Presented capability bag (leaves and any ancestors needed to form a chain).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capabilities: Option<Vec<SignedCapability>>,
}

/// Domain-separation wrapper key for the frozen v1 signature suite (`"hubrpc-sig/v1/<domain>"`).
pub fn signing_domain_value(domain: &str) -> String {
    format!("hubrpc-sig/v1/{domain}")
}

/// Compute the exact canonical UTF-8 bytes a signature commits to for `obj` in `domain`.
///
/// Strips `$hubrpcSignature` and `$hubrpcUnsigned` from `obj`, wraps the remaining object under
/// `{ "hubrpc-sig/v1/<domain>": stripped }`, and applies RFC 8785 JCS canonicalization.
pub fn signing_input(domain: &str, obj: &JsonValue) -> Result<Vec<u8>, IdentityError> {
    let JsonValue::Object(map) = obj else {
        return Err(IdentityError::SignedObjectMustBeObject);
    };
    let mut stripped = JsonMap::with_capacity(map.len());
    for (k, v) in map {
        if k == HUBRPC_SIGNATURE_KEY || k == HUBRPC_UNSIGNED_KEY {
            continue;
        }
        stripped.insert(k.clone(), v.clone());
    }
    let mut wrapper = JsonMap::with_capacity(1);
    wrapper.insert(signing_domain_value(domain), JsonValue::Object(stripped));
    jcs_canonicalize_bytes(&JsonValue::Object(wrapper)).map_err(IdentityError::Jcs)
}

/// Content identity of a signed object: `base64url(sha256(signing_input(domain, obj)))`.
///
/// Used both for a capability's `callBind.payloadHash` (domain `"call"`) and for a child
/// capability's `parentHash` (domain `"capability"`).
pub fn signed_hash(domain: &str, obj: &JsonValue) -> Result<String, IdentityError> {
    let input = signing_input(domain, obj)?;
    let digest = Sha256::digest(&input);
    Ok(base64url_encode(&digest))
}

/// Read the signature envelope for `domain` from `obj.$hubrpcSignature[domain]`.
pub fn read_signature(obj: &JsonValue, domain: &str) -> Option<SignatureEnvelope> {
    let sigs = obj.as_object()?.get(HUBRPC_SIGNATURE_KEY)?.as_object()?;
    let entry = sigs.get(domain)?.as_object()?;
    let key_id = entry.get("keyId")?.as_str()?;
    let sig = entry.get("sig")?.as_str()?;
    Some(SignatureEnvelope {
        key_id: KeyId::new(key_id),
        sig: sig.to_owned(),
    })
}

/// Extract the unsigned `keyId` routing hint for `domain`, if present.
pub fn get_key_id(obj: &JsonValue, domain: &str) -> Option<KeyId> {
    read_signature(obj, domain).map(|env| env.key_id)
}

/// Return a clone of `obj` with `$hubrpcSignature[domain]` set to `envelope`, preserving any
/// sibling-domain signatures already present.
pub fn with_signature(
    obj: &JsonValue,
    domain: &str,
    envelope: SignatureEnvelope,
) -> Result<JsonValue, IdentityError> {
    let JsonValue::Object(map) = obj else {
        return Err(IdentityError::SignedObjectMustBeObject);
    };
    let mut out = map.clone();
    let mut sigs = match out.get(HUBRPC_SIGNATURE_KEY) {
        Some(JsonValue::Object(existing)) => existing.clone(),
        _ => JsonMap::new(),
    };
    let env_value = serde_json::to_value(envelope).expect("SignatureEnvelope serializes");
    sigs.insert(domain.to_owned(), env_value);
    out.insert(HUBRPC_SIGNATURE_KEY.to_owned(), JsonValue::Object(sigs));
    Ok(JsonValue::Object(out))
}

/// Require user params to be a plain JSON object (or absent → empty object).
///
/// Matches TS `requireObjectParams` so stripping `$hubrpc*` keys on the receive side is always
/// unambiguous.
pub fn require_object_params(
    params: Option<&JsonValue>,
) -> Result<JsonMap<String, JsonValue>, IdentityError> {
    match params {
        None => Ok(JsonMap::new()),
        Some(JsonValue::Object(map)) => Ok(map.clone()),
        Some(_) => Err(IdentityError::ParamsMustBeObject),
    }
}

/// Return the application-authored portion of a LinkRPC `params` value with the three reserved
/// envelope keys (`$hubrpc`, `$hubrpcSignature`, `$hubrpcUnsigned`) stripped.
///
/// Non-object params are returned unchanged. Terminal dispatch uses this before application-schema
/// validation without mutating the wire message.
pub fn strip_linkrpc_wire_meta(wire_params: &JsonValue) -> JsonValue {
    let JsonValue::Object(map) = wire_params else {
        return wire_params.clone();
    };
    if !map.contains_key(HUBRPC_META_KEY)
        && !map.contains_key(HUBRPC_SIGNATURE_KEY)
        && !map.contains_key(HUBRPC_UNSIGNED_KEY)
    {
        return wire_params.clone();
    }
    let mut stripped = JsonMap::with_capacity(map.len());
    for (k, v) in map {
        if k == HUBRPC_META_KEY || k == HUBRPC_SIGNATURE_KEY || k == HUBRPC_UNSIGNED_KEY {
            continue;
        }
        stripped.insert(k.clone(), v.clone());
    }
    JsonValue::Object(stripped)
}
