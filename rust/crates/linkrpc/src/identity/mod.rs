//! Optional cryptographic identity, `$hubrpc` signed envelopes, capabilities, and hub grant flow.
//!
//! Identity in LinkRPC is **optional** — plain [`LinkRpcConnection`](crate::connection::hub_connection::LinkRpcConnection)
//! and [`Channel`](crate::connection::channel::Channel) connections continue to work unsigned.
//! When talking to a gated hub or verifying callers, layer identity on top:
//!
//! - **Keys & storage** ([`keys`]): Ed25519 [`KeypairSigningIdentity`], abstract
//!   [`SigningIdentity`], [`PublicSigningIdentity`], fail-closed [`resolve_signing_key`], and
//!   pluggable [`KeyStore`] / [`IdentityStorage`] (in-memory + file-backed, format-compatible
//!   with TypeScript).
//! - **Signed objects & envelopes** ([`signed_envelope`]): [`sign_object`], [`verify_object`],
//!   [`verify_object_by_principal`], [`sign_rpc_call`], [`attach_capabilities`],
//!   [`verify_rpc_call`].
//! - **Capabilities & bags** ([`capability`]): [`Capability`], [`SignedCapability`],
//!   [`Permission`], [`TargetPattern`], [`Pattern`], [`ParamMatcher`], [`CallBind`],
//!   [`issue_capability`], [`permits`], and persistent/in-memory [`CapBag`].
//! - **Principals & managed identity** ([`principal`]): [`Principal`], [`ManagedIdentity`], and
//!   [`create_managed_principal`] (`identity::*` + `identity.storage::*` root overlay).
//! - **Signing channel & grant flow** ([`signing_channel`], [`grants`]): [`SigningClient`]
//!   (implements [`RpcCall`](crate::client::RpcCall)), [`SigningClient::create_managed`],
//!   [`SigningClient::grants`], [`SigningClient::request_access`],
//!   [`SigningClient::call_with_permission`], and inbound [`VerifyingRequestHandler`] /
//!   [`VerifiedSignatureTransport`].
//!
//! # Quick example
//!
//! ```no_run
//! use linkrpc::prelude::*;
//!
//! # async fn example(conn: LinkRpcConnection) -> Result<(), Box<dyn std::error::Error>> {
//! let principal = Principal::from_file("/tmp/my-agent.json").await?;
//! let client = conn.signing(principal);
//!
//! // Inspect currently held durable grants (like `con.grants()` in @hediet/linkrpc-mcp).
//! let summary = client.grants();
//! assert_eq!(summary.count, 0);
//!
//! // Request access from the hub before invoking a gated service.
//! client
//!     .request_access(HubAccessRequest::new(
//!         HubAccessConsumer::new("my-rust-client").with_purpose("greet the user"),
//!         vec![HubAccessPermission::invoke("hello", "greeter", ["hello"])],
//!         Some(HubAccessDuration::Persistent),
//!     ))
//!     .await?;
//!
//! // Every subsequent call is Ed25519-signed and presents the granted capability automatically.
//! let reply = client
//!     .call_detailed("hello::greeter::hello", serde_json::json!({ "name": "world" }))
//!     .await?;
//! # let _ = reply;
//! # Ok(())
//! # }
//! ```

pub mod capability;
pub mod error;
pub mod grants;
pub mod keys;
pub mod principal;
pub mod signed_envelope;
pub mod signing_channel;

pub use capability::{
    capability_fresh_at, capability_permits, issue_capability, match_params,
    permission_matches_target, permission_permits, permits, sign_capability, Ability,
    AcceptedRootIssuer, Call, CallBind, CallTarget, CapBag, Capability, IssueCapabilityOptions,
    ParamMatcher, Pattern, Permission, PermitResult, SignedCapability, TargetPattern,
    DEFAULT_CAP_BAG_STORAGE_KEY,
};
pub use error::IdentityError;
pub use grants::{
    summarize_grants, CallIntent, GrantPermissionSummary, GrantSummary, GrantsSummary,
    HubAccessConsumer, HubAccessDuration, HubAccessPermission, HubAccessRequest, HubAccessResult,
};
pub use keys::{
    resolve_signing_key, verify_ed25519, FileIdentityStorage, FileKeyStore, IdentityStorage,
    InMemoryIdentityStorage, InMemoryKeyStore, KeyStore, KeypairSigningIdentity,
    PublicSigningIdentity, SerializedKeypairSigningIdentity, SigningIdentity,
};
pub use principal::{
    create_managed_principal, ManagedIdentity, ManagedIdentityStorageClient, Principal,
};
pub use signed_envelope::{
    attach_capabilities, current_time_ms, sign_object, sign_rpc_call, verify_object,
    verify_object_by_principal, verify_rpc_call, SignRpcCallOptions, SignedRpcCall,
    VerifiedCallIdentity, VerifyRpcCallError, VerifyRpcCallOptions, VerifyRpcCallResult,
    DEFAULT_MAX_SKEW_MS,
};
pub use signing_channel::{
    CapProvider, CapProviderRequest, CapProviderResult, ManagedSigningOptions, OneShotCapStaging,
    SigningCallCtx, SigningClient, SigningConfig, VerifiedSignatureTransport,
    VerifyingRequestHandler,
};
