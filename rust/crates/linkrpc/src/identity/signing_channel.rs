//! Signing channel, capability negotiation, grant flow, and inbound signature verification.
//!
//! Port of TypeScript `identity/signingSender.ts`, `hub/common/managedSigning.ts`,
//! `hub/client/hubSigningSender.ts`, and `hub/server/verifiedSignature.ts`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, RwLock};

use async_trait::async_trait;
use serde_json::json;

use crate::client::{RpcCall, RpcCallError};
use crate::connection::channel::RequestHandler;
use crate::connection::dispatch::CallCtx;
use crate::connection::streaming::RawStreamingCall;
use crate::identity::capability::{
    permits, AcceptedRootIssuer, Call, CallTarget, ParamMatcher, Pattern, SignedCapability,
    TargetPattern,
};
use crate::identity::error::IdentityError;
use crate::identity::grants::{
    summarize_grants, CallIntent, GrantsSummary, HubAccessConsumer, HubAccessDuration,
    HubAccessPermission, HubAccessRequest, HubAccessResult,
};
use crate::identity::keys::SigningIdentity;
use crate::identity::principal::{create_managed_principal, Principal};
use crate::identity::signed_envelope::{
    attach_capabilities, current_time_ms, random_nonce_bytes, sign_rpc_call, verify_rpc_call,
    SignRpcCallOptions, VerifyRpcCallOptions,
};
use crate::protocol::json_value::JsonValue;
use crate::protocol::jsonrpc::{
    error_codes, JsonRpcError, JsonRpcMessage, JsonRpcResponse, ResponsePayload,
};
use crate::protocol::method_name::{parse_method_name, ParsedMethodName};
use crate::protocol::signed_object::{base64url_encode, PrincipalId};
use crate::transport::message::{MessageTransport, TransportError};

/// How long before expiry a capability is treated as stale when auto-negotiating (matches TS).
const CAP_FRESHNESS_MARGIN_MS: i64 = 2_000;

/// Per-call context consumed by [`SigningClient`] (mirrors TS `SigningCallCtx`).
#[derive(Clone, Default)]
pub struct SigningCallCtx {
    /// Override the signer for this call only:
    /// - `None` → use the configured principal's identity (if any);
    /// - `Some(None)` → explicitly send this call **unsigned**;
    /// - `Some(Some(id))` → sign with `id`.
    pub signer_override: Option<Option<Arc<dyn SigningIdentity>>>,
    /// Replace whatever capabilities the principal / cap provider would attach.
    pub caps_override: Option<Vec<SignedCapability>>,
    /// Optional schema-hash assertion baked into `$hubrpc.interfaceHash`.
    pub interface_hash: Option<String>,
}

impl SigningCallCtx {
    /// Send a single call unsigned even on a signing channel.
    pub fn unsigned() -> Self {
        Self {
            signer_override: Some(None),
            ..Self::default()
        }
    }

    /// Override the signing identity for a single call.
    pub fn with_signer(signer: Arc<dyn SigningIdentity>) -> Self {
        Self {
            signer_override: Some(Some(signer)),
            ..Self::default()
        }
    }

    /// Override the presented capabilities for a single call.
    pub fn with_caps(caps: Vec<SignedCapability>) -> Self {
        Self {
            caps_override: Some(caps),
            ..Self::default()
        }
    }
}

/// Request handed to a [`CapProvider`] right before a call is signed.
#[derive(Clone, Debug)]
pub struct CapProviderRequest {
    pub method: String,
    pub params: Option<JsonValue>,
    pub signer: PrincipalId,
    pub nonce: String,
    pub signed_at_ms: i64,
    pub interface_hash: Option<String>,
}

/// Overrides and/or capabilities returned by a [`CapProvider`].
#[derive(Clone, Debug, Default)]
pub struct CapProviderResult {
    pub capabilities: Option<Vec<SignedCapability>>,
    pub method: Option<String>,
    pub params: Option<JsonValue>,
    pub interface_hash: Option<String>,
    pub signed_at_ms: Option<i64>,
}

