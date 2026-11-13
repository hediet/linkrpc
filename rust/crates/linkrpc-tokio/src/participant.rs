//! `host_participant`: serve an application's services as a LinkRPC participant on the endpoint
//! selected by [`EndpointOptions`] (or `LINKRPC_ENDPOINT`), claiming the hub-granted service ID
//! namespace when the peer offers one. The Rust counterpart of the TS `hostParticipant`
//! (`linkrpc-hub/src/participantHost.ts`).
//!
//! Per peer: query `hubGrantedServiceId::get` (method-not-found or an empty namespace means no
//! grant), claim the granted namespace (or the requested descendant) with
//! `hubGrantedServiceId::register`, then run `setup`. [`RegistrationMode`] selects where
//! [`ParticipantServices::register`] mounts each implementation.

use std::future::Future;
use std::sync::Arc;

use linkrpc::prelude::{
    error_codes, ConnError, InterfaceDefinition, InterfaceHandler, InterfaceRegistration,
    JsonRpcError, LinkRpcConnection, RegisterOptions, ServiceExport,
};
use serde_json::{json, Value};

use crate::connect::ConnectError;
use crate::endpoint::{
    start_endpoint, BoxError, EndpointConnection, EndpointOptions, StartedEndpoint,
};

const GRANTED_SERVICE_ID_GET: &str = "hubGrantedServiceId::get";
const GRANTED_SERVICE_ID_REGISTER: &str = "hubGrantedServiceId::register";

/// Where [`ParticipantServices::register`] mounts implementations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistrationMode {
    /// Under the claimed service ID (when granted) and at the connection root.
    All,
    /// Only at the connection root; no namespace is queried or claimed.
    Root,
    /// Only under the claimed service ID; fails if the peer grants no namespace.
    GrantedServiceId,
}

/// Options for [`host_participant`].
#[derive(Debug, Clone)]
pub struct ParticipantOptions {
    /// The endpoint to serve on; defaults to the environment.
    pub endpoint: EndpointOptions,
    /// Where services are registered.
    pub registration_mode: RegistrationMode,
    /// Claim this descendant of the granted namespace instead of the namespace itself. Requires
    /// [`RegistrationMode::All`] or [`RegistrationMode::GrantedServiceId`].
    pub service_id: Option<String>,
}

impl ParticipantOptions {
    /// Serve on the environment's endpoint with `registration_mode`.
    pub fn new(registration_mode: RegistrationMode) -> Self {
        ParticipantOptions {
            endpoint: EndpointOptions::default(),
            registration_mode,
            service_id: None,
        }
    }
}

/// What `setup` receives for each peer.
pub struct ParticipantContext {
    /// The peer connection; await [`EndpointConnection::closed`] to observe disconnects.
    pub peer: EndpointConnection,
    /// Registers implementations at the addresses selected by the registration mode.
    pub services: ParticipantServices,
    /// The claimed namespace, or `None` for root-only registration.
    pub service_id: Option<String>,
}

impl ParticipantContext {
    /// The RPC connection to the peer.
    pub fn connection(&self) -> &LinkRpcConnection {
        self.peer.connection()
    }
}

