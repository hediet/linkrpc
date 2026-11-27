//! Ed25519 signing identities, key resolution, and pluggable key/state storage.
//!
//! Port of TypeScript `crypto/cryptoProvider.ts`, `identity/identity.ts`,
//! `identity/seededPrincipal.ts`, `node/hubClient.ts` (`loadOrCreateIdentity`), and
//! `node/fileManagedIdentityStorage.ts`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use async_trait::async_trait;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::identity::error::IdentityError;
use crate::protocol::json_value::JsonValue;
use crate::protocol::signed_object::{
    base64url_decode, base64url_encode, KeyId, PrincipalId, KEY_ID_PREFIX, PRINCIPAL_PREFIX,
};

/// The public face of a signing identity: its stable [`PrincipalId`] and active [`KeyId`].
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PublicSigningIdentity {
    principal: PrincipalId,
}

impl PublicSigningIdentity {
    /// Construct from a [`PrincipalId`].
    pub fn new(principal: PrincipalId) -> Self {
        Self { principal }
    }

    /// Construct from a raw 32-byte Ed25519 public key.
    pub fn from_public_key(public_key: &[u8; 32]) -> Self {
        Self {
            principal: PrincipalId::from_public_key(public_key),
        }
    }

    /// The stable principal name (`"id:key:<b64url(pk)>"`).
    pub fn principal(&self) -> &PrincipalId {
        &self.principal
    }

    /// The active [`KeyId`] (`"key:<b64url(pk)>"`, derived by stripping `"id:"` in v1).
    pub fn key_id(&self) -> Result<KeyId, IdentityError> {
        self.principal.key_id()
    }

    /// The raw 32-byte Ed25519 public key embedded in this v1 principal.
    pub fn public_key_bytes(&self) -> Result<[u8; 32], IdentityError> {
        self.key_id()?.public_key_bytes()
    }

    /// Verify a 64-byte Ed25519 signature over `message`. Returns `false` on any malformed input.
    pub fn verify(&self, message: &[u8], signature: &[u8]) -> bool {
        let Ok(pk) = self.public_key_bytes() else {
            return false;
        };
        verify_ed25519(&pk, message, signature)
    }
}

/// Abstract signing identity — implemented by [`KeypairSigningIdentity`] (in-memory Ed25519),
/// [`crate::identity::principal::ManagedIdentity`] (remote `identity::sign` oracle), or custom
/// HSM / OS keystore backends.
#[async_trait]
pub trait SigningIdentity: Send + Sync {
    /// Public identity (`principal` + `key_id`).
    fn public_signing_identity(&self) -> PublicSigningIdentity;

    /// Produce a 64-byte RFC 8032 Ed25519 signature over `bytes`.
    async fn sign(&self, bytes: &[u8]) -> Result<[u8; 64], IdentityError>;

    /// Convenience: this identity's [`PrincipalId`].
    fn principal(&self) -> PrincipalId {
        self.public_signing_identity().principal().clone()
    }

    /// Convenience: this identity's active [`KeyId`].
    fn key_id(&self) -> Result<KeyId, IdentityError> {
        self.public_signing_identity().key_id()
    }
}

/// JSON-serializable representation of a [`KeypairSigningIdentity`] (base64url raw keys).
///
/// Wire-compatible with TypeScript `SerializedKeypairSigningIdentity` and `loadOrCreateIdentity`
/// files (`{ "privateKey": "...", "publicKey": "..." }`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedKeypairSigningIdentity {
    /// Unpadded base64url of the 32-byte Ed25519 seed (private key).
    pub private_key: String,
    /// Unpadded base64url of the 32-byte Ed25519 public key.
    pub public_key: String,
    /// Optional slot identifier preserved when written by [`FileKeyStore`].
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
}

/// In-memory Ed25519 [`SigningIdentity`].
#[derive(Clone)]
pub struct KeypairSigningIdentity {
    signing_key: SigningKey,
    public: PublicSigningIdentity,
}

impl std::fmt::Debug for KeypairSigningIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeypairSigningIdentity")
            .field("principal", self.public.principal())
            .finish_non_exhaustive()
    }
}

impl KeypairSigningIdentity {
    /// Generate a fresh random Ed25519 signing identity using OS entropy.
    pub fn generate() -> Self {
        let mut rng = rand::rngs::OsRng;
        let signing_key = SigningKey::generate(&mut rng);
        Self::from_signing_key(signing_key)
    }