/// Sign-time per-outbound-call capability negotiation hook (mirrors TS `CapProvider`).
#[async_trait]
pub trait CapProvider: Send + Sync {
    async fn provide(&self, req: CapProviderRequest) -> CapProviderResult;
}

/// Side-policy for staging single-use ("one-shot") capabilities onto the very next outbound
/// signed call without touching the principal's durable bag (mirrors TS `OneShotCapStaging`).
#[derive(Debug, Default)]
pub struct OneShotCapStaging {
    staged: Mutex<Vec<SignedCapability>>,
}

impl OneShotCapStaging {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stage capabilities for the next signed call (replaces any still-pending staged caps).
    pub fn stage(&self, caps: Vec<SignedCapability>) {
        *self.staged.lock().unwrap() = caps;
    }

    /// Drain and return any staged capabilities (called once per outbound signed call).
    pub fn take(&self) -> Vec<SignedCapability> {
        std::mem::take(&mut *self.staged.lock().unwrap())
    }
}

/// Mutable signing configuration read fresh on every outbound call (mirrors TS `SigningSenderConfig`).
#[derive(Default)]
pub struct SigningConfig {
    /// Active principal (identity + durable cap bag). `None` leaves calls unsigned.
    pub principal: Option<Principal>,
    /// Optional sign-time capability provider (e.g., auto-negotiation via `hubAccess`).
    pub cap_provider: Option<Arc<dyn CapProvider>>,
    /// Optional one-shot capability staging policy.
    pub one_shot_caps: Option<Arc<OneShotCapStaging>>,
}

/// Options for [`SigningClient::create_managed`] (mirrors TS `ManagedSigningOptions`).
#[derive(Clone, Debug, Default)]
pub struct ManagedSigningOptions {
    /// When `true`, install a sign-time [`CapProvider`] that lazily negotiates capabilities per
    /// gated call through `hubAccess::requestAccess`.
    pub auto_negotiate_caps: bool,
    /// Consumer metadata shown in the hub's consent prompt.
    pub consumer: Option<HubAccessConsumer>,
}

/// Signing wrapper around any [`RpcCall`] transport/channel/connection.
///
/// Implements [`RpcCall`], so it plugs directly into generated typed clients (`FooClient::new`),
/// while also exposing the hub grant flow (`grants()`, `list_grants()`, `request_access()`,
/// `call_with_permission()`).
///
/// Identity is completely optional: if `principal` is `None` (or overridden with
/// [`SigningCallCtx::unsigned`]), calls pass through as plain unsigned JSON-RPC.
pub struct SigningClient<C> {
    inner: Arc<C>,
    config: Arc<RwLock<SigningConfig>>,
}

impl<C> Clone for SigningClient<C> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            config: self.config.clone(),
        }
    }
}

impl<C> SigningClient<C> {
    /// Wrap `inner` with signing driven by `principal`.
    pub fn new(inner: C, principal: Principal) -> Self {
        Self::with_config(
            inner,
            SigningConfig {
                principal: Some(principal),
                cap_provider: None,
                one_shot_caps: None,
            },
        )
    }

    /// Wrap `inner` in an unsigned [`SigningClient`] whose principal can be installed later via
    /// [`SigningClient::set_principal`].
    pub fn unsigned(inner: C) -> Self {
        Self::with_config(inner, SigningConfig::default())
    }

    /// Wrap `inner` with full custom [`SigningConfig`].
    pub fn with_config(inner: C, config: SigningConfig) -> Self {
        Self {
            inner: Arc::new(inner),
            config: Arc::new(RwLock::new(config)),
        }
    }

    /// Access the wrapped inner channel or connection (e.g., to register handlers or call `run()`).
    pub fn inner(&self) -> &C {
        &self.inner
    }

