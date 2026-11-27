//! Signed objects and `$hubrpc` signed RPC call envelopes.
//!
//! Port of TypeScript `identity/signedObject.ts` and `identity/signedRpcEnvelope.ts`.

use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore as _;

use crate::identity::capability::SignedCapability;
use crate::identity::error::IdentityError;
use crate::identity::keys::{resolve_signing_key, verify_ed25519, SigningIdentity};
use crate::protocol::json_value::{JsonMap, JsonValue};
use crate::protocol::signed_object::{
    base64url_decode, base64url_encode, read_signature, require_object_params, signed_hash,
    signing_input, strip_linkrpc_wire_meta, with_signature, CallMeta, PrincipalId,
    SignatureEnvelope, HUBRPC_META_KEY, HUBRPC_UNSIGNED_KEY,
};

/// Default clock-skew window for [`verify_rpc_call`] (±5 minutes, matching TS).
pub const DEFAULT_MAX_SKEW_MS: i64 = 300_000;

/// Sign a JSON object `obj` in `domain` with `identity`, populating `$hubrpcSignature[domain]`
/// while preserving any sibling-domain signatures.
pub async fn sign_object(
    domain: &str,
    obj: &JsonValue,
    identity: &dyn SigningIdentity,
) -> Result<JsonValue, IdentityError> {
    let input = signing_input(domain, obj)?;
    let sig_bytes = identity.sign(&input).await?;
    let key_id = identity.key_id()?;
    with_signature(
        obj,
        domain,
        SignatureEnvelope {
            key_id,
            sig: base64url_encode(&sig_bytes),
        },
    )
}

/// Verify `obj`'s `domain` signature against a raw 32-byte Ed25519 `public_key`.
///
/// Returns `false` (never panics or throws) on missing/malformed signatures or objects.
pub fn verify_object(domain: &str, obj: &JsonValue, public_key: &[u8; 32]) -> bool {
    let Some(env) = read_signature(obj, domain) else {
        return false;
    };
    let Ok(sig_bytes) = base64url_decode(&env.sig) else {
        return false;
    };
    let Ok(input) = signing_input(domain, obj) else {
        return false;
    };
    verify_ed25519(public_key, &input, &sig_bytes)
}

/// Verify `obj`'s `domain` signature against a claimed [`PrincipalId`].
///
/// Reads `$hubrpcSignature[domain].keyId`, resolves it fail-closed against `principal` via
/// [`resolve_signing_key`], and verifies the Ed25519 signature over `signing_input(domain, obj)`.
pub fn verify_object_by_principal(domain: &str, obj: &JsonValue, principal: &PrincipalId) -> bool {
    let Some(env) = read_signature(obj, domain) else {
        return false;
    };
    let Some(public_key) = resolve_signing_key(principal, &env.key_id) else {
        return false;
    };
    verify_object(domain, obj, &public_key)
}

/// Options for [`sign_rpc_call`].
#[derive(Clone, Debug)]
pub struct SignRpcCallOptions {
    /// Fully-qualified wire method name.
    pub method: String,
    /// User params — must be a plain JSON object or `None` (equivalent to `{}`).
    pub params: Option<JsonValue>,
    /// Unix milliseconds when the call was signed. Defaults to current wall clock.
    pub now_ms: Option<i64>,
    /// Override random 16-byte nonce (for deterministic testing / cap pre-binding).
    pub nonce: Option<Vec<u8>>,
    /// Optional schema-hash assertion stamped into `$hubrpc.interfaceHash`.
    pub interface_hash: Option<String>,
}

/// Result of signing a single JSON-RPC call.
#[derive(Clone, Debug)]
pub struct SignedRpcCall {
    /// Wire `params` carrying user params + `$hubrpc` + `$hubrpcSignature.call`.
    pub wire_params: JsonValue,
    /// The signed metadata embedded under `$hubrpc`.
    pub call_meta: CallMeta,
    /// Content hash `signed_hash("call", wire_params)` — what `callBind.payloadHash` binds to.
    pub call_hash: String,
}

