//! Hub capability-grant flow (`hubAccess::requestAccess`) and grant summaries.
//!
//! Port of TypeScript `linkrpc/src/hub/common/hubAccess.ts` and `linkrpc-mcp/src/grants.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::identity::capability::{
    CallBind, ParamMatcher, Pattern, Permission, SignedCapability, TargetPattern,
};
use crate::protocol::json_value::JsonValue;

/// How long a granted capability should live on the wire (`hubAccess::requestAccess`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HubAccessDuration {
    /// Single use (5 min TTL; bound to one call via `callBind` when paired with `callIntent`).
    Once,
    /// Short-lived session grant (5 min TTL).
    ShortLived,
    /// Long-lived session grant (24 h TTL).
    LongLived,
    /// Persistent grant (no expiration; remembered across runs).
    Persistent,
}

impl HubAccessDuration {
    /// Convenience alias for a bounded session grant (`ShortLived`).
    pub const SESSION: Self = Self::ShortLived;
}

/// Who is requesting access — surfaced in the hub's consent prompt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubAccessConsumer {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub purpose: Option<String>,
}

impl HubAccessConsumer {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            origin: None,
            purpose: None,
        }
    }

    pub fn with_origin(mut self, origin: impl Into<String>) -> Self {
        self.origin = Some(origin.into());
        self
    }

    pub fn with_purpose(mut self, purpose: impl Into<String>) -> Self {
        self.purpose = Some(purpose.into());
        self
    }
}

/// Optional invocation preview attached to a `hubAccess::requestAccess` permission for
/// "Allow once" consent UX (binds the minted capability via `callBind`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallIntent {
    /// Fully-qualified wire method name the requester intends to call.
    pub method: String,
    /// Exact user params the requester intends to send.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub params: Option<JsonValue>,
    /// Optional schema-hash assertion carried inside `$hubrpc.interfaceHash`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub interface_hash: Option<String>,
    /// Base64url nonce the consumer will sign with.
    pub nonce: String,
    /// Unix milliseconds timestamp the consumer will sign with.
    pub signed_at_ms: i64,
    /// Optional one-line summary displayed next to params.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary: Option<String>,
    /// Requester's preferred default action (`Once` if omitted).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub suggestion: Option<HubAccessDuration>,
}

/// One authority requested via `hubAccess::requestAccess`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubAccessPermission {
    pub target: TargetPattern,
    /// Set `true` to invoke matching members (default `false`, fail closed).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub can_invoke: Option<bool>,
    /// Set `true` to re-delegate this authority (default `false`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub can_delegate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub params: Option<BTreeMap<String, ParamMatcher>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub call_bind: Option<CallBind>,
    /// Optional consent-only preview enabling a single-call `callBind` grant.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub call_intent: Option<CallIntent>,
}

impl HubAccessPermission {
    /// Convenience constructor for requesting invoke access to exact `(service, interface, members)`.
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
            call_intent: None,
        }
    }

    /// Convenience constructor for requesting invoke access to all members of an interface on a service.
    pub fn invoke_all_members(
        service_id: impl Into<String>,
        interface_id: impl Into<String>,
    ) -> Self {
        Self {
            target: TargetPattern {
                service_id: Pattern::exact(service_id),
                interface_id: Pattern::exact(interface_id),
                interface_hash: None,
                members: vec![Pattern::any()],
            },
            can_invoke: Some(true),
            can_delegate: None,
            params: None,
            call_bind: None,
            call_intent: None,
        }
    }
}

impl From<Permission> for HubAccessPermission {
    fn from(permission: Permission) -> Self {
        Self {
            target: permission.target,
            can_invoke: permission.can_invoke,
            can_delegate: permission.can_delegate,
            params: permission.params,
            call_bind: permission.call_bind,
            call_intent: None,
        }
    }
}

/// Batched, explicit capability request sent to `hubAccess::requestAccess`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubAccessRequest {
    pub consumer: HubAccessConsumer,
    pub permissions: Vec<HubAccessPermission>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duration: Option<HubAccessDuration>,
}

impl HubAccessRequest {
    pub fn new(
        consumer: HubAccessConsumer,
        permissions: Vec<HubAccessPermission>,
        duration: Option<HubAccessDuration>,
    ) -> Self {
        Self {
            consumer,
            permissions,
            duration,
        }
    }
}

/// Outcome of a `hubAccess::requestAccess` round-trip.
#[derive(Clone, Debug, PartialEq)]
pub enum HubAccessResult {
    /// The hub approved the request and minted one or more capabilities.
    Granted {
        /// Every capability returned by the hub (both durable and one-shot).
        capabilities: Vec<SignedCapability>,
        /// How many durable (non-`callBind`) capabilities were added to the principal's [`CapBag`](crate::identity::CapBag).
        added_durable: usize,
    },
    /// The hub or user denied the request.
    Denied { reason: Option<String> },
    /// Any other unrecognized wire status.
    Other {
        status: String,
        reason: Option<String>,
    },
}

impl HubAccessResult {
    pub fn is_granted(&self) -> bool {
        matches!(self, HubAccessResult::Granted { .. })
    }
}

/// Flattened, human- and LLM-readable view of one permission inside a held capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantPermissionSummary {
    pub service_id: String,
    pub interface_id: String,
    pub members: Vec<String>,
    pub can_invoke: bool,
    pub can_delegate: bool,
}

/// Flattened view of a single held capability (mirrors TS `linkrpc-mcp/src/grants.ts`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantSummary {
    pub issuer: String,
    pub audience: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expires_at_ms: Option<i64>,
    pub one_shot: bool,
    pub permissions: Vec<GrantPermissionSummary>,
}

/// Compact summary returned by [`SigningClient::grants`](crate::identity::SigningClient::grants),
/// mirroring `con.grants()` in `@hediet/linkrpc-mcp`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantsSummary {
    pub count: usize,
    pub grants: Vec<GrantSummary>,
}

/// Summarize held capabilities into the exact JSON shape returned by `@hediet/linkrpc-mcp`'s
/// `con.grants()` (`summarizeGrants`).
pub fn summarize_grants(capabilities: &[SignedCapability]) -> GrantsSummary {
    let grants: Vec<GrantSummary> = capabilities
        .iter()
        .map(|cap| GrantSummary {
            issuer: cap.capability.issuer.as_str().to_owned(),
            audience: cap.capability.audience.as_str().to_owned(),
            expires_at_ms: cap.capability.expires_at_ms,
            one_shot: cap.is_one_shot(),
            permissions: cap
                .capability
                .permissions
                .iter()
                .map(|p| GrantPermissionSummary {
                    service_id: p.target.service_id.format_summary(),
                    interface_id: p.target.interface_id.format_summary(),
                    members: p
                        .target
                        .members
                        .iter()
                        .map(Pattern::format_summary)
                        .collect(),
                    can_invoke: p.can_invoke.unwrap_or(false),
                    can_delegate: p.can_delegate.unwrap_or(false),
                })
                .collect(),
        })
        .collect();
    GrantsSummary {
        count: grants.len(),
        grants,
    }
}