/// Serve `setup`'s services on every peer of the selected endpoint.
///
/// `setup` runs once per peer after the namespace claim; its `Ok` value is kept until that peer
/// disconnects, so return a guard for per-connection resources. If the peer disconnects or the
/// endpoint closes during setup, the setup future is dropped. Namespace query or claim errors
/// other than method-not-found fail the peer instead of falling back to root registration.
pub async fn host_participant<F, Fut, G>(
    options: ParticipantOptions,
    setup: F,
) -> Result<StartedEndpoint, ConnectError>
where
    F: Fn(ParticipantContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<G, BoxError>> + Send + 'static,
    G: Send + 'static,
{
    let ParticipantOptions {
        endpoint,
        registration_mode: mode,
        service_id: requested,
    } = options;
    if mode == RegistrationMode::Root && requested.is_some() {
        return Err(ConnectError::Invalid(
            "serviceId requires all or grantedServiceId registration mode.".to_owned(),
        ));
    }
    let setup = Arc::new(setup);
    start_endpoint(endpoint, move |peer| {
        let (setup, requested) = (setup.clone(), requested.clone());
        async move {
            // A participant grants no namespaces; let a peer probing this side get
            // method-not-found while both sides are still bootstrapping.
            peer.resume_requests([GRANTED_SERVICE_ID_GET]);
            let service_id = claim_namespace(peer.connection(), mode, requested).await?;
            let services =
                ParticipantServices::new(peer.connection().clone(), mode, service_id.clone());
            setup(ParticipantContext {
                peer,
                services,
                service_id,
            })
            .await
        }
    })
    .await
}

async fn claim_namespace(
    connection: &LinkRpcConnection,
    mode: RegistrationMode,
    requested: Option<String>,
) -> Result<Option<String>, BoxError> {
    if mode == RegistrationMode::Root {
        return Ok(None);
    }
    let grant = match connection.call(GRANTED_SERVICE_ID_GET, json!({})).await {
        Ok(result) => match result.get("grantedServiceIdNamespace") {
            Some(Value::String(namespace)) => Some(namespace.clone()).filter(|ns| !ns.is_empty()),
            _ => {
                return Err(format!("{GRANTED_SERVICE_ID_GET} returned a malformed result").into())
            }
        },
        Err(error) if error.code == error_codes::METHOD_NOT_FOUND => None,
        Err(error) => return Err(rpc_error(error)),
    };
    let Some(grant) = grant else {
        if mode == RegistrationMode::GrantedServiceId || requested.is_some() {
            return Err("Peer did not grant a service ID namespace".into());
        }
        return Ok(None);
    };
    let service_id = requested.unwrap_or_else(|| grant.clone());
    if service_id != grant && !service_id.starts_with(&format!("{grant}/")) {
        return Err(format!(
            "Requested serviceId \"{service_id}\" is outside the hub-granted namespace \"{grant}\""
        )
        .into());
    }
    connection
        .call(
            GRANTED_SERVICE_ID_REGISTER,
            json!({ "serviceId": service_id }),
        )
        .await
        .map_err(rpc_error)?;
    Ok(Some(service_id))
}

fn rpc_error(error: JsonRpcError) -> BoxError {
    format!("{} (code {})", error.message, error.code).into()
}

/// Registers each implementation at the addresses selected by the registration mode.
#[derive(Clone)]
pub struct ParticipantServices {
    connection: LinkRpcConnection,
    mode: RegistrationMode,
    service_id: Option<String>,
}

/// Errors from [`ParticipantServices::register`].
#[derive(Debug, thiserror::Error)]
pub enum RegisterError {
    /// The connection rejected a registration.
    #[error(transparent)]
    Connection(#[from] ConnError),
    /// A service description needs a claimed service ID to attach to.
    #[error("Service metadata requires a granted service ID")]
    MetadataRequiresServiceId,
    /// The host chooses the service ID; [`RegisterOptions::service_id`] must be unset.
    #[error(
        "the participant host selects the service ID; leave RegisterOptions::service_id unset"
    )]
    ServiceIdSelectedByHost,
}

impl ParticipantServices {
    fn new(
        connection: LinkRpcConnection,
        mode: RegistrationMode,
        service_id: Option<String>,
    ) -> Self {
        ParticipantServices {
            connection,
            mode,
            service_id,
        }
    }

    /// The claimed namespace, if any.
    pub fn service_id(&self) -> Option<&str> {
        self.service_id.as_deref()
    }

    /// Register `handler` for `iface` under the claimed service ID (with `options`) and, unless the
    /// mode is [`RegistrationMode::GrantedServiceId`], at the connection root. Either both
    /// registrations succeed or neither remains.
    pub fn register(
        &self,
        iface: Arc<InterfaceDefinition>,
        handler: Arc<dyn InterfaceHandler>,
        options: RegisterOptions,
    ) -> Result<ParticipantRegistration, RegisterError> {
        if options.service_id.is_some() {
            return Err(RegisterError::ServiceIdSelectedByHost);
        }
        let mut registrations = Vec::new();
        if let Some(service_id) = &self.service_id {
            registrations.push(self.connection.register(
                iface.clone(),
                handler.clone(),
                RegisterOptions {
                    service_id: Some(service_id.clone()),
                    ..options
                },
            )?);
        } else if options.service_description.is_some() {
            return Err(RegisterError::MetadataRequiresServiceId);
        }
        if self.mode != RegistrationMode::GrantedServiceId {
            match self
                .connection
                .register(iface, handler, RegisterOptions::default())
            {
                Ok(registration) => registrations.push(registration),
                Err(error) => {
                    for registration in &registrations {
                        registration.dispose();
                    }
                    return Err(error.into());
                }
            }
        }
        Ok(ParticipantRegistration { registrations })
    }

    /// Register a macro-generated service adapter; see [`register`](Self::register).
    pub fn register_service<S>(
        &self,
        service: Arc<S>,
        options: RegisterOptions,
    ) -> Result<ParticipantRegistration, RegisterError>
    where
        S: ServiceExport + 'static,
    {
        self.register(Arc::new(S::interface()), service, options)
    }
}

/// The registrations [`ParticipantServices::register`] made for one implementation.
#[derive(Debug)]
pub struct ParticipantRegistration {
    registrations: Vec<InterfaceRegistration>,
}

impl ParticipantRegistration {
    /// Remove every address of this implementation. Idempotent.
    pub fn dispose(&self) {
        for registration in &self.registrations {
            registration.dispose();
        }
    }
}
