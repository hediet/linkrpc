//! `LinkRpcConnection`: method-name routing + a live interface registry on top of a [`Channel`].
//!
//! Layers the linkrpc `::` addressing grammar and an interface registry over a plain JSON-RPC
//! channel. Inbound requests/notifications are routed to the registered [`InterfaceHandler`] for
//! `(serviceId, interfaceId)`; outbound calls go straight to the channel. Registering any
//! interface also lets you opt into the three reflection interfaces via [`LinkRpcConnection::enable_reflection`].
//!
//! Mirrors TS `connection/linkRpcConnection.ts` (non-streaming subset for this milestone).

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, RwLock, Weak,
};

use async_trait::async_trait;
use serde_json::json;

use crate::connection::channel::{Channel, RequestHandler};
use crate::connection::dispatch::{CallCtx, InterfaceHandler, ServiceExport};
use crate::connection::interface_def::{InterfaceDefinition, Member};
use crate::connection::reflection::iface::{
    BareBindingListing, DefaultsGetResult, DefaultsListBindingsResult, DefaultsService,
    DefaultsServiceServer, DirectoryListResult, DirectoryService, DirectoryServiceServer,
    SchemasGetResult, SchemasService, SchemasServiceServer, ServiceListing,
};
use crate::connection::reflection::DEFAULTS_ID;
use crate::protocol::json_value::JsonValue;
use crate::protocol::jsonrpc::{error_codes, JsonRpcError};
use crate::protocol::method_name::{parse_method_name, ParsedMethodName};
use crate::transport::message::MessageTransport;

/// Errors from registration or invalid binding configuration.
#[derive(Debug, thiserror::Error)]
pub enum ConnError {
    #[error("interface \"{interface_id}\" already registered{}", .service.as_deref().map(|s| format!(" under service \"{s}\"")).unwrap_or_default())]
    AlreadyRegistered {
        interface_id: String,
        service: Option<String>,
    },
    #[error("register: bare prefix must contain only printable ASCII and must not contain \"::\"")]
    InvalidBarePrefix,
    #[error("register: bare prefix \"{0}\" is already bound")]
    BarePrefixAlreadyBound(String),
    #[error("register: invalid service id")]
    InvalidServiceId,
    #[error("bare interface clients do not support streaming methods")]
    BareStreamingUnsupported,
}

/// Options for [`LinkRpcConnection::register`].
#[derive(Debug, Clone, Default)]
pub struct RegisterOptions {
    /// Also route bare wire methods beginning with this prefix to the interface.
    ///
    /// `None` installs no bare route. An empty string installs the default route.
    pub bare_prefix: Option<String>,
    /// Mount the interface under this service id (form-3 addressing). Omit for the root service.
    pub service_id: Option<String>,
    /// Optional human description recorded for `service_id`, surfaced via the directory.
    pub service_description: Option<String>,
}

#[derive(Clone)]
struct RegisteredInterface {
    registration_id: u64,
    iface: Arc<InterfaceDefinition>,
    handler: Arc<dyn InterfaceHandler>,
    service_id: Option<String>,
    service_description: Option<String>,
}

impl RegisteredInterface {
    fn key(&self) -> String {
        registry_key(self.service_id.as_deref(), self.iface.id())
    }
}

#[derive(Clone)]
struct BareBinding {
    registration_id: u64,
    prefix: String,
    service_id: Option<String>,
    interface_id: String,
    hash: String,
}

#[derive(Default)]
struct RegistryState {
    entries: Vec<RegisteredInterface>,
    bare_bindings: Vec<BareBinding>,
}

#[derive(Default)]
struct RegistryInner {
    state: RwLock<RegistryState>,
    next_registration_id: AtomicU64,
}

fn registry_key(service_id: Option<&str>, interface_id: &str) -> String {
    format!("{}::{}", service_id.unwrap_or(""), interface_id)
}

impl RegistryInner {
    fn find(&self, service_id: Option<&str>, interface_id: &str) -> Option<RegisteredInterface> {
        let key = registry_key(service_id, interface_id);
        self.state
            .read()
            .unwrap()
            .entries
            .iter()
            .find(|e| e.key() == key)
            .cloned()
    }