    /// Construct from a raw 32-byte Ed25519 seed (private key).
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self::from_signing_key(SigningKey::from_bytes(&seed))
    }

    /// Deterministically derive an Ed25519 identity from a numeric seed, matching TypeScript's
    /// `createSeededSigningIdentity({ seed })` (`sha256("linkrpc.seed.ed25519:<seed>")`).
    ///
    /// **For tests and reproducible fixtures only** — never use low-entropy seeds in production.
    pub fn from_numeric_seed(seed: u64) -> Self {
        let digest = Sha256::digest(format!("linkrpc.seed.ed25519:{seed}").as_bytes());
        let seed_bytes: [u8; 32] = digest.into();
        Self::from_seed(seed_bytes)
    }

    fn from_signing_key(signing_key: SigningKey) -> Self {
        let public_bytes = signing_key.verifying_key().to_bytes();
        let public = PublicSigningIdentity::from_public_key(&public_bytes);
        Self {
            signing_key,
            public,
        }
    }

    /// Raw 32-byte Ed25519 seed (private key).
    pub fn private_key_bytes(&self) -> [u8; 32] {
        self.signing_key.to_bytes()
    }

    /// Raw 32-byte Ed25519 public key.
    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    /// Serialize to the TypeScript-compatible JSON representation.
    pub fn to_json(&self) -> SerializedKeypairSigningIdentity {
        SerializedKeypairSigningIdentity {
            private_key: base64url_encode(&self.private_key_bytes()),
            public_key: base64url_encode(&self.public_key_bytes()),
            id: None,
        }
    }

    /// Restore from the TypeScript-compatible JSON representation.
    ///
    /// Verifies that the decoded public key matches the key derived from `privateKey`.
    pub fn from_json(json: &SerializedKeypairSigningIdentity) -> Result<Self, IdentityError> {
        let private_vec = base64url_decode(&json.private_key)?;
        let private_bytes: [u8; 32] =
            private_vec
                .try_into()
                .map_err(|v: Vec<u8>| IdentityError::InvalidKeyLength {
                    expected: 32,
                    actual: v.len(),
                })?;
        let public_vec = base64url_decode(&json.public_key)?;
        let public_bytes: [u8; 32] =
            public_vec
                .try_into()
                .map_err(|v: Vec<u8>| IdentityError::InvalidKeyLength {
                    expected: 32,
                    actual: v.len(),
                })?;
        let identity = Self::from_seed(private_bytes);
        if identity.public_key_bytes() != public_bytes {
            return Err(IdentityError::MalformedIdentityFile(
                "public key does not match private key seed".into(),
            ));
        }
        Ok(identity)
    }

    /// Synchronously sign `bytes` with this in-memory Ed25519 key.
    pub fn sign_sync(&self, bytes: &[u8]) -> [u8; 64] {
        self.signing_key.sign(bytes).to_bytes()
    }
}

#[async_trait]
impl SigningIdentity for KeypairSigningIdentity {
    fn public_signing_identity(&self) -> PublicSigningIdentity {
        self.public.clone()
    }

    async fn sign(&self, bytes: &[u8]) -> Result<[u8; 64], IdentityError> {
        Ok(self.sign_sync(bytes))
    }
}

/// Resolve the verifying 32-byte Ed25519 public key for `(principal, key_id)`.
///
/// Fail-closed (matches TS `resolveSigningKey` and spec 06 §3): in v1, `key_id` must start with
/// `"key:"`, `"id:" + key_id` must equal `principal`, and the base64url payload must decode to
/// exactly 32 bytes.
pub fn resolve_signing_key(principal: &PrincipalId, key_id: &KeyId) -> Option<[u8; 32]> {
    if !key_id.as_str().starts_with(KEY_ID_PREFIX) {
        return None;
    }
    if format!("{PRINCIPAL_PREFIX}{}", key_id.as_str()) != principal.as_str() {
        return None;
    }
    key_id.public_key_bytes().ok()
}

/// Verify an Ed25519 signature over `message`.
///
/// Returns `false` (never panics) on malformed keys, malformed signatures, or bad signatures.
pub fn verify_ed25519(public_key: &[u8; 32], message: &[u8], signature: &[u8]) -> bool {
    let Ok(verifying_key) = VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(signature) else {
        return false;
    };
    verifying_key.verify_strict(message, &sig).is_ok()
}

// ── Pluggable per-identity key/value storage (for CapBag & app state) ────────

/// Pluggable per-identity JSON key/value storage (mirrors TS `ManagedIdentityStorage`).
#[async_trait]
pub trait IdentityStorage: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<JsonValue>, IdentityError>;
    async fn set(&self, key: &str, value: JsonValue) -> Result<(), IdentityError>;
    async fn delete(&self, key: &str) -> Result<bool, IdentityError>;
    async fn list(&self, prefix: Option<&str>) -> Result<Vec<String>, IdentityError>;
}

/// In-memory [`IdentityStorage`] implementation (ephemeral, process lifetime).
#[derive(Debug, Default)]
pub struct InMemoryIdentityStorage {
    data: RwLock<BTreeMap<String, JsonValue>>,
}

