//! Capability data model, signing, freshness, membership predicates, and [`CapBag`].
//!
//! Port of TypeScript `protocol/capability.ts`, `identity/capability.ts`, and `identity/capBag.ts`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use crate::identity::error::IdentityError;
use crate::identity::keys::{
    resolve_signing_key, IdentityStorage, PublicSigningIdentity, SigningIdentity,
};
use crate::identity::signed_envelope::{random_nonce_bytes, sign_object, verify_object};
use crate::protocol::jcs::jcs_canonicalize;
use crate::protocol::json_value::JsonValue;
use crate::protocol::signed_object::{
    base64url_encode, read_signature, signed_hash, PrincipalId, Signatures,
};

/// Default storage key used by [`CapBag`] when persisted via [`IdentityStorage`].
pub const DEFAULT_CAP_BAG_STORAGE_KEY: &str = "hubrpc.caps.v1";

/// Single-axis matcher for `serviceId`, `interfaceId`, or `members`.
///
/// Serializes as `{"exact": "..."}` or `{"prefix": "..."}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Pattern {
    Exact(String),
    Prefix(String),
}

impl Pattern {
    pub fn exact(value: impl Into<String>) -> Self {
        Self::Exact(value.into())
    }

    pub fn prefix(value: impl Into<String>) -> Self {
        Self::Prefix(value.into())
    }

    /// Wildcard matcher (`{"prefix": ""}`), which matches any value on its axis.
    pub fn any() -> Self {
        Self::Prefix(String::new())
    }

    /// Format compactly for human/LLM grant summaries (matches TS `linkrpc-mcp/src/grants.ts`).
    pub fn format_summary(&self) -> String {
        match self {
            Pattern::Exact(v) => v.clone(),
            Pattern::Prefix(p) if p.is_empty() => "*".to_owned(),
            Pattern::Prefix(p) => format!("{p}*"),
        }
    }

    /// Whether `value` matches this pattern using `delimiter` (`"/"` for `serviceId`, `"."` for
    /// `interfaceId`, `""` for `member`).
    pub fn matches(&self, value: &str, delimiter: &str) -> bool {
        match self {
            Pattern::Exact(expected) => value == expected,
            Pattern::Prefix(prefix) => {
                if prefix.is_empty() || value == prefix {
                    return true;
                }
                if delimiter.is_empty() {
                    value.starts_with(prefix.as_str())
                } else {
                    value
                        .strip_prefix(prefix.as_str())
                        .is_some_and(|rest| rest.starts_with(delimiter))
                }
            }
        }
    }
}

/// Per-field matcher used by [`Permission::params`] (strict top-level allowlist).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamMatcher {
    Any {
        any: bool,
    },
    Exact {
        exact: JsonValue,
    },
    Enum {
        #[serde(rename = "enum")]
        values: Vec<JsonValue>,
    },
    Prefix {
        prefix: String,
    },
    SubsetOf {
        #[serde(rename = "subsetOf")]
        values: Vec<String>,
    },
}

impl ParamMatcher {
    pub fn exact(value: JsonValue) -> Self {
        Self::Exact { exact: value }
    }

    pub fn one_of(values: Vec<JsonValue>) -> Self {
        Self::Enum { values }
    }

    pub fn prefix(prefix: impl Into<String>) -> Self {
        Self::Prefix {
            prefix: prefix.into(),
        }
    }

    pub fn subset_of(values: Vec<String>) -> Self {
        Self::SubsetOf { values }
    }

    pub fn any() -> Self {
        Self::Any { any: true }
    }

    pub fn matches(&self, value: &JsonValue) -> bool {
        match self {
            ParamMatcher::Any { any } => *any,
            ParamMatcher::Prefix { prefix } => {
                value.as_str().is_some_and(|s| s.starts_with(prefix))
            }
            ParamMatcher::SubsetOf { values } => value.as_array().is_some_and(|items| {
                items.iter().all(|item| {
                    item.as_str()
                        .is_some_and(|s| values.iter().any(|allowed| allowed == s))
                })
            }),
            ParamMatcher::Exact { exact } => jcs_equal(value, exact),
            ParamMatcher::Enum { values } => values.iter().any(|opt| jcs_equal(value, opt)),
        }
    }
}