    /// Current principal snapshot, if signing is enabled.
    pub fn principal(&self) -> Option<Principal> {
        self.config.read().unwrap().principal.clone()
    }

    /// Current principal's [`PrincipalId`], if signing is enabled.
    pub fn principal_id(&self) -> Option<PrincipalId> {
        self.config
            .read()
            .unwrap()
            .principal
            .as_ref()
            .map(Principal::id)
    }

    /// Install or replace the active principal (pass `None` to revert to unsigned mode).
    pub fn set_principal(&self, principal: Option<Principal>) {
        self.config.write().unwrap().principal = principal;
    }

    /// Install or replace the sign-time [`CapProvider`].
    pub fn set_cap_provider(&self, provider: Option<Arc<dyn CapProvider>>) {
        self.config.write().unwrap().cap_provider = provider;
    }

    /// Install or replace the [`OneShotCapStaging`] side-policy.
    pub fn set_one_shot_caps(&self, staging: Option<Arc<OneShotCapStaging>>) {
        self.config.write().unwrap().one_shot_caps = staging;
    }

    /// Snapshot of durable capabilities currently held in the principal's bag
    /// (mirrors TS `HubSigningSender.listGrants()`).
    pub fn list_grants(&self) -> Vec<SignedCapability> {
        self.config
            .read()
            .unwrap()
            .principal
            .as_ref()
            .map(|p| p.cap_bag().capabilities())
            .unwrap_or_default()
    }

    /// Compact summary of currently held durable capabilities
    /// (mirrors `@hediet/linkrpc-mcp`'s `con.grants()`).
    pub fn grants(&self) -> GrantsSummary {
        summarize_grants(&self.list_grants())
    }
}