    fn find_by_id(
        &self,
        interface_id: &str,
        hash: Option<&str>,
    ) -> Option<Arc<InterfaceDefinition>> {
        self.state.read().unwrap().entries.iter().find_map(|e| {
            if e.iface.id() != interface_id {
                return None;
            }

            if let Some(h) = hash {
                if e.iface.schema_hash() != h {
                    return None;
                }
            }
            Some(e.iface.clone())
        })
    }
}

/// A live interface registration. Disposing it removes its dispatch, reflection, and
/// bare-routing state.
#[derive(Debug)]
pub struct InterfaceRegistration {
    inner: Weak<RegistryInner>,
    registration_id: u64,
}

impl InterfaceRegistration {
    /// Dispose this registration. Returns whether it was still registered.
    pub fn dispose(&self) -> bool {
        self.unregister()
    }

    /// Remove this registration. Returns whether it was still registered.
    pub fn unregister(&self) -> bool {
        let Some(inner) = self.inner.upgrade() else {
            return false;
        };
        let mut state = inner.state.write().unwrap();
        let old_len = state.entries.len();
        state
            .entries
            .retain(|entry| entry.registration_id != self.registration_id);
        if state.entries.len() == old_len {
            return false;
        }
        state
            .bare_bindings
            .retain(|binding| binding.registration_id != self.registration_id);
        true
    }
}

/// A high-level linkrpc connection.
#[derive(Clone)]
pub struct LinkRpcConnection {
    channel: Channel,
    inner: Arc<RegistryInner>,
}

impl LinkRpcConnection {
    /// Build a connection over `transport`, binding the inbound dispatch handler.
    pub fn new(transport: Box<dyn MessageTransport>) -> Self {
        let inner = Arc::new(RegistryInner::default());
        let handler = InterfaceRouter {
            inner: inner.clone(),
        };
        let channel = Channel::new(transport, Box::new(handler));
        LinkRpcConnection { channel, inner }
    }

    /// The underlying JSON-RPC channel (raw access for callers that bypass the registry).
    pub fn channel(&self) -> &Channel {
        &self.channel
    }

    /// Drive the inbound read loop until the transport closes. Spawn on your executor.
    pub async fn run(&self) {
        self.channel.run().await;
    }

    /// The transport-independent router backed by this connection's live registry.
    pub fn router(&self) -> InterfaceRouter {
        InterfaceRouter {
            inner: self.inner.clone(),
        }
    }

    /// Register an interface's server-side handler.
    pub fn register(
        &self,
        iface: Arc<InterfaceDefinition>,
        handler: Arc<dyn InterfaceHandler>,
        opts: RegisterOptions,
    ) -> Result<InterfaceRegistration, ConnError> {
        self.router().register(iface, handler, opts)
    }

    /// Register a descriptor's address; see [`InterfaceRouter::register_binding`].
    pub fn register_binding(
        &self,
        iface: Arc<InterfaceDefinition>,
        handler: Arc<dyn InterfaceHandler>,
        address: crate::binding::BindingAddress,
    ) -> Result<InterfaceRegistration, ConnError> {
        self.router().register_binding(iface, handler, address)
    }
}