/// Sign a single JSON-RPC call (mirrors TS `signRpcCall`).
pub async fn sign_rpc_call(
    identity: &dyn SigningIdentity,
    opts: SignRpcCallOptions,
) -> Result<SignedRpcCall, IdentityError> {
    let mut signed_params = require_object_params(opts.params.as_ref())?;
    let nonce_bytes = opts.nonce.unwrap_or_else(random_nonce_bytes);
    let signed_at_ms = opts.now_ms.unwrap_or_else(current_time_ms);
    let call_meta = CallMeta {
        method: opts.method,
        nonce: base64url_encode(&nonce_bytes),
        signed_at_ms,
        principal: Some(identity.principal()),
        interface_hash: opts.interface_hash,
    };
    signed_params.insert(
        HUBRPC_META_KEY.to_owned(),
        serde_json::to_value(&call_meta).expect("CallMeta serializes"),
    );
    let signed_value = JsonValue::Object(signed_params);
    let call_hash = signed_hash("call", &signed_value)?;
    let wire_params = sign_object("call", &signed_value, identity).await?;
    Ok(SignedRpcCall {
        wire_params,
        call_meta,
        call_hash,
    })
}

/// Attach capabilities under `$hubrpcUnsigned.capabilities` without mutating the input or
/// invalidating its signature (mirrors TS `attachCapabilities`).
pub fn attach_capabilities(
    wire_params: &JsonValue,
    capabilities: &[SignedCapability],
) -> Result<JsonValue, IdentityError> {
    if capabilities.is_empty() {
        return Ok(wire_params.clone());
    }
    let JsonValue::Object(map) = wire_params else {
        return Err(IdentityError::SignedObjectMustBeObject);
    };
    let mut out = map.clone();
    let mut unsigned = match out.get(HUBRPC_UNSIGNED_KEY) {
        Some(JsonValue::Object(existing)) => existing.clone(),
        _ => JsonMap::new(),
    };
    unsigned.insert(
        "capabilities".to_owned(),
        serde_json::to_value(capabilities)?,
    );
    out.insert(HUBRPC_UNSIGNED_KEY.to_owned(), JsonValue::Object(unsigned));
    Ok(JsonValue::Object(out))
}

/// Options for [`verify_rpc_call`].
#[derive(Clone, Debug)]
pub struct VerifyRpcCallOptions<'a> {
    /// Outer JSON-RPC `method` field from the wire message.
    pub wire_method: &'a str,
    /// Raw `params` value received on the wire (use `None` when omitted).
    pub wire_params: Option<&'a JsonValue>,
    /// Current Unix milliseconds for skew checking. Defaults to wall clock.
    pub now_ms: Option<i64>,
    /// Maximum allowed clock skew in milliseconds. Defaults to [`DEFAULT_MAX_SKEW_MS`] (5 min).
    pub max_skew_ms: Option<i64>,
    /// When `true`, reject calls lacking a signed `$hubrpc` + `$hubrpcSignature.call` envelope.
    pub require_signed: bool,
}

/// Verified caller identity extracted from a signed RPC call.
#[derive(Clone, Debug)]
pub struct VerifiedCallIdentity {
    /// The verified `$hubrpc` metadata.
    pub call_meta: CallMeta,
    /// Authenticated caller principal (`call_meta.principal`).
    pub signer: PrincipalId,
    /// Content hash `signed_hash("call", wire_params)` — input to `callBind.payloadHash`.
    pub call_hash: String,
    /// Capabilities presented under `$hubrpcUnsigned.capabilities` (not yet authorized).
    pub capabilities: Vec<SignedCapability>,
}

/// Successful output of [`verify_rpc_call`].
#[derive(Clone, Debug)]
pub struct VerifyRpcCallResult {
    /// `None` when the call was unsigned (and `require_signed` was `false`).
    pub identity: Option<VerifiedCallIdentity>,
    /// User params with reserved `$hubrpc*` keys stripped.
    pub params: Option<JsonValue>,
}

/// Rejection reason returned by [`verify_rpc_call`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{reason}")]
pub struct VerifyRpcCallError {
    pub reason: String,
}