impl<C: RpcCall + 'static> SigningClient<C> {
    /// Bootstrap an executor-managed [`Principal`] over the raw unsigned `inner` channel, wrap
    /// it in a [`SigningClient`], and optionally install per-call capability auto-negotiation
    /// (mirrors TS `createManagedSigningChannel`).
    ///
    /// Note: the underlying channel's read loop (`channel.run()` / `conn.run()`) must already be
    /// running on your executor so the `identity::*` bootstrap calls receive replies.
    pub async fn create_managed(
        inner: C,
        options: ManagedSigningOptions,
    ) -> Result<Self, IdentityError> {
        let inner_arc = Arc::new(inner);
        let principal = create_managed_principal(inner_arc.clone()).await?;
        let client = Self {
            inner: inner_arc,
            config: Arc::new(RwLock::new(SigningConfig {
                principal: Some(principal.clone()),
                cap_provider: None,
                one_shot_caps: None,
            })),
        };
        if options.auto_negotiate_caps {
            let consumer = options
                .consumer
                .unwrap_or_else(|| HubAccessConsumer::new("linkrpc client"));
            let provider = AutoNegotiatingCapProvider {
                sender: Arc::new(client.clone()),
                principal,
                consumer,
            };
            client.set_cap_provider(Some(Arc::new(provider)));
        }
        Ok(client)
    }

    /// Request one or more capabilities from the hub via `hubAccess::requestAccess`
    /// (mirrors TS `HubSigningSender.requestAccess` and `@hediet/linkrpc-mcp`'s
    /// `con.requestAccess(...)`).
    ///
    /// Any durable (non-`callBind`) capabilities minted by the hub are automatically added to the
    /// principal's [`CapBag`](crate::identity::CapBag), so subsequent calls present them
    /// automatically.
    pub async fn request_access(
        &self,
        req: HubAccessRequest,
    ) -> Result<HubAccessResult, RpcCallError> {
        let Some(principal) = self.principal() else {
            return Err(RpcCallError::Local(JsonRpcError::new(
                error_codes::INVALID_REQUEST,
                "request_access requires an active signing principal",
            )));
        };
        let mut consumer_obj = serde_json::to_value(&req.consumer).map_err(|e| {
            RpcCallError::Local(JsonRpcError::new(
                error_codes::INTERNAL_ERROR,
                e.to_string(),
            ))
        })?;
        if let Some(map) = consumer_obj.as_object_mut() {
            map.insert(
                "principal".to_owned(),
                JsonValue::String(principal.id().as_str().to_owned()),
            );
        }
        let mut params = serde_json::Map::new();
        params.insert("consumer".to_owned(), consumer_obj);
        params.insert(
            "permissions".to_owned(),
            serde_json::to_value(&req.permissions).map_err(|e| {
                RpcCallError::Local(JsonRpcError::new(
                    error_codes::INTERNAL_ERROR,
                    e.to_string(),
                ))
            })?,
        );
        if let Some(duration) = req.duration {
            params.insert(
                "duration".to_owned(),
                serde_json::to_value(duration).map_err(|e| {
                    RpcCallError::Local(JsonRpcError::new(
                        error_codes::INTERNAL_ERROR,
                        e.to_string(),
                    ))
                })?,
            );
        }

        let raw = self
            .call_detailed("hubAccess::requestAccess", JsonValue::Object(params))
            .await?;

        let status = raw
            .as_object()
            .and_then(|o| o.get("status"))
            .and_then(JsonValue::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let reason = raw
            .as_object()
            .and_then(|o| o.get("reason"))
            .and_then(JsonValue::as_str)
            .map(str::to_owned);

        if status == "granted" {
            let capabilities: Vec<SignedCapability> = raw
                .as_object()
                .and_then(|o| o.get("capabilities"))
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| {
                    RpcCallError::Local(JsonRpcError::new(
                        error_codes::INTERNAL_ERROR,
                        format!("invalid capabilities in hubAccess response: {e}"),
                    ))
                })?
                .unwrap_or_default();
            let durable: Vec<SignedCapability> = capabilities
                .iter()
                .filter(|c| !c.is_one_shot())
                .cloned()
                .collect();
            let added_durable = durable.len();
            if !durable.is_empty() {
                principal.cap_bag().add(&durable).await.map_err(|e| {
                    RpcCallError::Local(JsonRpcError::new(
                        error_codes::INTERNAL_ERROR,
                        e.to_string(),
                    ))
                })?;
            }
            return Ok(HubAccessResult::Granted {
                capabilities,
                added_durable,
            });
        }
        if status == "denied" {
            return Ok(HubAccessResult::Denied { reason });
        }
        Ok(HubAccessResult::Other { status, reason })
    }

    /// Invoke a method, and if rejected with `PERMISSION_REQUIRED` (`-32401`), automatically
    /// request access for that exact `(serviceId, interfaceId, member)` via `hubAccess` and retry
    /// once (mirrors `@hediet/linkrpc-mcp`'s `con.call(..., { requestPermission: true })`).
    pub async fn call_with_permission(
        &self,
        method: &str,
        params: JsonValue,
        consumer: Option<HubAccessConsumer>,
        duration: Option<HubAccessDuration>,
    ) -> Result<JsonValue, RpcCallError> {
        match self.call_detailed(method, params.clone()).await {
            Ok(res) => Ok(res),
            Err(err) if is_permission_required_error(&err) => {
                let Some(ParsedMethodName::Full {
                    service_id,
                    interface_id,
                    member,
                }) = parse_method_name(method)
                else {
                    return Err(err);
                };
                let consumer = consumer.unwrap_or_else(|| {
                    HubAccessConsumer::new("linkrpc client")
                        .with_purpose(format!("Invoke {method}."))
                });
                let grant = self
                    .request_access(HubAccessRequest {
                        consumer,
                        permissions: vec![HubAccessPermission::invoke(
                            service_id,
                            interface_id,
                            [member],
                        )],
                        duration: duration.or(Some(HubAccessDuration::LongLived)),
                    })
                    .await?;
                if grant.is_granted() {
                    self.call_detailed(method, params).await
                } else {
                    Err(err)
                }
            }
            Err(err) => Err(err),
        }
    }

    /// Issue a request with explicit per-call [`SigningCallCtx`] overrides.
    pub async fn call_with_ctx(
        &self,
        method: &str,
        params: JsonValue,
        ctx: SigningCallCtx,
    ) -> Result<JsonValue, RpcCallError> {
        let (out_method, out_params) = self.prepare_outbound(method, params, Some(&ctx)).await?;
        self.inner.call_detailed(&out_method, out_params).await
    }

    /// Send a notification with explicit per-call [`SigningCallCtx`] overrides.
    pub async fn notify_with_ctx(
        &self,
        method: &str,
        params: JsonValue,
        ctx: SigningCallCtx,
    ) -> Result<(), RpcCallError> {
        let (out_method, out_params) = self.prepare_outbound(method, params, Some(&ctx)).await?;
        self.inner.notify_detailed(&out_method, out_params).await
    }

    /// Start a streaming call with explicit per-call [`SigningCallCtx`] overrides.
    pub async fn call_stream_with_ctx(
        &self,
        method: &str,
        params: JsonValue,
        ctx: SigningCallCtx,
    ) -> Result<RawStreamingCall, RpcCallError> {
        let (out_method, out_params) = self.prepare_outbound(method, params, Some(&ctx)).await?;
        self.inner
            .call_stream_detailed(&out_method, out_params)
            .await
    }

    async fn prepare_outbound(
        &self,
        method: &str,
        params: JsonValue,
        ctx: Option<&SigningCallCtx>,
    ) -> Result<(String, JsonValue), RpcCallError> {
        let (principal, cap_provider, one_shot_caps) = {
            let guard = self.config.read().unwrap();
            (
                guard.principal.clone(),
                guard.cap_provider.clone(),
                guard.one_shot_caps.clone(),
            )
        };

        let signer: Option<Arc<dyn SigningIdentity>> =
            match ctx.and_then(|c| c.signer_override.as_ref()) {
                Some(None) => None,
                Some(Some(id)) => Some(id.clone()),
                None => principal.as_ref().map(|p| p.identity().clone()),
            };

        let Some(signer) = signer else {
            return Ok((method.to_owned(), params));
        };

        let mut target_method = method.to_owned();
        let mut target_params = if params.is_null() { None } else { Some(params) };
        let mut target_interface_hash = ctx.and_then(|c| c.interface_hash.clone());
        let nonce_bytes = random_nonce_bytes();
        let nonce = base64url_encode(&nonce_bytes);
        let mut signed_at_ms = current_time_ms();

        let capabilities: Vec<SignedCapability> =
            if let Some(override_caps) = ctx.and_then(|c| c.caps_override.clone()) {
                override_caps
            } else {
                let mut caps = principal
                    .as_ref()
                    .map(|p| p.cap_bag().capabilities())
                    .unwrap_or_default();
                if let Some(staging) = &one_shot_caps {
                    let staged = staging.take();
                    if !staged.is_empty() {
                        caps.extend(staged);
                    }
                }
                if let Some(provider) = cap_provider {
                    let provided = provider
                        .provide(CapProviderRequest {
                            method: target_method.clone(),
                            params: target_params.clone(),
                            signer: signer.principal(),
                            nonce: nonce.clone(),
                            signed_at_ms,
                            interface_hash: target_interface_hash.clone(),
                        })
                        .await;
                    if let Some(m) = provided.method {
                        target_method = m;
                    }
                    if let Some(p) = provided.params {
                        target_params = Some(p);
                    }
                    if let Some(h) = provided.interface_hash {
                        target_interface_hash = Some(h);
                    }
                    if let Some(t) = provided.signed_at_ms {
                        signed_at_ms = t;
                    }
                    if let Some(c) = provided.capabilities {
                        caps = c;
                    }
                }
                caps
            };

        let signed = sign_rpc_call(
            signer.as_ref(),
            SignRpcCallOptions {
                method: target_method.clone(),
                params: target_params,
                now_ms: Some(signed_at_ms),
                nonce: Some(nonce_bytes),
                interface_hash: target_interface_hash,
            },
        )
        .await
        .map_err(|e| {
            RpcCallError::Local(JsonRpcError::new(
                error_codes::INTERNAL_ERROR,
                e.to_string(),
            ))
        })?;

        let wire_params = if capabilities.is_empty() {
            signed.wire_params
        } else {
            attach_capabilities(&signed.wire_params, &capabilities).map_err(|e| {
                RpcCallError::Local(JsonRpcError::new(
                    error_codes::INTERNAL_ERROR,
                    e.to_string(),
                ))
            })?
        };
        Ok((target_method, wire_params))
    }
}