fn jcs_equal(left: &JsonValue, right: &JsonValue) -> bool {
    match (jcs_canonicalize(left), jcs_canonicalize(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Point-precision narrowing of a [`Permission`] to one exact signed RPC call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallBind {
    /// Hash algorithm (currently always `"sha256"`).
    pub alg: String,
    /// `signed_hash("call", signed_call)` for the exact bound call.
    pub payload_hash: String,
}

/// Address of a class of calls matched by a [`Permission`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetPattern {
    /// Delimiter `"/"`.
    pub service_id: Pattern,
    /// Delimiter `"."`.
    pub interface_id: Pattern,
    /// Optional schema-version pin matched against `$hubrpc.interfaceHash`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub interface_hash: Option<String>,
    /// Any-of member matchers. Empty matches nothing; `[Pattern::any()]` matches every member.
    pub members: Vec<Pattern>,
}

/// One grant clause inside a [`Capability`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub target: TargetPattern,
    /// Holder may invoke matching calls. Defaults to `false` (fail closed).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub can_invoke: Option<bool>,
    /// Holder may delegate (re-issue narrowed grants) for matching calls. Defaults to `false`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub can_delegate: Option<bool>,
    /// Optional strict top-level param allowlist.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub params: Option<BTreeMap<String, ParamMatcher>>,
    /// Optional single-call hash binding ("Allow once").
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub call_bind: Option<CallBind>,
}

impl Permission {
    /// Convenience builder for an exact-target invoke permission.
    pub fn invoke(
        service_id: impl Into<String>,
        interface_id: impl Into<String>,
        members: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            target: TargetPattern {
                service_id: Pattern::exact(service_id),
                interface_id: Pattern::exact(interface_id),
                interface_hash: None,
                members: members.into_iter().map(Pattern::exact).collect(),
            },
            can_invoke: Some(true),
            can_delegate: None,
            params: None,
            call_bind: None,
        }
    }
}

/// Unsigned capability payload (flat JSON object on the wire).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    /// Issuer principal (signer of this capability).
    pub issuer: PrincipalId,
    /// Audience principal (holder allowed to wield this capability).
    pub audience: PrincipalId,
    /// Grant clauses (a call is permitted if any clause permits it).
    pub permissions: Vec<Permission>,
    /// Optional expiration time in Unix milliseconds (`None` = never expires).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expires_at_ms: Option<i64>,
    /// Content hash `signed_hash("capability", parent)` when delegating from a parent.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub parent_hash: Option<String>,
    /// Per-capability distinguisher (unpadded base64url).
    pub nonce: String,
}

/// Signed capability on the wire: flat [`Capability`] fields plus `$hubrpcSignature`.
///
/// Extra top-level fields (if any were emitted by another implementation) are preserved via
/// `#[serde(flatten)]` so deserializing and re-serializing a capability from TypeScript never
/// alters the signed canonical bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SignedCapability {
    #[serde(flatten)]
    pub capability: Capability,
    #[serde(rename = "$hubrpcSignature")]
    pub hubrpc_signature: Signatures,
    #[serde(
        rename = "$hubrpcUnsigned",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub hubrpc_unsigned: Option<JsonValue>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, JsonValue>,
}

impl SignedCapability {
    /// Convert to its wire [`JsonValue`] representation.
    pub fn to_json_value(&self) -> Result<JsonValue, IdentityError> {
        Ok(serde_json::to_value(self)?)
    }

    /// Compute this capability's content hash `signed_hash("capability", self)`.
    pub fn content_hash(&self) -> Result<String, IdentityError> {
        signed_hash("capability", &self.to_json_value()?)
    }

    /// Whether any permission is pinned to a single call via `callBind`.
    pub fn is_one_shot(&self) -> bool {
        self.capability
            .permissions
            .iter()
            .any(|p| p.call_bind.is_some())
    }
}

/// Whether `cap` is fresh at `now_ms + margin_ms` (matches TS `capabilityFreshAt`).
pub fn capability_fresh_at(cap: &Capability, now_ms: i64, margin_ms: i64) -> bool {
    cap.expires_at_ms
        .is_none_or(|exp| exp > now_ms.saturating_add(margin_ms))
}

/// Sign a [`Capability`] in domain `"capability"` with `issuer`.
pub async fn sign_capability(
    capability: &Capability,
    issuer: &dyn SigningIdentity,
) -> Result<SignedCapability, IdentityError> {
    let raw = serde_json::to_value(capability)?;
    let signed = sign_object("capability", &raw, issuer).await?;
    Ok(serde_json::from_value(signed)?)
}

/// Options for [`issue_capability`].
#[derive(Clone, Debug)]
pub struct IssueCapabilityOptions {
    pub audience: PublicSigningIdentity,
    pub permissions: Vec<Permission>,
    pub expires_at_ms: Option<i64>,
    pub parent: Option<SignedCapability>,
}