impl VerifyRpcCallError {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

/// Verify the `$hubrpc` identity envelope on an inbound JSON-RPC call (mirrors TS `verifyRpcCall`).
///
/// Does not evaluate capability chains or replay ledgers; checks structure, outer-vs-inner method
/// binding, clock-skew window, principal key resolution, and the Ed25519 signature.
pub fn verify_rpc_call(
    opts: VerifyRpcCallOptions<'_>,
) -> Result<VerifyRpcCallResult, VerifyRpcCallError> {
    let user_params = opts.wire_params.map(strip_linkrpc_wire_meta);
    let Some(wire_params) = opts.wire_params else {
        if opts.require_signed {
            return Err(VerifyRpcCallError::new("missing $hubrpc envelope"));
        }
        return Ok(VerifyRpcCallResult {
            identity: None,
            params: user_params,
        });
    };

    let Some(meta_value) = extract_object_field(wire_params, HUBRPC_META_KEY) else {
        if opts.require_signed {
            return Err(VerifyRpcCallError::new("missing $hubrpc envelope"));
        }
        return Ok(VerifyRpcCallResult {
            identity: None,
            params: user_params,
        });
    };

    let meta = parse_call_meta(meta_value)
        .ok_or_else(|| VerifyRpcCallError::new("malformed linkrpc envelope"))?;

    if meta.method != opts.wire_method {
        return Err(VerifyRpcCallError::new("method mismatch"));
    }

    let now = opts.now_ms.unwrap_or_else(current_time_ms);
    let skew = opts.max_skew_ms.unwrap_or(DEFAULT_MAX_SKEW_MS);
    if (meta.signed_at_ms - now).abs() > skew {
        return Err(VerifyRpcCallError::new(format!(
            "timestamp skew > {skew}ms"
        )));
    }

    let signature = read_signature(wire_params, "call");
    let (Some(principal), Some(signature)) = (&meta.principal, signature) else {
        if opts.require_signed {
            return Err(VerifyRpcCallError::new("unsigned call"));
        }
        return Ok(VerifyRpcCallResult {
            identity: None,
            params: user_params,
        });
    };

    let Some(public_key) = resolve_signing_key(principal, &signature.key_id) else {
        return Err(VerifyRpcCallError::new(format!(
            "unresolvable signing key for principal {}",
            principal.as_str()
        )));
    };

    if !verify_object("call", wire_params, &public_key) {
        return Err(VerifyRpcCallError::new("bad signature"));
    }

    let call_hash = signed_hash("call", wire_params)
        .map_err(|e| VerifyRpcCallError::new(format!("call hash failed: {e}")))?;

    let capabilities = extract_object_field(wire_params, HUBRPC_UNSIGNED_KEY)
        .and_then(|u| u.as_object())
        .and_then(|u| u.get("capabilities"))
        .and_then(|c| c.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| serde_json::from_value::<SignedCapability>(v.clone()).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(VerifyRpcCallResult {
        identity: Some(VerifiedCallIdentity {
            signer: principal.clone(),
            call_meta: meta,
            call_hash,
            capabilities,
        }),
        params: user_params,
    })
}

fn extract_object_field<'a>(wire_params: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    let field = wire_params.as_object()?.get(key)?;
    if field.is_object() {
        Some(field)
    } else {
        None
    }
}

fn parse_call_meta(value: &JsonValue) -> Option<CallMeta> {
    let obj = value.as_object()?;
    let method = obj.get("method")?.as_str()?.to_owned();
    let nonce = obj.get("nonce")?.as_str()?.to_owned();
    let signed_at_ms = match obj.get("signedAtMs")? {
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                i
            } else {
                let f = n.as_f64()?;
                if f.is_finite() && f.fract() == 0.0 {
                    f as i64
                } else {
                    return None;
                }
            }
        }
        _ => return None,
    };
    let principal = match obj.get("principal") {
        None => None,
        Some(JsonValue::String(s)) => Some(PrincipalId::new(s.clone())),
        Some(_) => return None,
    };
    let interface_hash = match obj.get("interfaceHash") {
        None => None,
        Some(JsonValue::String(s)) => Some(s.clone()),
        Some(_) => return None,
    };
    Some(CallMeta {
        method,
        nonce,
        signed_at_ms,
        principal,
        interface_hash,
    })
}

/// Generate 16 cryptographically random bytes for a per-call or per-capability nonce.
pub(crate) fn random_nonce_bytes() -> Vec<u8> {
    let mut bytes = vec![0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

/// Current Unix wall-clock timestamp in milliseconds.
pub fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
