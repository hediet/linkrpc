//! Immutable typed descriptors compose an interface contract with an address.

use std::{marker::PhantomData, sync::Arc};

pub use crate::connection::hub_connection::InterfaceRouter;

use crate::{
    client::RpcCall,
    prelude::{ConnError, InterfaceDefinition, InterfaceRegistration, ServiceExport},
    schema::{contract::InterfaceRef, LinkRpcInterfaceSchema},
};

/// A static address. A bare prefix is concatenated verbatim with member names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingAddress {
    Root,
    Service(&'static str),
    /// Empty-prefix dispatch with a reflected root interface.
    Default,
    /// Foreign-protocol calls with an exact raw prefix and no streaming.
    /// Provider registration retains the qualified route and reflection.
    Bare(&'static str),
}

/// Implemented by macro-generated client types as an interface type witness.
pub trait InterfaceContract {
    type Client<C: RpcCall>;
    fn interface() -> InterfaceDefinition;
    fn client<C: RpcCall>(caller: C, prefix: String) -> Self::Client<C>;
    fn has_streams() -> bool {
        Self::interface().members().iter().any(|(_, member)| matches!(
            member,
            crate::connection::interface_def::Member::Request(request)
                if request.client_stream_schema.is_some() || request.server_stream_schema.is_some()
        ))
    }
}

/// Implemented by generated adapters for the matching interface only.
pub trait InterfaceProvider<I: InterfaceContract>: ServiceExport {}

/// A registry accepting interface/address pairs independently of its transport.
pub trait BindingRegistrar {
    fn register_binding(
        &self,
        interface: Arc<InterfaceDefinition>,
        handler: Arc<dyn crate::connection::dispatch::InterfaceHandler>,
        address: BindingAddress,
    ) -> Result<InterfaceRegistration, ConnError>;
}

/// Type-erased, read-only metadata for catalogues of heterogeneous bindings.
///
/// Produced from a typed target, never from a parallel prefix or schema table.
#[derive(Debug, Clone)]
pub struct InterfaceBindingDescriptor {
    schema: LinkRpcInterfaceSchema,
    address: BindingAddress,
    prefix: String,
}

impl InterfaceBindingDescriptor {
    pub fn schema(&self) -> &LinkRpcInterfaceSchema {
        &self.schema
    }

    pub fn address(&self) -> BindingAddress {
        self.address
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }
}

/// An immutable typed interface/address pair. No transport or handler is stored.
pub struct InterfaceBinding<I> {
    address: BindingAddress,
    interface: PhantomData<fn() -> I>,
}

impl<I> Copy for InterfaceBinding<I> {}
impl<I> Clone for InterfaceBinding<I> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<I> std::fmt::Debug for InterfaceBinding<I> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InterfaceBinding")
            .field("address", &self.address)
            .finish()
    }
}

impl<I> InterfaceBinding<I> {
    pub const fn new(address: BindingAddress) -> Self {
        Self {
            address,
            interface: PhantomData,
        }
    }
    pub const fn address(&self) -> BindingAddress {
        self.address
    }
}

impl<I: InterfaceContract> InterfaceBinding<I> {
    pub fn descriptor(&self) -> InterfaceBindingDescriptor {
        InterfaceBindingDescriptor {
            schema: I::interface().to_schema(),
            address: self.address,
            prefix: self.prefix(),
        }
    }

    pub fn interface(&self) -> InterfaceDefinition {
        I::interface()
    }
    pub fn reference(&self) -> InterfaceRef {
        InterfaceRef::from(&I::interface().to_schema())
    }
    pub fn prefix(&self) -> String {
        match self.address {
            BindingAddress::Root | BindingAddress::Service("") => {
                format!("{}::", I::interface().id())
            }
            BindingAddress::Service(service) => format!("{service}::{}::", I::interface().id()),
            BindingAddress::Default => String::new(),
            BindingAddress::Bare(prefix) => prefix.to_string(),
        }
    }
    /// Construct a client. Panics for a streaming interface bound to a bare wire;
    /// use [`Self::try_client`] to handle invalid bindings without panicking.
    pub fn client<C: RpcCall>(&self, caller: C) -> I::Client<C> {
        self.try_client(caller)
            .unwrap_or_else(|error| panic!("{error}"))
    }

    /// Construct a client, rejecting invalid foreign-protocol streaming bindings.
    pub fn try_client<C: RpcCall>(&self, caller: C) -> Result<I::Client<C>, ConnError> {
        if let BindingAddress::Bare(prefix) = self.address {
            if !crate::schema::contract::valid_prefix(prefix) {
                return Err(ConnError::InvalidBarePrefix);
            }
            if I::has_streams() {
                return Err(ConnError::BareStreamingUnsupported);
            }
        }
        Ok(I::client(caller, self.prefix()))
    }
    pub fn register<S>(
        &self,
        connection: &impl BindingRegistrar,
        service: Arc<S>,
    ) -> Result<InterfaceRegistration, ConnError>
    where
        S: InterfaceProvider<I> + 'static,
    {
        connection.register_binding(Arc::new(I::interface()), service, self.address)
    }
}
