//! linkrpc — a Rust port of the `@hediet/linkrpc` JSON-RPC dialect.
//!
//! Includes the wire core (JSON-RPC 2.0, `::` method-name grammar, RFC 8785 JCS), content-hashed
//! interface schemas (`id@hash`), typed `#[link_rpc_interface]` macros, streaming, reflection,
//! endpoint URI parsing, and optional Ed25519 identity / signed envelopes / hub capability grants
//! (see [`identity`]).

// Lets the `#[link_rpc_interface]` macro's absolute `::linkrpc::…` paths resolve when the macro is
// used *within* this crate (e.g. the built-in reflection interfaces).
extern crate self as linkrpc;

pub mod application_error;
pub mod binding;
pub mod client;
pub mod connection;
pub mod identity;
pub mod protocol;
pub mod schema;
pub mod transport;

pub use application_error::{
    ApplicationError, ApplicationErrorDecodeError, CallError, ClientApplicationError,
    ValidationIssue, DEFAULT_APPLICATION_ERROR_CODE,
};
pub mod prelude {
    pub use crate::application_error::{
        scope_error_contract, validate_json_schema, validate_json_schema_issues, ApplicationError,
        ApplicationErrorDecodeError, CallError, ClientApplicationError, ValidationIssue,
        DEFAULT_APPLICATION_ERROR_CODE,
    };
    pub use crate::binding::{
        BindingAddress, BindingRegistrar, InterfaceBinding, InterfaceBindingDescriptor,
        InterfaceContract, InterfaceProvider, InterfaceRouter,
    };
    pub use crate::client::{RpcCall, RpcCallError};
    pub use crate::connection::channel::{Channel, RequestHandler};
    pub use crate::connection::dispatch::{CallCtx, InterfaceHandler, ServiceExport};
    pub use crate::connection::endpoint::{
        format_endpoint_uri, is_hub_endpoint, parse_endpoint_uri, EndpointCommand, EndpointError,
        FormatEndpointOptions, ResolvedEndpoint,
    };
    pub use crate::connection::hub_connection::{
        ConnError, InterfaceRegistration, LinkRpcConnection, RegisterOptions, RegisteredListing,
    };
    pub use crate::connection::interface_def::{
        InterfaceDefinition, InterfaceInfo, Member, MemberDocs, NotificationMember, RequestMember,
    };
    pub use crate::connection::reflection::{
        defaults_interface, directory_interface, schemas_interface,
    };
    pub use crate::connection::streaming::{
        CallControl, CallResult, NoStream, RawStreamingCall, StreamReceiver, StreamSender,
        StreamingCall, TypedCallResult, TypedStreamingCall,
    };
    pub use crate::identity::{
        attach_capabilities, capability_fresh_at, capability_permits, create_managed_principal,
        current_time_ms, issue_capability, match_params, permission_matches_target,
        permission_permits, permits, resolve_signing_key, sign_capability, sign_object,
        sign_rpc_call, summarize_grants, verify_ed25519, verify_object, verify_object_by_principal,
        verify_rpc_call, Ability, AcceptedRootIssuer, Call, CallBind, CallIntent, CallTarget,
        CapBag, CapProvider, CapProviderRequest, CapProviderResult, Capability,
        FileIdentityStorage, FileKeyStore, GrantPermissionSummary, GrantSummary, GrantsSummary,
        HubAccessConsumer, HubAccessDuration, HubAccessPermission, HubAccessRequest,
        HubAccessResult, IdentityError, IdentityStorage, InMemoryIdentityStorage, InMemoryKeyStore,
        IssueCapabilityOptions, KeyStore, KeypairSigningIdentity, ManagedIdentity,
        ManagedIdentityStorageClient, ManagedSigningOptions, OneShotCapStaging, ParamMatcher,
        Pattern, Permission, PermitResult, Principal, PublicSigningIdentity,
        SerializedKeypairSigningIdentity, SignRpcCallOptions, SignedCapability, SignedRpcCall,
        SigningCallCtx, SigningClient, SigningConfig, SigningIdentity, TargetPattern,
        VerifiedCallIdentity, VerifiedSignatureTransport, VerifyRpcCallError, VerifyRpcCallOptions,
        VerifyRpcCallResult, VerifyingRequestHandler,
    };
    pub use crate::protocol::signed_object::{
        base64url_decode, base64url_encode, get_key_id, read_signature, require_object_params,
        signed_hash, signing_domain_value, signing_input, strip_linkrpc_wire_meta, with_signature,
        CallMeta, KeyId, LinkRpcUnsigned, PrincipalId, SignatureEnvelope, Signatures,
        HUBRPC_META_KEY, HUBRPC_SIGNATURE_KEY, HUBRPC_UNSIGNED_KEY, KEY_ID_PREFIX,
        PRINCIPAL_PREFIX,
    };
    pub use crate::schema::contract::{
        BareInterfaceContract, ContractError, InterfaceAddress, InterfaceRef, LinkRpcContract,
        ServiceContract,
    };
    pub use async_trait::async_trait;
    // Typed clients (+ their result types) for the built-in reflection interfaces, so consumers
    // can introspect an endpoint without hand-rolling `call_member` calls.
    pub use crate::connection::reflection::iface::{
        BareBindingListing, DefaultsGetResult, DefaultsListBindingsResult, DefaultsServiceClient,
        DirectoryListParams, DirectoryListResult, DirectoryServiceClient, DirectoryWatchParams,
        EmptyObject, RootPrincipalReq, SchemasGetResult, SchemasServiceClient, ServiceIdPattern,
        ServiceListing,
    };
    pub use crate::protocol::json_value::JsonValue;
    pub use crate::protocol::jsonrpc::{
        error_codes, JsonRpcError, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest,
        JsonRpcResponse, RequestId,
    };
    pub use crate::protocol::method_name::{
        format_method_name, parse_method_name, ParsedMethodName,
    };
    pub use crate::schema::{
        compute_interface_hash, compute_interface_hash_value, generate_rust_components,
        generate_rust_contract, generate_rust_interface, normalize_json_schema, Components,
        ErrorSchema, GenerateRustBinding, GenerateRustOptions, GeneratedRust,
        GeneratedRustComponents, GeneratedRustContract, InterfaceSchemaError,
        LinkRpcInterfaceSchema, MemberAnnotations, MethodMap, MethodSchema,
    };
    pub use crate::transport::memory::transport_pair;
    pub use crate::transport::message::{MessageTransport, TransportError};
    pub use crate::transport::multiplexed::{
        MultiplexedTransport, MuxChannel, MuxCodec, MuxEnvelope, MuxEnvelopeCodec, MuxError,
        RouteOutcome,
    };

    /// Derive a linkrpc interface (trait + server adapter + client + `interface()`) from a bare
    /// trait spec. See `docs/examples.md`.
    pub use linkrpc_macros::{link_rpc_interface, ApplicationError};
}

pub use linkrpc_macros::ApplicationError;