impl InterfaceRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode and deliver a recognized notification. Unknown methods return `false`.
    pub async fn dispatch_notification(
        &self,
        method: &str,
        params: JsonValue,
    ) -> Result<bool, JsonRpcError> {
        self.dispatch_notification_with_context(method, params, CallCtx::default())
            .await
    }

    pub async fn dispatch_notification_with_context(
        &self,
        method: &str,
        params: JsonValue,
        ctx: CallCtx,
    ) -> Result<bool, JsonRpcError> {
        let Ok(routed) = self.inner.route(method) else {
            return Ok(false);
        };
        if !matches!(
            routed.entry.iface.member(&routed.member),
            Some(Member::Notification(_))
        ) {
            return Ok(false);
        }
        routed
            .entry
            .handler
            .dispatch_notification(&routed.member, params, ctx)
            .await
    }

    /// Register an interface's server-side handler.
    pub fn register(
        &self,
        iface: Arc<InterfaceDefinition>,
        handler: Arc<dyn InterfaceHandler>,
        opts: RegisterOptions,
    ) -> Result<InterfaceRegistration, ConnError> {
        self.register_impl(iface, handler, opts)
    }

    /// Register a descriptor's address using the existing registry and dispatcher.
    ///
    /// Bare and default targets reuse `RegisterOptions::bare_prefix`, retaining
    /// the qualified root route and reflection metadata. Their client-side
    /// policies differ: bare clients do not support LinkRPC streaming.
    pub fn register_binding(
        &self,
        iface: Arc<InterfaceDefinition>,
        handler: Arc<dyn InterfaceHandler>,
        address: crate::binding::BindingAddress,
    ) -> Result<InterfaceRegistration, ConnError> {
        use crate::binding::BindingAddress;
        let options = match address {
            BindingAddress::Root => RegisterOptions::default(),
            BindingAddress::Service(service) => RegisterOptions {
                service_id: Some(service.to_string()),
                ..Default::default()
            },
            BindingAddress::Default => RegisterOptions {
                bare_prefix: Some(String::new()),
                ..Default::default()
            },
            BindingAddress::Bare(prefix) => RegisterOptions {
                bare_prefix: Some(prefix.to_string()),
                ..Default::default()
            },
        };
        self.register_impl(iface, handler, options)
    }

    fn register_impl(
        &self,
        iface: Arc<InterfaceDefinition>,
        handler: Arc<dyn InterfaceHandler>,
        mut opts: RegisterOptions,
    ) -> Result<InterfaceRegistration, ConnError> {
        if opts.service_id.as_deref() == Some("") {
            opts.service_id = None;
        }
        if opts
            .service_id
            .as_deref()
            .is_some_and(|id| !crate::schema::contract::valid_service_id(id))
        {
            return Err(ConnError::InvalidServiceId);
        }
        if let Some(prefix) = &opts.bare_prefix {
            validate_bare_prefix(prefix)?;
        }
        let registration_id = self
            .inner
            .next_registration_id
            .fetch_add(1, Ordering::Relaxed);
        let entry = RegisteredInterface {
            registration_id,
            iface,
            handler,
            service_id: opts.service_id.clone(),
            service_description: opts.service_description,
        };
        let key = entry.key();
        let mut state = self.inner.state.write().unwrap();
        if state.entries.iter().any(|e| e.key() == key) {
            return Err(ConnError::AlreadyRegistered {
                interface_id: entry.iface.id().to_string(),
                service: opts.service_id,
            });
        }
        if let Some(prefix) = &opts.bare_prefix {
            if state
                .bare_bindings
                .iter()
                .any(|binding| binding.prefix == *prefix)
            {
                return Err(ConnError::BarePrefixAlreadyBound(prefix.clone()));
            }
        }
        if let Some(prefix) = opts.bare_prefix {
            state.bare_bindings.push(BareBinding {
                registration_id,
                prefix,
                service_id: entry.service_id.clone(),
                interface_id: entry.iface.id().to_string(),
                hash: entry.iface.schema_hash().to_string(),
            });
        }
        state.entries.push(entry);
        Ok(InterfaceRegistration {
            inner: Arc::downgrade(&self.inner),
            registration_id,
        })
    }
}

impl LinkRpcConnection {
    /// Register a service from its handler alone, deriving the [`InterfaceDefinition`] via
    /// [`ServiceExport`]. Convenience over [`register`](Self::register) for macro-generated
    /// `…Server` adapters: no separate `interface()` argument needed.
    pub fn register_service<S>(
        &self,
        service: Arc<S>,
        opts: RegisterOptions,
    ) -> Result<InterfaceRegistration, ConnError>
    where
        S: ServiceExport + 'static,
    {
        self.register(Arc::new(S::interface()), service, opts)
    }

    /// Register the reflection interfaces (`defaults`, `directory`, `schemas`) backed by
    /// this connection's live registry. Idempotent.
    pub fn enable_reflection(&self) {
        if self.inner.find(None, DEFAULTS_ID).is_some() {
            return;
        }
        let reflection = Arc::new(Reflection {
            inner: self.inner.clone(),
        });
        // Unwrap is safe: idempotency guard above guarantees these keys are free.
        self.register_service(
            Arc::new(DefaultsServiceServer::new(reflection.clone())),
            RegisterOptions::default(),
        )
        .unwrap();
        self.register_service(
            Arc::new(DirectoryServiceServer::new(reflection.clone())),
            RegisterOptions::default(),
        )
        .unwrap();
        self.register_service(
            Arc::new(SchemasServiceServer::new(reflection)),
            RegisterOptions::default(),
        )
        .unwrap();
    }

