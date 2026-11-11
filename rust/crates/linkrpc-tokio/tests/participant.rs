//! `host_participant`: registration modes, granted-namespace claims against a fake hub peer, and
//! error propagation.

use std::sync::{Arc, Mutex};

use linkrpc::prelude::*;
use linkrpc_tokio::{
    host_participant, start_endpoint, BoxError, ConnectError, EndpointConnection, EndpointOptions,
    ParticipantOptions, RegistrationMode, StartedEndpoint,
};
use serde_json::json;
use tokio::sync::mpsc;

#[link_rpc_interface(id = "participant.echo")]
pub trait Echo {
    async fn ping(value: String) -> Result<String, JsonRpcError>;
}

struct Echoer;

#[async_trait]
impl Echo for Echoer {
    async fn ping(&self, _ctx: &CallCtx, value: String) -> Result<String, JsonRpcError> {
        Ok(value)
    }
}

const TOKEN: &str = "secret";

/// How the fake hub answers `hubGrantedServiceId::*`.
#[derive(Clone)]
enum Grant {
    /// Not served: method-not-found.
    Missing,
    /// `get` returns this namespace; `register` succeeds and is recorded.
    Namespace(&'static str),
    /// `register` fails with this message.
    ClaimDenied(&'static str),
}

struct GrantedServiceId {
    grant: Grant,
    claims: Arc<Mutex<Vec<JsonValue>>>,
}

#[async_trait]
impl InterfaceHandler for GrantedServiceId {
    async fn handle_request(
        &self,
        member: &str,
        params: JsonValue,
        _ctx: CallCtx,
    ) -> Result<JsonValue, JsonRpcError> {
        let namespace = match &self.grant {
            Grant::Namespace(namespace) => namespace,
            Grant::ClaimDenied(_) => "test",
            Grant::Missing => unreachable!(),
        };
        match (member, &self.grant) {
            ("get", _) => Ok(json!({ "grantedServiceIdNamespace": namespace })),
            ("register", Grant::ClaimDenied(message)) => Err(JsonRpcError::new(-32001, *message)),
            ("register", _) => {
                self.claims.lock().unwrap().push(params);
                Ok(json!({}))
            }
            _ => Err(JsonRpcError::new(error_codes::METHOD_NOT_FOUND, member)),
        }
    }
}

fn granted_service_id_interface() -> InterfaceDefinition {
    let member = || {
        Member::Request(Box::new(RequestMember {
            params_schema: json!({ "type": "object" }),
            result_schema: json!({ "type": "object" }),
            client_stream_schema: None,
            server_stream_schema: None,
            errors: None,
            error_components: None,
            docs: MemberDocs::default(),
        }))
    };
    InterfaceDefinition::new(
        InterfaceInfo::new("hubGrantedServiceId"),
        vec![("get".into(), member()), ("register".into(), member())],
    )
}

struct FakeHub {
    endpoint: StartedEndpoint,
    peers: mpsc::UnboundedReceiver<EndpointConnection>,
    claims: Arc<Mutex<Vec<JsonValue>>>,
}

async fn fake_hub(grant: Grant) -> FakeHub {
    let claims = Arc::new(Mutex::new(Vec::new()));
    let (sender, peers) = mpsc::unbounded_channel();
    let recorded = claims.clone();
    let endpoint = start_endpoint(
        EndpointOptions {
            endpoint: Some("listen:ws://127.0.0.1:0".into()),
            token: Some(TOKEN.into()),
            on_error: Some(Arc::new(|_| {})),
        },
        move |peer| {
            if !matches!(grant, Grant::Missing) {
                let handler = GrantedServiceId {
                    grant: grant.clone(),
                    claims: recorded.clone(),
                };
                peer.connection()
                    .register(
                        Arc::new(granted_service_id_interface()),
                        Arc::new(handler),
                        RegisterOptions::default(),
                    )
                    .unwrap();
            }
            sender.send(peer).unwrap();
            async { Ok::<_, BoxError>(()) }
        },
    )
    .await
    .unwrap();
    FakeHub {
        endpoint,
        peers,
        claims,
    }
}

fn participant(
    hub: &FakeHub,
    mode: RegistrationMode,
    service_id: Option<&str>,
) -> ParticipantOptions {
    ParticipantOptions {
        endpoint: EndpointOptions {
            endpoint: Some(hub.endpoint.endpoint().to_owned()),
            token: Some(TOKEN.into()),
            on_error: None,
        },
        registration_mode: mode,
        service_id: service_id.map(str::to_owned),
    }
}

async fn host_echo(
    options: ParticipantOptions,
) -> Result<(StartedEndpoint, Option<String>), ConnectError> {
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let host = host_participant(options, move |context| {
        let sender = sender.clone();
        async move {
            let registration = context.services.register_service(
                Arc::new(EchoServer::new(Arc::new(Echoer))),
                RegisterOptions::default(),
            )?;
            sender.send(context.service_id.clone()).unwrap();
            Ok::<_, BoxError>(registration)
        }
    })
    .await?;
    Ok((host, receiver.recv().await.unwrap()))
}

async fn ping(peer: &EndpointConnection, service_id: Option<&str>) -> Result<JsonValue, i64> {
    peer.connection()
        .call_member(service_id, echo::ID, "ping", json!({ "value": "hi" }))
        .await
        .map_err(|error| error.code)
}

#[tokio::test]
async fn registers_exactly_the_addresses_selected_by_the_mode() {
    use RegistrationMode::*;
    for mode in [All, Root, GrantedServiceId] {
        let mut hub = fake_hub(Grant::Namespace("test/service")).await;
        let (_host, service_id) = host_echo(participant(&hub, mode, None)).await.unwrap();
        let peer = hub.peers.recv().await.unwrap();
        let root = ping(&peer, None).await;
        let named = ping(&peer, Some("test/service")).await;
        let hi = Ok(json!("hi"));
        let missing = Err(error_codes::METHOD_NOT_FOUND);
        let expected = match mode {
            All => (Some("test/service"), hi.clone(), hi.clone(), 1),
            Root => (None, hi.clone(), missing.clone(), 0),
            GrantedServiceId => (Some("test/service"), missing.clone(), hi.clone(), 1),
        };
        assert_eq!(
            (
                service_id.as_deref(),
                root,
                named,
                hub.claims.lock().unwrap().len()
            ),
            expected,
            "{mode:?}"
        );
    }
}

#[tokio::test]
async fn claims_a_requested_descendant_and_rejects_others() {
    let hub = fake_hub(Grant::Namespace("test")).await;
    let (_host, service_id) =
        host_echo(participant(&hub, RegistrationMode::All, Some("test/child")))
            .await
            .unwrap();
    assert_eq!(service_id.as_deref(), Some("test/child"));
    assert_eq!(
        hub.claims.lock().unwrap().as_slice(),
        [json!({ "serviceId": "test/child" })]
    );

    let outside = host_echo(participant(&hub, RegistrationMode::All, Some("other")))
        .await
        .unwrap_err();
    assert_eq!(
        outside.to_string(),
        "Requested serviceId \"other\" is outside the hub-granted namespace \"test\""
    );
}

#[tokio::test]
async fn handles_a_missing_grant_according_to_the_mode() {
    let mut hub = fake_hub(Grant::Missing).await;
    let (_host, service_id) = host_echo(participant(&hub, RegistrationMode::All, None))
        .await
        .unwrap();
    assert_eq!(service_id, None);
    let peer = hub.peers.recv().await.unwrap();
    assert_eq!(ping(&peer, None).await, Ok(json!("hi")));

    let error = host_echo(participant(&hub, RegistrationMode::GrantedServiceId, None))
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Peer did not grant a service ID namespace"
    );
}

#[tokio::test]
async fn propagates_claim_errors_instead_of_falling_back_to_root() {
    let hub = fake_hub(Grant::ClaimDenied("claim denied")).await;
    let error = host_echo(participant(&hub, RegistrationMode::All, None))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "claim denied (code -32001)");
}

#[tokio::test]
async fn rejects_a_service_id_in_root_mode() {
    let hub = fake_hub(Grant::Missing).await;
    let error = host_echo(participant(&hub, RegistrationMode::Root, Some("x")))
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "serviceId requires all or grantedServiceId registration mode."
    );
}