#[async_trait]
impl<C: RpcCall + 'static> RpcCall for SigningClient<C> {
    async fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, JsonRpcError> {
        self.call_detailed(method, params)
            .await
            .map_err(RpcCallError::into_rpc_error)
    }

    async fn call_detailed(
        &self,
        method: &str,
        params: JsonValue,
    ) -> Result<JsonValue, RpcCallError> {
        let (out_method, out_params) = self.prepare_outbound(method, params, None).await?;
        self.inner.call_detailed(&out_method, out_params).await
    }

    async fn notify(&self, method: &str, params: JsonValue) -> Result<(), JsonRpcError> {
        self.notify_detailed(method, params)
            .await
            .map_err(RpcCallError::into_rpc_error)
    }

    async fn notify_detailed(&self, method: &str, params: JsonValue) -> Result<(), RpcCallError> {
        let (out_method, out_params) = self.prepare_outbound(method, params, None).await?;
        self.inner.notify_detailed(&out_method, out_params).await
    }

    async fn call_stream(
        &self,
        method: &str,
        params: JsonValue,
    ) -> Result<RawStreamingCall, JsonRpcError> {
        self.call_stream_detailed(method, params)
            .await
            .map_err(RpcCallError::into_rpc_error)
    }

    async fn call_stream_detailed(
        &self,
        method: &str,
        params: JsonValue,
    ) -> Result<RawStreamingCall, RpcCallError> {
        let (out_method, out_params) = self.prepare_outbound(method, params, None).await?;
        self.inner
            .call_stream_detailed(&out_method, out_params)
            .await
    }
}