    /// Snapshot of registered interfaces, in registration order.
    pub fn list_registered(&self) -> Vec<RegisteredListing> {
        self.inner
            .state
            .read()
            .unwrap()
            .entries
            .iter()
            .map(|e| RegisteredListing {
                service_id: e.service_id.clone().unwrap_or_default(),
                interface_id: e.iface.id().to_string(),
                interface_hash: e.iface.schema_hash().to_string(),
                service_description: e.service_description.clone(),
            })
            .collect()
    }

    // ---- client side ----

    /// Invoke a request method by raw wire name (e.g. `"com.acme.pizza::order"`).
    pub async fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, JsonRpcError> {
        self.channel.call(method, params).await
    }

    /// Invoke a request while retaining transport-vs-remote error origin.
    pub async fn call_detailed(
        &self,
        method: &str,
        params: JsonValue,
    ) -> Result<JsonValue, crate::client::RpcCallError> {
        self.channel.call_detailed(method, params).await
    }

    /// Start a streaming request while retaining local/remote/transport error origin.
    pub async fn call_stream_detailed(
        &self,
        method: &str,
        params: JsonValue,
    ) -> Result<crate::connection::streaming::RawStreamingCall, crate::client::RpcCallError> {
        self.channel.call_stream_detailed(method, params).await
    }

    /// Send a notification by raw wire name.
    pub async fn notify(&self, method: &str, params: JsonValue) -> Result<(), JsonRpcError> {
        self.channel.notify(method, params).await
    }

    /// Invoke a request member, building the wire method name from its address.
    pub async fn call_member(
        &self,
        service_id: Option<&str>,
        interface_id: &str,
        member: &str,
        params: JsonValue,
    ) -> Result<JsonValue, JsonRpcError> {
        self.call(&wire_method(service_id, interface_id, member), params)
            .await
    }

    /// Invoke a request member while retaining transport-vs-remote error origin.
    pub async fn call_member_detailed(
        &self,
        service_id: Option<&str>,
        interface_id: &str,
        member: &str,
        params: JsonValue,
    ) -> Result<JsonValue, crate::client::RpcCallError> {
        self.call_detailed(&wire_method(service_id, interface_id, member), params)
            .await
    }

    /// Send a notification member, building the wire method name from its address.
    pub async fn notify_member(
        &self,
        service_id: Option<&str>,
        interface_id: &str,
        member: &str,
        params: JsonValue,
    ) -> Result<(), JsonRpcError> {
        self.notify(&wire_method(service_id, interface_id, member), params)
            .await
    }
}

fn validate_bare_prefix(prefix: &str) -> Result<(), ConnError> {
    if !crate::schema::contract::valid_prefix(prefix) {
        return Err(ConnError::InvalidBarePrefix);
    }
    Ok(())
}

fn wire_method(service_id: Option<&str>, interface_id: &str, member: &str) -> String {
    match service_id {
        None | Some("") => format!("{interface_id}::{member}"),
        Some(sid) => format!("{sid}::{interface_id}::{member}"),
    }
}

/// A directory listing entry (see [`LinkRpcConnection::list_registered`]).
#[derive(Debug, Clone)]
pub struct RegisteredListing {
    pub service_id: String,
    pub interface_id: String,
    pub interface_hash: String,
    pub service_description: Option<String>,
}

// ── inbound dispatch ──────────────────────────────────────────────────────────

struct Routed {
    entry: RegisteredInterface,
    member: String,
}

