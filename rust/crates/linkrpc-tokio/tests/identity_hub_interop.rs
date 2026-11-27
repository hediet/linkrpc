//! End-to-end interop tests for M4 identity core:
//!
//! 1. **Real TS Hub E2E** (spawned Node process running `@hediet/linkrpc-hub` over a Unix socket):
//!    - Self-managed Rust Ed25519 identity (`Principal::from_file`) connects via `connect_to_hub`,
//!      is denied (`PERMISSION_REQUIRED` / `-32401`) before any grant, inspects `client.grants()`,
//!      requests access via `client.request_access(...)`, verifies `grants()` reflects the TS-minted
//!      capability, calls the gated TS service, exercises `call_with_permission`, and reloads the
//!      persisted key + `.caps.json` on a fresh connection to call without re-prompting.
//!    - Managed-identity Rust client (`conn.create_managed_signing`) bootstraps via TS
//!      `identity::getPrincipal`, signs via TS `identity::sign`, and auto-negotiates a capability
//!      through TS `hubAccess::requestAccess` to call the gated service.
//!    - Plain unsigned Rust client still calls ungated root endpoints unchanged.
//! 2. **Live two-way Rust ↔ TS signature & capability verification** using fresh random Ed25519
//!    keys (Rust → TS `verifyObjectByPrincipal` / `verifyRpcCall` / `permits`, and TS → Rust).
//! 3. **Always-on in-process Rust test** covering `create_managed_signing`,
//!    `AutoNegotiatingCapProvider`, `request_access`, `grants`, and `call_with_permission` without
//!    requiring Node or built TypeScript artifacts (runs in Rust-only CI).

use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use linkrpc::prelude::*;
use linkrpc_tokio::{connect_to_hub, ConnectOptions};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

fn ts_dist_available() -> bool {
    let root = repo_root();
    root.join("typescript/packages/linkrpc/dist/index.js")
        .exists()
        && root
            .join("typescript/packages/linkrpc-hub/dist/index.js")
            .exists()
}

fn require_or_skip_ts_interop() -> bool {
    if ts_dist_available() {
        return true;
    }
    if std::env::var("LINKRPC_TS_INTEROP").is_ok_and(|v| v == "1" || v == "true") {
        panic!(
            "LINKRPC_TS_INTEROP is enabled, but TypeScript dist artifacts are missing; \
             build @hediet/linkrpc and @hediet/linkrpc-hub first."
        );
    }
    eprintln!(
        "skipping live TS hub interop test (typescript/packages/*/dist not built; \
         set LINKRPC_TS_INTEROP=1 after building TS to enforce)"
    );
    false
}