/// Build and sign a [`SignedCapability`], deriving `issuer`, random `nonce`, and optional
/// `parent_hash` (mirrors TS `issueCapability`).
pub async fn issue_capability(
    issuer: &dyn SigningIdentity,
    options: IssueCapabilityOptions,
) -> Result<SignedCapability, IdentityError> {
    let parent_hash = match &options.parent {
        Some(parent) => Some(parent.content_hash()?),
        None => None,
    };
    let capability = Capability {
        issuer: issuer.principal(),
        audience: options.audience.principal().clone(),
        permissions: options.permissions,
        expires_at_ms: options.expires_at_ms,
        parent_hash,
        nonce: base64url_encode(&random_nonce_bytes()),
    };
    sign_capability(&capability, issuer).await
}

// ── Membership & chain verification predicates ───────────────────────────────

/// What a holder may do with a permission's call-set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ability {
    Invoke,
    Delegate,
}

/// Concrete call address matched against [`TargetPattern`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallTarget {
    pub service_id: String,
    pub interface_id: String,
    pub member: String,
    pub interface_hash: Option<String>,
}

/// Concrete authenticated call evaluated by [`permits`].
#[derive(Clone, Debug)]
pub struct Call {
    pub target: CallTarget,
    pub params: JsonValue,
    pub nonce: String,
    pub signed_at_ms: i64,
    pub signer: PrincipalId,
    pub call_hash: String,
}

/// Accepted root trust anchor for capability chain verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedRootIssuer {
    pub principal: PrincipalId,
    pub is_public: bool,
}

/// Outcome of [`permits`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PermitResult {
    Allowed {
        capability_nonce: String,
        root_issuer: PrincipalId,
    },
    Denied {
        reason: String,
    },
}

impl PermitResult {
    pub fn is_allowed(&self) -> bool {
        matches!(self, PermitResult::Allowed { .. })
    }
}

/// Check whether `permission` matches `target`'s addressing axes.
pub fn permission_matches_target(target: &CallTarget, permission: &Permission) -> bool {
    let t = &permission.target;
    t.service_id.matches(&target.service_id, "/")
        && t.interface_id.matches(&target.interface_id, ".")
        && t.interface_hash
            .as_deref()
            .is_none_or(|expected| target.interface_hash.as_deref() == Some(expected))
        && t.members.iter().any(|m| m.matches(&target.member, ""))
}

/// Strict top-level parameter allowlist match (mirrors TS `matchParams`).
pub fn match_params(
    declared: &BTreeMap<String, ParamMatcher>,
    actual: &JsonValue,
) -> Result<(), String> {
    let actual_obj = actual.as_object();
    let actual_len = actual_obj.map_or(0, |m| m.len());
    if declared.len() != actual_len {
        return Err("param keys mismatch".into());
    }
    for (k, matcher) in declared {
        let Some(val) = actual_obj.and_then(|m| m.get(k)) else {
            return Err("param keys mismatch".into());
        };
        if !matcher.matches(val) {
            return Err(format!("param \"{k}\" does not match"));
        }
    }
    Ok(())
}

/// Does `permission` admit `call` for `ability`?
pub fn permission_permits(
    call: &Call,
    permission: &Permission,
    ability: Ability,
) -> Result<(), String> {
    let granted = match ability {
        Ability::Invoke => permission.can_invoke == Some(true),
        Ability::Delegate => permission.can_delegate == Some(true),
    };
    if !granted {
        return Err(format!(
            "permission does not grant {}",
            match ability {
                Ability::Invoke => "invoke",
                Ability::Delegate => "delegate",
            }
        ));
    }
    if !permission_matches_target(&call.target, permission) {
        return Err("permission does not address this call".into());
    }
    if let Some(declared) = &permission.params {
        match_params(declared, &call.params).map_err(|r| format!("params: {r}"))?;
    }
    if let Some(bind) = &permission.call_bind {
        if bind.alg != "sha256" {
            return Err(format!("callBind: unsupported hash alg ({})", bind.alg));
        }
        if call.call_hash != bind.payload_hash {
            return Err("callBind: payload hash mismatch".into());
        }
    }
    Ok(())
}

/// Does `capability` admit `call` for `ability` (union across its permissions)?
pub fn capability_permits(
    call: &Call,
    capability: &Capability,
    ability: Ability,
) -> Result<(), String> {
    let mut last_reason = format!(
        "no permission grants {} for this call",
        match ability {
            Ability::Invoke => "invoke",
            Ability::Delegate => "delegate",
        }
    );
    for permission in &capability.permissions {
        match permission_permits(call, permission, ability) {
            Ok(()) => return Ok(()),
            Err(reason) => last_reason = reason,
        }
    }
    Err(last_reason)
}