impl RegistryInner {
    fn route(&self, method: &str) -> Result<Routed, JsonRpcError> {
        let Some(parsed) = parse_method_name(method) else {
            return Err(not_found("bad-method-grammar", method));
        };
        match parsed {
            ParsedMethodName::Bare { member } => {
                let state = self.state.read().unwrap();
                let selected = state
                    .bare_bindings
                    .iter()
                    .filter(|binding| member.starts_with(&binding.prefix))
                    .max_by_key(|binding| binding.prefix.len());
                let Some(binding) = selected else {
                    return Err(not_found("no-preset", method));
                };
                let Some(entry) = state
                    .entries
                    .iter()
                    .find(|entry| entry.registration_id == binding.registration_id)
                    .cloned()
                else {
                    return Err(not_found("no-preset", method));
                };
                Ok(Routed {
                    entry,
                    member: member[binding.prefix.len()..].to_string(),
                })
            }
            ParsedMethodName::Interface {
                interface_id,
                member,
            } => {
                let Some(entry) = self.find(None, &interface_id) else {
                    return Err(not_found("unknown-interface", method));
                };
                Ok(Routed { entry, member })
            }
            ParsedMethodName::Full {
                service_id,
                interface_id,
                member,
            } => {
                let Some(entry) = self.find(Some(&service_id), &interface_id) else {
                    return Err(not_found("unknown-service", method));
                };
                Ok(Routed { entry, member })
            }
        }
    }
}

/// Transport-independent dispatch over the same registry used by [`LinkRpcConnection`].
///
/// Register typed descriptors with `target.register(&router, adapter)`, use it as
/// an [`InterfaceHandler`] or [`RequestHandler`], or dispatch notifications with
/// validation and explicit unknown-member results.
#[derive(Clone, Default)]
pub struct InterfaceRouter {
    inner: Arc<RegistryInner>,
}

impl crate::binding::BindingRegistrar for InterfaceRouter {
    fn register_binding(
        &self,
        iface: Arc<InterfaceDefinition>,
        handler: Arc<dyn InterfaceHandler>,
        address: crate::binding::BindingAddress,
    ) -> Result<InterfaceRegistration, ConnError> {
        InterfaceRouter::register_binding(self, iface, handler, address)
    }
}

impl crate::binding::BindingRegistrar for LinkRpcConnection {
    fn register_binding(
        &self,
        iface: Arc<InterfaceDefinition>,
        handler: Arc<dyn InterfaceHandler>,
        address: crate::binding::BindingAddress,
    ) -> Result<InterfaceRegistration, ConnError> {
        LinkRpcConnection::register_binding(self, iface, handler, address)
    }
}

#[async_trait]
impl InterfaceHandler for InterfaceRouter {
    async fn handle_request(
        &self,
        member: &str,
        params: JsonValue,
        ctx: CallCtx,
    ) -> Result<JsonValue, JsonRpcError> {
        RequestHandler::handle_request_with_context(self, member.to_string(), params, ctx).await
    }

    async fn handle_notification(&self, member: &str, params: JsonValue, ctx: CallCtx) {
        RequestHandler::handle_notification_with_context(self, member.to_string(), params, ctx)
            .await;
    }

    async fn dispatch_notification(
        &self,
        member: &str,
        params: JsonValue,
        ctx: CallCtx,
    ) -> Result<bool, JsonRpcError> {
        self.dispatch_notification_with_context(member, params, ctx)
            .await
    }
}

#[async_trait]
impl RequestHandler for InterfaceRouter {
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
        let routed = self.inner.route(&method)?;
        match routed.entry.iface.member(&routed.member) {
            Some(Member::Request(request)) => {
                let components = routed.entry.iface.to_schema().components;
                let materialize = |schema: &JsonValue| match &components {
                    Some(components) => json!({
                        "allOf": [schema],
                        "components": components,
                    }),
                    None => schema.clone(),
                };
                ctx.configure_streams(
                    request.client_stream_schema.as_ref().map(materialize),
                    request.server_stream_schema.clone(),
                );
            }
            // Request semantics used on a notification-only method, or unknown member.
            Some(Member::Notification(_)) | None => {
                return Err(not_found("unknown-method", &method))
            }
        }
        routed
            .entry
            .handler
            .handle_request(&routed.member, params, ctx)
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
        let Ok(routed) = self.inner.route(&method) else {
            return;
        };
        if !matches!(
            routed.entry.iface.member(&routed.member),
            Some(Member::Notification(_))
        ) {
            return;
        }
        routed
            .entry
            .handler
            .handle_notification(&routed.member, params, ctx)
            .await;
    }
}