/// Live two-way verification with fresh random Ed25519 keys: Rust signs → real TS verifies,
/// and real TS signs → Rust verifies.
#[tokio::test]
async fn live_two_way_rust_and_ts_signature_interop() {
    if !require_or_skip_ts_interop() {
        return;
    }

    let caller = KeypairSigningIdentity::generate();
    let root_issuer = KeypairSigningIdentity::generate();
    let delegate = KeypairSigningIdentity::generate();
    let now_ms = current_time_ms();

    // 1. Generic signed object (with unsigned attachment).
    let raw_obj = json!({
        "action": "deploy",
        "env": "staging",
        "retries": 3,
        "$hubrpcUnsigned": { "traceId": "rust-trace-99" }
    });
    let signed_obj = sign_object("example", &raw_obj, &caller).await.unwrap();

    // 2. Delegated 2-link capability chain minted by Rust (root_issuer → delegate → caller).
    let parent_cap = issue_capability(
        &root_issuer,
        IssueCapabilityOptions {
            audience: delegate.public_signing_identity(),
            permissions: vec![Permission {
                target: TargetPattern {
                    service_id: Pattern::prefix("hello"),
                    interface_id: Pattern::prefix("greeter"),
                    interface_hash: None,
                    members: vec![Pattern::any()],
                },
                can_invoke: None,
                can_delegate: Some(true),
                params: None,
                call_bind: None,
            }],
            expires_at_ms: Some(now_ms + 120_000),
            parent: None,
        },
    )
    .await
    .unwrap();
    let leaf_cap = issue_capability(
        &delegate,
        IssueCapabilityOptions {
            audience: caller.public_signing_identity(),
            permissions: vec![Permission::invoke("hello", "greeter", ["hello"])],
            expires_at_ms: Some(now_ms + 60_000),
            parent: Some(parent_cap.clone()),
        },
    )
    .await
    .unwrap();

    // 3. Signed RPC call with attached delegated capability chain.
    let signed_call = sign_rpc_call(
        &caller,
        SignRpcCallOptions {
            method: "hello::greeter::hello".into(),
            params: Some(json!({ "name": "from-rust" })),
            now_ms: Some(now_ms),
            nonce: None,
            interface_hash: Some("0123456789abcdef".into()),
        },
    )
    .await
    .unwrap();
    let wire_params =
        attach_capabilities(&signed_call.wire_params, &[leaf_cap, parent_cap]).unwrap();

    let payload = json!({
        "keypairJson": caller.to_json(),
        "expectedPrincipal": caller.principal().as_str(),
        "signedObjectDomain": "example",
        "signedObject": signed_obj,
        "signedCallMethod": "hello::greeter::hello",
        "signedCallWireParams": wire_params,
        "acceptedRootIssuer": root_issuer.principal().as_str(),
        "nowMs": now_ms,
    });

    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_verify_rust_signatures.mjs");
    let mut child = std::process::Command::new("node")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node verification bridge");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&payload).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().expect("wait node bridge");
    assert!(
        output.status.success(),
        "TS verification bridge failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let reply: Value = serde_json::from_slice(&output.stdout).expect("parse TS bridge JSON");
    assert_eq!(reply["verifiedRust"], json!(true));
    assert_eq!(reply["rustCallHash"], json!(signed_call.call_hash));
    assert_eq!(
        reply["rustRootIssuer"],
        json!(root_issuer.principal().as_str())
    );

    // 4. Now Rust verifies the fresh TS-signed call + TS-minted capability!
    let ts_method = reply["tsMethod"].as_str().unwrap();
    let ts_wire_params = &reply["tsWireParams"];
    let verified = verify_rpc_call(VerifyRpcCallOptions {
        wire_method: ts_method,
        wire_params: Some(ts_wire_params),
        now_ms: Some(now_ms),
        max_skew_ms: Some(300_000),
        require_signed: true,
    })
    .expect("Rust verifies TS-signed RPC call");

    let ts_identity = verified.identity.expect("TS call is signed");
    assert_eq!(
        ts_identity.signer.as_str(),
        reply["tsCallerPrincipal"].as_str().unwrap()
    );
    assert_eq!(ts_identity.call_hash, reply["tsCallHash"].as_str().unwrap());
    assert_eq!(
        verified.params.unwrap(),
        json!({ "message": "hello from TS", "count": 42 })
    );

    let ts_issuer = PrincipalId::new(reply["tsIssuerPrincipal"].as_str().unwrap());
    let permit = permits(
        &Call {
            target: CallTarget {
                service_id: "rust".into(),
                interface_id: "service".into(),
                member: "echo".into(),
                interface_hash: None,
            },
            params: json!({ "message": "hello from TS", "count": 42 }),
            nonce: ts_identity.call_meta.nonce.clone(),
            signed_at_ms: ts_identity.call_meta.signed_at_ms,
            signer: ts_identity.signer.clone(),
            call_hash: ts_identity.call_hash.clone(),
        },
        &ts_identity.capabilities,
        |_| {
            vec![AcceptedRootIssuer {
                principal: ts_issuer.clone(),
                is_public: true,
            }]
        },
        now_ms,
        None,
    );
    assert!(
        permit.is_allowed(),
        "Rust permits() should accept TS-minted capability: {permit:?}"
    );
}

/// End-to-end test against a real spawned TypeScript `@hediet/linkrpc-hub` over a Unix socket.
#[cfg(unix)]
#[tokio::test]
async fn rust_client_with_identity_calls_gated_service_on_real_ts_hub() {
    if !require_or_skip_ts_interop() {
        return;
    }

    let tmp_dir =
        std::env::temp_dir().join(format!("linkrpc-rust-ts-hub-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();
    let sock_path = tmp_dir.join("hub.sock");

    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_gated_hub.mjs");
    let mut hub_proc = Command::new("node")
        .arg(&script)
        .arg(&sock_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn TS gated hub");

    let stdout = hub_proc.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut ready_line = String::new();
    reader
        .read_line(&mut ready_line)
        .await
        .expect("read hub readiness line");
    let ready: Value = serde_json::from_str(ready_line.trim())
        .unwrap_or_else(|e| panic!("invalid readiness JSON {ready_line:?}: {e}"));
    assert_eq!(ready["ready"], json!(true));
    let endpoint = ready["endpoint"].as_str().unwrap().to_owned();
    let hub_issuer = ready["issuer"].as_str().unwrap().to_owned();
    let managed_principal_id = ready["managedPrincipal"].as_str().unwrap().to_owned();

    // ── Scenario A: Self-managed file-backed Rust Ed25519 principal ──────────
    let key_file = tmp_dir.join("rust-client.json");
    let principal = Principal::from_file(&key_file).await.unwrap();

    let conn = connect_to_hub(ConnectOptions {
        endpoint: Some(endpoint.clone()),
        endpoint_token: Some(String::new()),
        linkrpc_token: None,
    })
    .await
    .expect("connect to real TS hub");
    let conn_task = tokio::spawn({
        let c = conn.clone();
        async move { c.run().await }
    });
    let client = conn.signing(principal.clone());

    // 1. Before any grant, calling the gated service MUST be denied with PERMISSION_REQUIRED.
    let denied = client
        .call("hello::greeter::hello", json!({ "name": "Rust" }))
        .await
        .expect_err("gated call must fail before grant");
    assert_eq!(
        denied.code,
        error_codes::PERMISSION_REQUIRED,
        "expected PERMISSION_REQUIRED (-32401), got {denied:?}"
    );

    // 2. `grants()` is empty before any access request.
    assert_eq!(client.grants().count, 0);

    // 3. Requesting a denied service returns HubAccessResult::Denied.
    let denied_grant = client
        .request_access(HubAccessRequest::new(
            HubAccessConsumer::new("rust-e2e").with_purpose("try forbidden service"),
            vec![HubAccessPermission::invoke("forbidden", "secret", ["read"])],
            Some(HubAccessDuration::ShortLived),
        ))
        .await
        .expect("request_access RPC succeeds");
    assert!(
        matches!(denied_grant, HubAccessResult::Denied { .. }),
        "expected Denied, got {denied_grant:?}"
    );
    assert_eq!(client.grants().count, 0);

    // 4. Request access to `hello::greeter::hello` (persistent) — TS hub approves & mints cap.
    let grant = client
        .request_access(HubAccessRequest::new(
            HubAccessConsumer::new("rust-e2e").with_purpose("greet the user"),
            vec![HubAccessPermission::invoke("hello", "greeter", ["hello"])],
            Some(HubAccessDuration::Persistent),
        ))
        .await
        .expect("request_access RPC succeeds");
    match grant {
        HubAccessResult::Granted {
            capabilities,
            added_durable,
        } => {
            assert_eq!(capabilities.len(), 1);
            assert_eq!(added_durable, 1);
        }
        other => panic!("expected Granted, got {other:?}"),
    }

    // 5. `grants()` reflects the TS-minted durable capability.
    let summary = client.grants();
    assert_eq!(summary.count, 1);
    assert_eq!(summary.grants[0].issuer, hub_issuer);
    assert_eq!(summary.grants[0].audience, principal.id().as_str());
    assert!(!summary.grants[0].one_shot);
    assert_eq!(summary.grants[0].permissions[0].service_id, "hello");
    assert_eq!(summary.grants[0].permissions[0].interface_id, "greeter");
    assert_eq!(summary.grants[0].permissions[0].members, vec!["hello"]);
    assert!(summary.grants[0].permissions[0].can_invoke);

    // 6. Now the gated call succeeds on the real TS hub!
    let greeting = client
        .call("hello::greeter::hello", json!({ "name": "Rust" }))
        .await
        .expect("gated call succeeds after grant");
    assert_eq!(greeting, json!({ "greeting": "Hello, Rust!" }));

    // 7. `call_with_permission` auto-negotiates access for `farewell` and retries once.
    let farewell = client
        .call_with_permission(
            "hello::greeter::farewell",
            json!({ "name": "Rust" }),
            Some(HubAccessConsumer::new("rust-e2e")),
            Some(HubAccessDuration::LongLived),
        )
        .await
        .expect("call_with_permission succeeds");
    assert_eq!(farewell, json!({ "bye": "Goodbye, Rust!" }));
    assert_eq!(client.grants().count, 2);

    conn_task.abort();

    // 8. A fresh connection loading the SAME file key + sibling `.caps.json` succeeds immediately
    //    without calling `request_access` again!
    let reloaded_principal = Principal::from_file(&key_file).await.unwrap();
    assert_eq!(reloaded_principal.id(), principal.id());
    assert_eq!(reloaded_principal.cap_bag().capabilities().len(), 2);

    let conn2 = connect_to_hub(ConnectOptions {
        endpoint: Some(endpoint.clone()),
        endpoint_token: Some(String::new()),
        linkrpc_token: None,
    })
    .await
    .expect("reconnect to TS hub");
    let conn2_task = tokio::spawn({
        let c = conn2.clone();
        async move { c.run().await }
    });
    let client2 = conn2.signing(reloaded_principal);
    let persisted_reply = client2
        .call("hello::greeter::hello", json!({ "name": "Persisted" }))
        .await
        .expect("reloaded persisted grant works immediately");
    assert_eq!(persisted_reply, json!({ "greeting": "Hello, Persisted!" }));
    conn2_task.abort();

    // ── Scenario B: Managed-identity Rust client (`create_managed_signing`) ──
    let managed_conn = connect_to_hub(ConnectOptions {
        endpoint: Some(endpoint.clone()),
        endpoint_token: Some(String::new()),
        linkrpc_token: None,
    })
    .await
    .expect("connect managed client to TS hub");
    let managed_task = tokio::spawn({
        let c = managed_conn.clone();
        async move { c.run().await }
    });
    let managed = managed_conn
        .create_managed_signing(ManagedSigningOptions {
            auto_negotiate_caps: true,
            consumer: Some(HubAccessConsumer::new("rust-managed-e2e")),
        })
        .await
        .expect("bootstrap managed signing client from TS hub");
    assert_eq!(
        managed.principal_id().unwrap().as_str(),
        managed_principal_id
    );
    let managed_reply = managed
        .call("hello::greeter::hello", json!({ "name": "Managed" }))
        .await
        .expect("auto-negotiated managed call succeeds on real TS hub");
    assert_eq!(managed_reply, json!({ "greeting": "Hello, Managed!" }));
    managed_task.abort();

    // ── Scenario C: Plain unsigned Rust client still works on root services ──
    let unsigned_conn = connect_to_hub(ConnectOptions {
        endpoint: Some(endpoint),
        endpoint_token: Some(String::new()),
        linkrpc_token: None,
    })
    .await
    .expect("connect unsigned client to TS hub");
    let unsigned_task = tokio::spawn({
        let c = unsigned_conn.clone();
        async move { c.run().await }
    });
    let hub_id = unsigned_conn
        .call("hubGrantedServiceId::getHubServiceId", json!({}))
        .await
        .expect("unsigned root call succeeds");
    assert_eq!(hub_id, json!({ "hubServiceId": "hub" }));
    unsigned_task.abort();

    // Shut down the TS hub cleanly.
    drop(hub_proc.stdin.take());
    let status = hub_proc.wait().await.expect("TS hub exits cleanly");
    assert!(status.success(), "TS hub exited with {status}");
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

/// Always-on in-process Rust test exercising `create_managed_signing`, `AutoNegotiatingCapProvider`,
/// `identity::*` + `identity.storage::*`, `hubAccess::requestAccess`, and `grants()` without
/// requiring Node or TypeScript dist artifacts.
#[tokio::test]
async fn in_process_managed_signing_and_auto_negotiation() {
    let managed_id = Arc::new(KeypairSigningIdentity::from_numeric_seed(2));
    let admin_id = Arc::new(KeypairSigningIdentity::from_numeric_seed(1));
    let storage = Arc::new(InMemoryIdentityStorage::new());

    struct MockHubHandler {
        managed_id: Arc<KeypairSigningIdentity>,
        admin_id: Arc<KeypairSigningIdentity>,
        storage: Arc<InMemoryIdentityStorage>,
    }

    #[async_trait]
    impl RequestHandler for MockHubHandler {
        async fn handle_request(
            &self,
            method: String,
            params: JsonValue,
        ) -> Result<JsonValue, JsonRpcError> {
            match method.as_str() {
                "identity::getPrincipal" => {
                    Ok(json!({ "principal": self.managed_id.principal().as_str() }))
                }
                "identity::sign" => {
                    let bytes = base64url_decode(params["bytes"].as_str().unwrap()).unwrap();
                    let sig = self.managed_id.sign_sync(&bytes);
                    Ok(json!({ "signature": base64url_encode(&sig) }))
                }
                "identity.storage::get" => {
                    let key = params["key"].as_str().unwrap();
                    match self.storage.get(key).await.unwrap() {
                        Some(v) => Ok(json!({ "value": v })),
                        None => Ok(json!({})),
                    }
                }
                "identity.storage::set" => {
                    let key = params["key"].as_str().unwrap();
                    self.storage
                        .set(key, params["value"].clone())
                        .await
                        .unwrap();
                    Ok(json!({}))
                }
                "hubAccess::requestAccess" => {
                    let verified = verify_rpc_call(VerifyRpcCallOptions {
                        wire_method: &method,
                        wire_params: Some(&params),
                        now_ms: None,
                        max_skew_ms: None,
                        require_signed: true,
                    })
                    .map_err(|e| JsonRpcError::new(error_codes::INVALID_REQUEST, e.reason))?;
                    let user_params = verified.params.unwrap();
                    let audience =
                        PrincipalId::new(user_params["consumer"]["principal"].as_str().unwrap());
                    let permissions: Vec<Permission> =
                        serde_json::from_value(user_params["permissions"].clone()).unwrap();
                    let cap = issue_capability(
                        self.admin_id.as_ref(),
                        IssueCapabilityOptions {
                            audience: PublicSigningIdentity::new(audience),
                            permissions,
                            expires_at_ms: Some(current_time_ms() + 60_000),
                            parent: None,
                        },
                    )
                    .await
                    .unwrap();
                    Ok(json!({ "status": "granted", "capabilities": [cap] }))
                }
                "hello::greeter::hello" => {
                    let verified = verify_rpc_call(VerifyRpcCallOptions {
                        wire_method: &method,
                        wire_params: Some(&params),
                        now_ms: None,
                        max_skew_ms: None,
                        require_signed: true,
                    })
                    .map_err(|e| JsonRpcError::new(error_codes::INVALID_REQUEST, e.reason))?;
                    let id = verified.identity.unwrap();
                    let call = Call {
                        target: CallTarget {
                            service_id: "hello".into(),
                            interface_id: "greeter".into(),
                            member: "hello".into(),
                            interface_hash: id.call_meta.interface_hash.clone(),
                        },
                        params: verified.params.clone().unwrap_or_else(|| json!({})),
                        nonce: id.call_meta.nonce.clone(),
                        signed_at_ms: id.call_meta.signed_at_ms,
                        signer: id.signer.clone(),
                        call_hash: id.call_hash.clone(),
                    };
                    let admin_principal = self.admin_id.principal();
                    let verdict = permits(
                        &call,
                        &id.capabilities,
                        |_| {
                            vec![AcceptedRootIssuer {
                                principal: admin_principal.clone(),
                                is_public: true,
                            }]
                        },
                        current_time_ms(),
                        None,
                    );
                    if !verdict.is_allowed() {
                        return Err(JsonRpcError::new(
                            error_codes::PERMISSION_REQUIRED,
                            "capability required",
                        ));
                    }
                    let name = verified.params.unwrap()["name"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    Ok(json!({ "greeting": format!("Hello, {name}!") }))
                }
                other => Err(JsonRpcError::new(
                    error_codes::METHOD_NOT_FOUND,
                    format!("unknown method {other}"),
                )),
            }
        }
    }

    let (client_tx, server_tx) = transport_pair();
    let server = Channel::new(
        Box::new(server_tx),
        Box::new(MockHubHandler {
            managed_id: managed_id.clone(),
            admin_id,
            storage,
        }),
    );
    let server_task = tokio::spawn({
        let s = server.clone();
        async move { s.run().await }
    });

    let client_conn = LinkRpcConnection::new(Box::new(client_tx));
    let client_task = tokio::spawn({
        let c = client_conn.clone();
        async move { c.run().await }
    });

    let managed = client_conn
        .create_managed_signing(ManagedSigningOptions {
            auto_negotiate_caps: true,
            consumer: Some(HubAccessConsumer::new("rust-inproc")),
        })
        .await
        .expect("bootstrap managed signing");
    assert_eq!(managed.principal_id().unwrap(), managed_id.principal());
    assert_eq!(managed.grants().count, 0);

    // First call auto-negotiates a durable grant via hubAccess and succeeds.
    let res = managed
        .call("hello::greeter::hello", json!({ "name": "World" }))
        .await
        .expect("auto-negotiated call succeeds");
    assert_eq!(res, json!({ "greeting": "Hello, World!" }));
    assert_eq!(managed.grants().count, 1);

    client_task.abort();
    server_task.abort();
}
