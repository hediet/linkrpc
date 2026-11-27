//! Principals and executor-managed identities (`identity::*` + `identity.storage::*`).
//!
//! Port of TypeScript `identity/principal.ts`, `identity/managedIdentity.ts`,
//! `identity/managedPrincipal.ts`, and `node/principal.ts`.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::client::RpcCall;
use crate::identity::capability::{CapBag, SignedCapability};
use crate::identity::error::IdentityError;
use crate::identity::keys::{
    FileIdentityStorage, FileKeyStore, IdentityStorage, KeyStore, KeypairSigningIdentity,
    PublicSigningIdentity, SigningIdentity,
};
use crate::protocol::json_value::JsonValue;
use crate::protocol::signed_object::{base64url_decode, base64url_encode, PrincipalId};

/// A signing identity bundled with its durable capability set (and optional per-identity store).
///
/// Mirrors TypeScript `Principal` / `PrincipalWithStore`: the [`SigningIdentity`] is fixed for
/// the life of the principal while its [`CapBag`] grows as the hub grants durable capabilities.
#[derive(Clone)]
pub struct Principal {
    identity: Arc<dyn SigningIdentity>,
    cap_bag: Arc<CapBag>,
    store: Option<Arc<dyn IdentityStorage>>,
}

impl std::fmt::Debug for Principal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Principal")
            .field("id", &self.id())
            .field("cap_bag", &self.cap_bag)
            .field("has_store", &self.store.is_some())
            .finish()
    }
}

impl Principal {
    /// Construct a principal from an identity and capability bag.
    pub fn new(identity: Arc<dyn SigningIdentity>, cap_bag: Arc<CapBag>) -> Self {
        Self {
            identity,
            cap_bag,
            store: None,
        }
    }

    /// Construct a principal with an attached per-identity [`IdentityStorage`].
    pub fn with_store(
        identity: Arc<dyn SigningIdentity>,
        cap_bag: Arc<CapBag>,
        store: Arc<dyn IdentityStorage>,
    ) -> Self {
        Self {
            identity,
            cap_bag,
            store: Some(store),
        }
    }

    /// Ephemeral in-memory principal with an empty capability bag.
    pub fn in_memory(identity: impl SigningIdentity + 'static) -> Self {
        Self::new(Arc::new(identity), Arc::new(CapBag::in_memory()))
    }

    /// Ephemeral in-memory principal pre-populated with `capabilities`.
    pub fn in_memory_with_capabilities(
        identity: impl SigningIdentity + 'static,
        capabilities: Vec<SignedCapability>,
    ) -> Self {
        Self::new(
            Arc::new(identity),
            Arc::new(CapBag::with_capabilities(capabilities)),
        )
    }

    /// Generate a fresh random in-memory Ed25519 principal.
    pub fn generate_in_memory() -> Self {
        Self::in_memory(KeypairSigningIdentity::generate())
    }

    /// Deterministically derive an in-memory Ed25519 principal from a numeric seed
    /// (matches TS `createSeededMemoryPrincipal({ seed })`). For tests only.
    pub fn from_numeric_seed(seed: u64) -> Self {
        Self::in_memory(KeypairSigningIdentity::from_numeric_seed(seed))
    }

    /// Load or create a self-managed principal using a pluggable [`KeyStore`] and
    /// [`IdentityStorage`].
    pub async fn load_or_create(
        key_store: &dyn KeyStore,
        slot: &str,
        storage: Arc<dyn IdentityStorage>,
    ) -> Result<Self, IdentityError> {
        let identity = key_store.load_or_create(slot).await?;
        let cap_bag = CapBag::load(storage.clone()).await?;
        Ok(Self::with_store(
            Arc::new(identity),
            Arc::new(cap_bag),
            storage,
        ))
    }

    /// Load or create a self-managed principal from an exact JSON keypair file on disk, storing
    /// its durable capabilities in a sibling `.caps.json` file (mirrors TS
    /// `createSelfManagedPrincipalFromFile`).
    pub async fn from_file(path: impl AsRef<Path>) -> Result<Self, IdentityError> {
        let identity = FileKeyStore::load_or_create_file(path.as_ref())?;
        let caps_path = FileKeyStore::sibling_caps_path(path.as_ref());
        let storage: Arc<dyn IdentityStorage> = Arc::new(FileIdentityStorage::new(caps_path));
        let cap_bag = CapBag::load(storage.clone()).await?;
        Ok(Self::with_store(
            Arc::new(identity),
            Arc::new(cap_bag),
            storage,
        ))
    }

    /// This principal's stable [`PrincipalId`].
    pub fn id(&self) -> PrincipalId {
        self.identity.principal()
    }

    /// Public signing identity (`principal` + `key_id`).
    pub fn public_identity(&self) -> PublicSigningIdentity {
        self.identity.public_signing_identity()
    }

    /// The underlying [`SigningIdentity`].
    pub fn identity(&self) -> &Arc<dyn SigningIdentity> {
        &self.identity
    }

    /// The live, mutable durable capability bag.
    pub fn cap_bag(&self) -> &Arc<CapBag> {
        &self.cap_bag
    }

    /// Optional per-identity persistent storage (present for file-backed or managed principals).
    pub fn store(&self) -> Option<&Arc<dyn IdentityStorage>> {
        self.store.as_ref()
    }
}

// ── Executor-managed identity over `identity::*` + `identity.storage::*` ─────