fn not_found(reason: &str, method: &str) -> JsonRpcError {
    JsonRpcError {
        code: error_codes::METHOD_NOT_FOUND,
        message: format!("method not found: {method}"),
        data: Some(json!({ "reason": reason, "method": method })),
    }
}

// ── reflection (backed by the live registry) ─────────────────────────────────

/// Registry-backed implementation of the three reflection interfaces. Served through the
/// macro-generated `*Server` adapters in [`LinkRpcConnection::enable_reflection`].
struct Reflection {
    inner: Arc<RegistryInner>,
}

#[async_trait]
impl DefaultsService for Reflection {
    async fn get(&self, _ctx: &CallCtx) -> Result<DefaultsGetResult, JsonRpcError> {
        let binding = self
            .inner
            .state
            .read()
            .unwrap()
            .bare_bindings
            .iter()
            .find(|binding| binding.prefix.is_empty())
            .cloned();
        Ok(match binding {
            Some(binding) => DefaultsGetResult {
                service_id: binding.service_id,
                interface_id: Some(binding.interface_id),
                interface_hash: Some(binding.hash),
            },
            None => DefaultsGetResult {
                service_id: None,
                interface_id: None,
                interface_hash: None,
            },
        })
    }

    #[allow(non_snake_case)]
    async fn listBindings(
        &self,
        _ctx: &CallCtx,
    ) -> Result<DefaultsListBindingsResult, JsonRpcError> {
        let mut bindings: Vec<BareBindingListing> = self
            .inner
            .state
            .read()
            .unwrap()
            .bare_bindings
            .iter()
            .map(|binding| BareBindingListing {
                prefix: binding.prefix.clone(),
                service_id: binding.service_id.clone(),
                interface_id: binding.interface_id.clone(),
                interface_hash: binding.hash.clone(),
            })
            .collect();
        bindings.sort_by(|a, b| a.prefix.cmp(&b.prefix));
        Ok(DefaultsListBindingsResult { bindings })
    }
}

#[async_trait]
impl DirectoryService for Reflection {
    async fn list(
        &self,
        _ctx: &CallCtx,
        interface_id: Option<String>,
        service_id: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
        _timeout_ms: Option<u32>,
    ) -> Result<DirectoryListResult, JsonRpcError> {
        let filter_iface = interface_id.as_deref();
        let filter_service = service_id.as_deref();
        let cursor = cursor
            .as_deref()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        let limit = limit.map(|n| n as usize);

        let all: Vec<ServiceListing> = self
            .inner
            .state
            .read()
            .unwrap()
            .entries
            .iter()
            .filter(|e| filter_iface.is_none_or(|f| e.iface.id() == f))
            .filter(|e| filter_service.is_none_or(|f| e.service_id.as_deref().unwrap_or("") == f))
            .map(|e| ServiceListing {
                service_id: e.service_id.clone().unwrap_or_default(),
                interface_id: e.iface.id().to_string(),
                interface_hash: e.iface.schema_hash().to_string(),
                service_description: e.service_description.clone(),
            })
            .collect();

        let start = cursor.min(all.len());
        let end = match limit {
            Some(l) => (start + l).min(all.len()),
            None => all.len(),
        };
        let items = all[start..end].to_vec();
        let next_cursor = (end < all.len()).then(|| end.to_string());
        Ok(DirectoryListResult {
            items,
            next_cursor,
            truncated: None,
        })
    }
}

#[async_trait]
impl SchemasService for Reflection {
    async fn get(
        &self,
        _ctx: &CallCtx,
        interface_id: String,
        hash: Option<String>,
    ) -> Result<SchemasGetResult, JsonRpcError> {
        match self.inner.find_by_id(&interface_id, hash.as_deref()) {
            Some(iface) => {
                let schema = serde_json::to_value(iface.to_schema()).expect("schema serializes");
                Ok(SchemasGetResult { schema })
            }
            None => Err(JsonRpcError {
                code: error_codes::METHOD_NOT_FOUND,
                message: "Interface not found".to_string(),
                data: Some(json!({
                    "reason": "unknown-interface",
                    "interfaceId": interface_id,
                    "hash": hash,
                })),
            }),
        }
    }
}