fn is_permission_required_error(err: &RpcCallError) -> bool {
    match err {
        RpcCallError::Remote(e) => e.code == error_codes::PERMISSION_REQUIRED,
        RpcCallError::NonCompliantServer { original, .. } => {
            original.code == error_codes::PERMISSION_REQUIRED
        }
        _ => false,
    }
}

// ── Auto-negotiating CapProvider (mirrors TS `createAutoNegotiatingCapProvider`) ──

struct AutoNegotiatingCapProvider<C: RpcCall + 'static> {
    sender: Arc<SigningClient<C>>,
    principal: Principal,
    consumer: HubAccessConsumer,
}

#[async_trait]
impl<C: RpcCall + 'static> CapProvider for AutoNegotiatingCapProvider<C> {
    async fn provide(&self, req: CapProviderRequest) -> CapProviderResult {
        let fresh = self
            .principal
            .cap_bag()
            .fresh_capabilities(req.signed_at_ms, CAP_FRESHNESS_MARGIN_MS);
        let present = if fresh.is_empty() {
            CapProviderResult::default()
        } else {
            CapProviderResult {
                capabilities: Some(fresh.clone()),
                ..CapProviderResult::default()
            }
        };

        let Some(ParsedMethodName::Full {
            service_id,
            interface_id,
            member,
        }) = parse_method_name(&req.method)
        else {
            // Never negotiate for root-addressed / bare / malformed calls.
            return present;
        };
        if service_id.is_empty() || interface_id == "hubAccess" {
            return present;
        }

        let durable_fresh: Vec<SignedCapability> =
            fresh.iter().filter(|c| !c.is_one_shot()).cloned().collect();
        let target = CallTarget {
            service_id: service_id.clone(),
            interface_id: interface_id.clone(),
            member: member.clone(),
            interface_hash: req.interface_hash.clone(),
        };
        let call = Call {
            target,
            params: req.params.clone().unwrap_or_else(|| json!({})),
            nonce: req.nonce.clone(),
            signed_at_ms: req.signed_at_ms,
            signer: req.signer.clone(),
            call_hash: String::new(),
        };
        let root_candidates: Vec<AcceptedRootIssuer> = durable_fresh
            .iter()
            .filter(|c| c.capability.parent_hash.is_none())
            .map(|c| AcceptedRootIssuer {
                principal: c.capability.issuer.clone(),
                is_public: false,
            })
            .collect();
        if permits(
            &call,
            &durable_fresh,
            |_| root_candidates.clone(),
            req.signed_at_ms.saturating_add(CAP_FRESHNESS_MARGIN_MS),
            None,
        )
        .is_allowed()
        {
            return present;
        }

        let mut consumer = self.consumer.clone();
        if consumer.purpose.is_none() {
            consumer.purpose = Some(format!("Invoke {}.", req.method));
        }

        let exact_params = exact_param_matchers(req.params.as_ref());
        let permission = HubAccessPermission {
            target: TargetPattern {
                service_id: Pattern::exact(service_id),
                interface_id: Pattern::exact(interface_id),
                interface_hash: None,
                members: vec![Pattern::exact(member)],
            },
            can_invoke: Some(true),
            can_delegate: None,
            params: Some(exact_params),
            call_bind: None,
            call_intent: Some(CallIntent {
                method: req.method.clone(),
                params: req.params.clone(),
                interface_hash: req.interface_hash.clone(),
                nonce: req.nonce.clone(),
                signed_at_ms: req.signed_at_ms,
                summary: None,
                suggestion: Some(HubAccessDuration::Once),
            }),
        };

        // Fail-soft: any negotiation error falls back to presenting the current bag.
        let Ok(HubAccessResult::Granted { capabilities, .. }) = self
            .sender
            .request_access(HubAccessRequest {
                consumer,
                permissions: vec![permission],
                duration: Some(HubAccessDuration::Once),
            })
            .await
        else {
            return present;
        };

        if capabilities.is_empty() {
            return present;
        }
        let one_shot: Vec<SignedCapability> = capabilities
            .into_iter()
            .filter(SignedCapability::is_one_shot)
            .collect();
        let mut all_fresh = self
            .principal
            .cap_bag()
            .fresh_capabilities(req.signed_at_ms, CAP_FRESHNESS_MARGIN_MS);
        all_fresh.extend(one_shot);
        if all_fresh.is_empty() {
            CapProviderResult::default()
        } else {
            CapProviderResult {
                capabilities: Some(all_fresh),
                ..CapProviderResult::default()
            }
        }
    }
}