/// Evaluate whether any presented capability chain authorizes `call` and roots at an accepted
/// issuer for `call.target.service_id` (fail-closed; mirrors TS `permits`).
pub fn permits<F>(
    call: &Call,
    capabilities: &[SignedCapability],
    accepted_root_issuers: F,
    now_ms: i64,
    max_depth: Option<usize>,
) -> PermitResult
where
    F: Fn(&str) -> Vec<AcceptedRootIssuer>,
{
    if capabilities.is_empty() {
        return PermitResult::Denied {
            reason: "no capabilities were presented with this call".into(),
        };
    }

    let mut by_hash: HashMap<String, (&SignedCapability, JsonValue)> =
        HashMap::with_capacity(capabilities.len());
    for cap in capabilities {
        let Ok(value) = cap.to_json_value() else {
            return PermitResult::Denied {
                reason: "malformed capability".into(),
            };
        };
        if read_signature(&value, "capability").is_none() {
            return PermitResult::Denied {
                reason: "malformed capability".into(),
            };
        }
        let Ok(hash) = signed_hash("capability", &value) else {
            return PermitResult::Denied {
                reason: "malformed capability".into(),
            };
        };
        by_hash.insert(hash, (cap, value));
    }

    let accepted = accepted_root_issuers(&call.target.service_id);
    let accepted_ids: HashSet<&PrincipalId> = accepted.iter().map(|a| &a.principal).collect();
    let max_depth = max_depth.unwrap_or(16);

    let mut leaf_reason: Option<String> = None;
    let mut any_reason = "no presented capability addresses this call".to_owned();
    let mut unaccepted_root: Option<PrincipalId> = None;

    for leaf in capabilities {
        let Ok(leaf_val) = leaf.to_json_value() else {
            continue;
        };
        match verify_link(
            leaf,
            &leaf_val,
            &call.signer,
            call,
            now_ms,
            max_depth,
            true,
            &by_hash,
        ) {
            Ok(root_issuer) => {
                if accepted_ids.contains(&root_issuer) {
                    return PermitResult::Allowed {
                        capability_nonce: leaf.capability.nonce.clone(),
                        root_issuer,
                    };
                }
                unaccepted_root = Some(root_issuer);
            }
            Err(reason) => {
                if leaf.capability.audience == call.signer {
                    leaf_reason = Some(reason.clone());
                }
                any_reason = reason;
            }
        }
    }

    if let Some(root) = unaccepted_root {
        let head = format!(
            "capability root issuer {} is not accepted for service \"{}\"",
            root.as_str(),
            call.target.service_id
        );
        let reason = if accepted.is_empty() {
            format!("{head} (no root issuers are accepted for this service)")
        } else {
            let public_ids: Vec<&str> = accepted
                .iter()
                .filter(|a| a.is_public)
                .map(|a| a.principal.as_str())
                .collect();
            if public_ids.is_empty() {
                head
            } else {
                format!("{head}; accepted root issuer(s): {}", public_ids.join(", "))
            }
        };
        return PermitResult::Denied { reason };
    }

    PermitResult::Denied {
        reason: leaf_reason.unwrap_or(any_reason),
    }
}

#[allow(clippy::too_many_arguments)]
fn verify_link(
    link: &SignedCapability,
    link_value: &JsonValue,
    expected_audience: &PrincipalId,
    call: &Call,
    now_ms: i64,
    depth_left: usize,
    is_leaf: bool,
    by_hash: &HashMap<String, (&SignedCapability, JsonValue)>,
) -> Result<PrincipalId, String> {
    if depth_left == 0 {
        return Err("chain too deep".into());
    }
    if &link.capability.audience != expected_audience {
        return Err(format!(
            "audience mismatch (expected {}, got {})",
            expected_audience.as_str(),
            link.capability.audience.as_str()
        ));
    }
    if let Some(exp) = link.capability.expires_at_ms {
        if exp < now_ms {
            return Err("expired".into());
        }
    }
    let ability = if is_leaf {
        Ability::Invoke
    } else {
        Ability::Delegate
    };
    capability_permits(call, &link.capability, ability)?;

    let env = read_signature(link_value, "capability")
        .ok_or_else(|| "unresolvable issuer key".to_owned())?;
    let issuer_key = resolve_signing_key(&link.capability.issuer, &env.key_id)
        .ok_or_else(|| "unresolvable issuer key".to_owned())?;
    if !verify_object("capability", link_value, &issuer_key) {
        return Err("bad signature".into());
    }

    let Some(parent_hash) = &link.capability.parent_hash else {
        return Ok(link.capability.issuer.clone());
    };
    let Some((parent, parent_val)) = by_hash.get(parent_hash) else {
        return Err("parent capability not presented".into());
    };
    let actual_parent_hash =
        signed_hash("capability", parent_val).map_err(|_| "parent hash mismatch".to_owned())?;
    if &actual_parent_hash != parent_hash {
        return Err("parent hash mismatch".into());
    }
    verify_link(
        parent,
        parent_val,
        &link.capability.issuer,
        call,
        now_ms,
        depth_left - 1,
        false,
        by_hash,
    )
}