impl InMemoryIdentityStorage {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl IdentityStorage for InMemoryIdentityStorage {
    async fn get(&self, key: &str) -> Result<Option<JsonValue>, IdentityError> {
        Ok(self.data.read().unwrap().get(key).cloned())
    }

    async fn set(&self, key: &str, value: JsonValue) -> Result<(), IdentityError> {
        self.data.write().unwrap().insert(key.to_owned(), value);
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<bool, IdentityError> {
        Ok(self.data.write().unwrap().remove(key).is_some())
    }

    async fn list(&self, prefix: Option<&str>) -> Result<Vec<String>, IdentityError> {
        let guard = self.data.read().unwrap();
        Ok(guard
            .keys()
            .filter(|k| prefix.is_none_or(|p| k.starts_with(p)))
            .cloned()
            .collect())
    }
}

/// File-backed [`IdentityStorage`] storing a single JSON object on disk (mode `0o600` on Unix).
///
/// Format-compatible with TypeScript `fileManagedIdentityStorage`: missing files read as an empty
/// store and parent directories are created on first write.
#[derive(Clone, Debug)]
pub struct FileIdentityStorage {
    path: PathBuf,
}

impl FileIdentityStorage {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read_map(&self) -> Result<BTreeMap<String, JsonValue>, IdentityError> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => {
                let parsed: BTreeMap<String, JsonValue> = serde_json::from_str(&raw)?;
                Ok(parsed)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(IdentityError::Io(e)),
        }
    }

    fn write_map(&self, data: &BTreeMap<String, JsonValue>) -> Result<(), IdentityError> {
        let serialized = serde_json::to_string_pretty(data)?;
        write_private_file(&self.path, serialized.as_bytes())
    }
}

#[async_trait]
impl IdentityStorage for FileIdentityStorage {
    async fn get(&self, key: &str) -> Result<Option<JsonValue>, IdentityError> {
        Ok(self.read_map()?.remove(key))
    }

    async fn set(&self, key: &str, value: JsonValue) -> Result<(), IdentityError> {
        let mut data = self.read_map()?;
        data.insert(key.to_owned(), value);
        self.write_map(&data)
    }

    async fn delete(&self, key: &str) -> Result<bool, IdentityError> {
        let mut data = self.read_map()?;
        let existed = data.remove(key).is_some();
        self.write_map(&data)?;
        Ok(existed)
    }

    async fn list(&self, prefix: Option<&str>) -> Result<Vec<String>, IdentityError> {
        let data = self.read_map()?;
        Ok(data
            .into_keys()
            .filter(|k| prefix.is_none_or(|p| k.starts_with(p)))
            .collect())
    }
}

// ── Pluggable Ed25519 key storage (in-memory + file) ─────────────────────────

/// Pluggable key store for persisting Ed25519 [`KeypairSigningIdentity`] slots.
#[async_trait]
pub trait KeyStore: Send + Sync {
    /// Load an existing identity for `slot`, or generate and persist a new one.
    async fn load_or_create(&self, slot: &str) -> Result<KeypairSigningIdentity, IdentityError>;
    /// Load an existing identity for `slot`, returning `None` if absent.
    async fn load(&self, slot: &str) -> Result<Option<KeypairSigningIdentity>, IdentityError>;
    /// Persist `identity` under `slot`.
    async fn save(
        &self,
        slot: &str,
        identity: &KeypairSigningIdentity,
    ) -> Result<(), IdentityError>;
    /// Delete the identity for `slot`, returning `true` if one existed.
    async fn delete(&self, slot: &str) -> Result<bool, IdentityError>;
}

/// In-memory [`KeyStore`] backed by a map of slot name → [`KeypairSigningIdentity`].
#[derive(Debug, Default)]
pub struct InMemoryKeyStore {
    keys: RwLock<BTreeMap<String, KeypairSigningIdentity>>,
}

impl InMemoryKeyStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl KeyStore for InMemoryKeyStore {
    async fn load_or_create(&self, slot: &str) -> Result<KeypairSigningIdentity, IdentityError> {
        let mut guard = self.keys.write().unwrap();
        if let Some(existing) = guard.get(slot) {
            return Ok(existing.clone());
        }
        let fresh = KeypairSigningIdentity::generate();
        guard.insert(slot.to_owned(), fresh.clone());
        Ok(fresh)
    }

    async fn load(&self, slot: &str) -> Result<Option<KeypairSigningIdentity>, IdentityError> {
        Ok(self.keys.read().unwrap().get(slot).cloned())
    }