fn exact_param_matchers(params: Option<&JsonValue>) -> BTreeMap<String, ParamMatcher> {
    let Some(JsonValue::Object(map)) = params else {
        return BTreeMap::new();
    };
    map.iter()
        .map(|(k, v)| (k.clone(), ParamMatcher::exact(v.clone())))
        .collect()
}

// ── Inbound signature verification decorators ────────────────────────────────

/// Inbound [`RequestHandler`] decorator that verifies `$hubrpc` signatures before delegating
/// to `inner`.
///
/// When `require_signed` is `false` (default), unsigned calls pass through untouched while
/// present-but-invalid signatures are rejected with `INVALID_REQUEST`. When `require_signed` is
/// `true`, unsigned calls are also rejected.
pub struct VerifyingRequestHandler<H> {
    inner: H,
    require_signed: bool,
    max_skew_ms: Option<i64>,
}

impl<H> VerifyingRequestHandler<H> {
    pub fn new(inner: H, require_signed: bool) -> Self {
        Self {
            inner,
            require_signed,
            max_skew_ms: None,
        }
    }

    pub fn with_max_skew_ms(mut self, max_skew_ms: i64) -> Self {
        self.max_skew_ms = Some(max_skew_ms);
        self
    }
}

#[async_trait]
impl<H: RequestHandler> RequestHandler for VerifyingRequestHandler<H> {
    async fn handle_request(
        &self,
        method: String,
        params: JsonValue,
    ) -> Result<JsonValue, JsonRpcError> {
        self.handle_request_with_context(method, params, CallCtx::default())
            .await
    }