// ── CapBag ───────────────────────────────────────────────────────────────────

/// Process-lifetime bag of hub-issued capabilities, optionally backed by an [`IdentityStorage`]
/// (mirrors TS `CapBag`).
pub struct CapBag {
    caps: RwLock<Vec<SignedCapability>>,
    storage: Option<Arc<dyn IdentityStorage>>,
    storage_key: String,
}

impl std::fmt::Debug for CapBag {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CapBag")
            .field("count", &self.caps.read().unwrap().len())
            .field("persistent", &self.storage.is_some())
            .field("storage_key", &self.storage_key)
            .finish()
    }
}

impl CapBag {
    /// Create an ephemeral in-memory capability bag.
    pub fn in_memory() -> Self {
        Self {
            caps: RwLock::new(Vec::new()),
            storage: None,
            storage_key: DEFAULT_CAP_BAG_STORAGE_KEY.to_owned(),
        }
    }

    /// Create an ephemeral bag pre-populated with `capabilities`.
    pub fn with_capabilities(capabilities: Vec<SignedCapability>) -> Self {
        Self {
            caps: RwLock::new(capabilities),
            storage: None,
            storage_key: DEFAULT_CAP_BAG_STORAGE_KEY.to_owned(),
        }
    }

    /// Load (hydrate) a capability bag backed by `storage` under [`DEFAULT_CAP_BAG_STORAGE_KEY`].
    pub async fn load(storage: Arc<dyn IdentityStorage>) -> Result<Self, IdentityError> {
        Self::load_with_key(storage, DEFAULT_CAP_BAG_STORAGE_KEY).await
    }

    /// Load (hydrate) a capability bag backed by `storage` under a custom `storage_key`.
    pub async fn load_with_key(
        storage: Arc<dyn IdentityStorage>,
        storage_key: impl Into<String>,
    ) -> Result<Self, IdentityError> {
        let storage_key = storage_key.into();
        let mut hydrated = Vec::new();
        if let Some(JsonValue::Array(items)) = storage.get(&storage_key).await? {
            for item in items {
                if let Ok(cap) = serde_json::from_value::<SignedCapability>(item) {
                    hydrated.push(cap);
                }
            }
        }
        Ok(Self {
            caps: RwLock::new(hydrated),
            storage: Some(storage),
            storage_key,
        })
    }

    /// Snapshot of all capabilities currently held in the bag.
    pub fn capabilities(&self) -> Vec<SignedCapability> {
        self.caps.read().unwrap().clone()
    }

    /// Snapshot of capabilities that are fresh at `now_ms + margin_ms`.
    pub fn fresh_capabilities(&self, now_ms: i64, margin_ms: i64) -> Vec<SignedCapability> {
        self.caps
            .read()
            .unwrap()
            .iter()
            .filter(|c| capability_fresh_at(&c.capability, now_ms, margin_ms))
            .cloned()
            .collect()
    }

    /// Append capabilities and persist when backed by storage.
    pub async fn add(&self, new_caps: &[SignedCapability]) -> Result<(), IdentityError> {
        if new_caps.is_empty() {
            return Ok(());
        }
        let snapshot = {
            let mut guard = self.caps.write().unwrap();
            guard.extend_from_slice(new_caps);
            guard.clone()
        };
        self.persist(&snapshot).await
    }

    /// Remove all capabilities and persist the empty bag.
    pub async fn clear(&self) -> Result<(), IdentityError> {
        let changed = {
            let mut guard = self.caps.write().unwrap();
            if guard.is_empty() {
                false
            } else {
                guard.clear();
                true
            }
        };
        if changed {
            self.persist(&[]).await?;
        }
        Ok(())
    }

    async fn persist(&self, snapshot: &[SignedCapability]) -> Result<(), IdentityError> {
        if let Some(storage) = &self.storage {
            let val = serde_json::to_value(snapshot)?;
            storage.set(&self.storage_key, val).await?;
        }
        Ok(())
    }
}