/// Client-side proxy for the executor's root-overlay `identity.storage::*` interface.
///
/// Calls ride the raw (unsigned) sender — the root overlay is private to this participant, so
/// transport routing authenticates the caller and avoids signing recursion.
pub struct ManagedIdentityStorageClient {
    sender: Arc<dyn RpcCall>,
}

impl ManagedIdentityStorageClient {
    pub fn new(sender: Arc<dyn RpcCall>) -> Self {
        Self { sender }
    }
}

#[async_trait]
impl IdentityStorage for ManagedIdentityStorageClient {
    async fn get(&self, key: &str) -> Result<Option<JsonValue>, IdentityError> {
        let raw = self
            .sender
            .call("identity.storage::get", json!({ "key": key }))
            .await
            .map_err(|e| IdentityError::Remote(e.message))?;
        Ok(raw.as_object().and_then(|o| o.get("value")).cloned())
    }

    async fn set(&self, key: &str, value: JsonValue) -> Result<(), IdentityError> {
        self.sender
            .call(
                "identity.storage::set",
                json!({ "key": key, "value": value }),
            )
            .await
            .map_err(|e| IdentityError::Remote(e.message))?;
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<bool, IdentityError> {
        let raw = self
            .sender
            .call("identity.storage::delete", json!({ "key": key }))
            .await
            .map_err(|e| IdentityError::Remote(e.message))?;
        Ok(raw
            .as_object()
            .and_then(|o| o.get("existed"))
            .and_then(JsonValue::as_bool)
            .unwrap_or(false))
    }

    async fn list(&self, prefix: Option<&str>) -> Result<Vec<String>, IdentityError> {
        let params = match prefix {
            Some(p) => json!({ "prefix": p }),
            None => json!({}),
        };
        let raw = self
            .sender
            .call("identity.storage::list", params)
            .await
            .map_err(|e| IdentityError::Remote(e.message))?;
        Ok(raw
            .as_object()
            .and_then(|o| o.get("keys"))
            .and_then(JsonValue::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default())
    }
}

/// Executor-managed [`SigningIdentity`] that delegates signing to the peer's root-overlay
/// `identity::sign` oracle (private key material never leaves the executor).
///
/// Mirrors TypeScript `createManagedIdentity`.
pub struct ManagedIdentity {
    sender: Arc<dyn RpcCall>,
    public: PublicSigningIdentity,
    storage: Arc<dyn IdentityStorage>,
}

impl std::fmt::Debug for ManagedIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagedIdentity")
            .field("principal", self.public.principal())
            .finish()
    }
}

impl ManagedIdentity {
    /// Bootstrap a managed identity over the **raw, unsigned** `sender`.
    ///
    /// Calls `identity::getPrincipal` and validates that the returned principal carries a valid
    /// 32-byte inline Ed25519 key.
    pub async fn bootstrap(sender: Arc<dyn RpcCall>) -> Result<Self, IdentityError> {
        let raw = sender
            .call("identity::getPrincipal", json!({}))
            .await
            .map_err(|e| IdentityError::Remote(e.message))?;
        let principal_str = raw
            .as_object()
            .and_then(|o| o.get("principal"))
            .and_then(JsonValue::as_str)
            .ok_or_else(|| {
                IdentityError::Remote("identity::getPrincipal returned missing principal".into())
            })?;
        let principal = PrincipalId::new(principal_str);
        // Validate fail-closed before installing.
        principal.key_id()?.public_key_bytes()?;
        let storage: Arc<dyn IdentityStorage> =
            Arc::new(ManagedIdentityStorageClient::new(sender.clone()));
        Ok(Self {
            sender,
            public: PublicSigningIdentity::new(principal),
            storage,
        })
    }

    /// Access the executor-backed per-identity storage proxy (`identity.storage::*`).
    pub fn storage(&self) -> &Arc<dyn IdentityStorage> {
        &self.storage
    }
}

#[async_trait]
impl SigningIdentity for ManagedIdentity {
    fn public_signing_identity(&self) -> PublicSigningIdentity {
        self.public.clone()
    }

    async fn sign(&self, bytes: &[u8]) -> Result<[u8; 64], IdentityError> {
        let raw = self
            .sender
            .call(
                "identity::sign",
                json!({ "bytes": base64url_encode(bytes) }),
            )
            .await
            .map_err(|e| IdentityError::Signing(e.message))?;
        let sig_str = raw
            .as_object()
            .and_then(|o| o.get("signature"))
            .and_then(JsonValue::as_str)
            .ok_or_else(|| {
                IdentityError::Signing("identity::sign returned missing signature".into())
            })?;
        let sig_bytes = base64url_decode(sig_str)?;
        sig_bytes
            .try_into()
            .map_err(|v: Vec<u8>| IdentityError::InvalidSignatureLength {
                expected: 64,
                actual: v.len(),
            })
    }
}

/// Bootstrap an executor-managed [`Principal`] over the raw unsigned `sender` (mirrors TS
/// `createManagedPrincipal`).
///
/// Hydrates the principal's [`CapBag`] from `identity.storage::*` when available; if the peer
/// does not serve `identity.storage`, starts with an empty bag (matching TS `CapBag.load`
/// fail-soft hydration).
pub async fn create_managed_principal(
    sender: Arc<dyn RpcCall>,
) -> Result<Principal, IdentityError> {
    let identity = ManagedIdentity::bootstrap(sender).await?;
    let storage = identity.storage().clone();
    let cap_bag = match CapBag::load(storage.clone()).await {
        Ok(bag) => bag,
        Err(_) => CapBag::in_memory(),
    };
    Ok(Principal::with_store(
        Arc::new(identity),
        Arc::new(cap_bag),
        storage,
    ))
}