    async fn handle_request_with_context(
        &self,
        method: String,
        params: JsonValue,
        ctx: CallCtx,
    ) -> Result<JsonValue, JsonRpcError> {
        let verified = verify_rpc_call(VerifyRpcCallOptions {
            wire_method: &method,
            wire_params: Some(&params),
            now_ms: None,
            max_skew_ms: self.max_skew_ms,
            require_signed: self.require_signed,
        })
        .map_err(|e| JsonRpcError::new(error_codes::INVALID_REQUEST, e.reason))?;
        let user_params = verified.params.unwrap_or(JsonValue::Null);
        self.inner
            .handle_request_with_context(method, user_params, ctx)
            .await
    }

    async fn handle_notification(&self, method: String, params: JsonValue) {
        self.handle_notification_with_context(method, params, CallCtx::default())
            .await;
    }

    async fn handle_notification_with_context(
        &self,
        method: String,
        params: JsonValue,
        ctx: CallCtx,
    ) {
        let Ok(verified) = verify_rpc_call(VerifyRpcCallOptions {
            wire_method: &method,
            wire_params: Some(&params),
            now_ms: None,
            max_skew_ms: self.max_skew_ms,
            require_signed: self.require_signed,
        }) else {
            return;
        };
        let user_params = verified.params.unwrap_or(JsonValue::Null);
        self.inner
            .handle_notification_with_context(method, user_params, ctx)
            .await;
    }
}

/// Transport-level authenticity gate mirroring TS `withVerifiedSignature`:
/// rejects inbound requests carrying invalid `$hubrpc` signatures directly on the transport
/// while passing unsigned and validly-signed messages through unchanged.
pub struct VerifiedSignatureTransport {
    inner: Box<dyn MessageTransport>,
    require_signed: bool,
    max_skew_ms: Option<i64>,
}

impl VerifiedSignatureTransport {
    pub fn new(inner: Box<dyn MessageTransport>, require_signed: bool) -> Self {
        Self {
            inner,
            require_signed,
            max_skew_ms: None,
        }
    }

    pub fn with_max_skew_ms(mut self, max_skew_ms: i64) -> Self {
        self.max_skew_ms = Some(max_skew_ms);
        self
    }
}

#[async_trait]
impl MessageTransport for VerifiedSignatureTransport {
    async fn send(&self, msg: JsonRpcMessage) -> Result<(), TransportError> {
        self.inner.send(msg).await
    }

    async fn recv(&self) -> Option<JsonRpcMessage> {
        loop {
            let msg = self.inner.recv().await?;
            if let JsonRpcMessage::Request(ref req) = msg {
                let res = verify_rpc_call(VerifyRpcCallOptions {
                    wire_method: &req.method,
                    wire_params: req.params.as_ref(),
                    now_ms: None,
                    max_skew_ms: self.max_skew_ms,
                    require_signed: self.require_signed,
                });
                if let Err(err) = res {
                    let _ = self
                        .inner
                        .send(JsonRpcMessage::Response(JsonRpcResponse {
                            id: Some(req.id.clone()),
                            payload: ResponsePayload::Error(JsonRpcError::new(
                                error_codes::INVALID_REQUEST,
                                err.reason,
                            )),
                        }))
                        .await;
                    continue;
                }
            }
            return Some(msg);
        }
    }
}