    async fn save(
        &self,
        slot: &str,
        identity: &KeypairSigningIdentity,
    ) -> Result<(), IdentityError> {
        self.keys
            .write()
            .unwrap()
            .insert(slot.to_owned(), identity.clone());
        Ok(())
    }

    async fn delete(&self, slot: &str) -> Result<bool, IdentityError> {
        Ok(self.keys.write().unwrap().remove(slot).is_some())
    }
}

/// File-backed [`KeyStore`] compatible with TypeScript's `loadOrCreateIdentity`.
///
/// Each slot is stored as `<dir>/<first-16-bytes-of-sha256(slot)-hex>.json` with permissions
/// `0o600` on Unix. For an explicit file path (mirroring TS `createSelfManagedPrincipalFromFile`),
/// use [`FileKeyStore::load_or_create_file`] or [`FileKeyStore::load_file`].
///
/// Note: keys are stored unencrypted JSON, suitable for local development identities.
#[derive(Clone, Debug)]
pub struct FileKeyStore {
    dir: PathBuf,
}

impl FileKeyStore {
    /// Store slot files inside `dir` (created on first write).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Directory containing the identity JSON files.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Compute the deterministic file path for `slot` (same SHA-256 prefix scheme as TS).
    pub fn slot_path(&self, slot: &str) -> PathBuf {
        self.dir.join(format!("{}.json", slot_file_stem(slot)))
    }

    /// Load a keypair from an exact JSON file path, returning `None` if the file does not exist.
    pub fn load_file(
        path: impl AsRef<Path>,
    ) -> Result<Option<KeypairSigningIdentity>, IdentityError> {
        match std::fs::read_to_string(path.as_ref()) {
            Ok(raw) => {
                let parsed: SerializedKeypairSigningIdentity = serde_json::from_str(&raw)
                    .map_err(|e| IdentityError::MalformedIdentityFile(e.to_string()))?;
                Ok(Some(KeypairSigningIdentity::from_json(&parsed)?))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(IdentityError::Io(e)),
        }
    }

    /// Persist a keypair to an exact JSON file path (mode `0o600` on Unix).
    pub fn save_file(
        path: impl AsRef<Path>,
        identity: &KeypairSigningIdentity,
        id: Option<&str>,
    ) -> Result<(), IdentityError> {
        let mut json = identity.to_json();
        json.id = id.map(str::to_owned);
        let serialized = serde_json::to_string_pretty(&json)?;
        write_private_file(path.as_ref(), serialized.as_bytes())
    }

    /// Load an existing keypair from `path`, or generate and save one there on first call.
    pub fn load_or_create_file(
        path: impl AsRef<Path>,
    ) -> Result<KeypairSigningIdentity, IdentityError> {
        if let Some(existing) = Self::load_file(path.as_ref())? {
            return Ok(existing);
        }
        let fresh = KeypairSigningIdentity::generate();
        let label = format!("file:{}", path.as_ref().display());
        Self::save_file(path.as_ref(), &fresh, Some(&label))?;
        Ok(fresh)
    }

    /// Sibling `.caps.json` path convention used alongside an identity file (mirrors TS
    /// `createSelfManagedPrincipalFromFile`).
    pub fn sibling_caps_path(identity_file: impl AsRef<Path>) -> PathBuf {
        let path_str = identity_file.as_ref().to_string_lossy();
        if let Some(stem) = path_str.strip_suffix(".json") {
            PathBuf::from(format!("{stem}.caps.json"))
        } else {
            PathBuf::from(format!("{path_str}.caps.json"))
        }
    }
}

#[async_trait]
impl KeyStore for FileKeyStore {
    async fn load_or_create(&self, slot: &str) -> Result<KeypairSigningIdentity, IdentityError> {
        let path = self.slot_path(slot);
        if let Some(existing) = Self::load_file(&path)? {
            return Ok(existing);
        }
        let fresh = KeypairSigningIdentity::generate();
        Self::save_file(&path, &fresh, Some(slot))?;
        Ok(fresh)
    }

    async fn load(&self, slot: &str) -> Result<Option<KeypairSigningIdentity>, IdentityError> {
        Self::load_file(self.slot_path(slot))
    }

    async fn save(
        &self,
        slot: &str,
        identity: &KeypairSigningIdentity,
    ) -> Result<(), IdentityError> {
        Self::save_file(self.slot_path(slot), identity, Some(slot))
    }

    async fn delete(&self, slot: &str) -> Result<bool, IdentityError> {
        match std::fs::remove_file(self.slot_path(slot)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(IdentityError::Io(e)),
        }
    }
}

fn slot_file_stem(slot: &str) -> String {
    let digest = Sha256::digest(slot.as_bytes());
    let mut out = String::with_capacity(32);
    for b in &digest[..16] {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), IdentityError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents)?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)?;
    }
    Ok(())
}
