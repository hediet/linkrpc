//! Conformance & unit tests for M4 identity core.
//!
//! Loads `conformance/vectors/signed_envelope.json` (generated from the real TypeScript
//! `@hediet/linkrpc` implementation) and asserts byte-for-byte parity on Ed25519 keys,
//! `PrincipalId` / `KeyId` derivation, JCS signing input, `signedHash`, Ed25519 signatures,
//! `$hubrpc` signed envelopes, `verify_rpc_call`, and `permits` capability verdicts.
//!
//! Also exercises pluggable key storage (in-memory + file), `CapBag` persistence,
//! `SigningClient` (signed + optional unsigned + one-shot caps + grant flow), and
//! `VerifyingRequestHandler` / `VerifiedSignatureTransport`.

use std::path::PathBuf;
use std::sync::Arc;

use linkrpc::prelude::*;
use serde_json::{json, Value};

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("conformance")
        .join("vectors")
}

fn load_signed_envelope_vectors() -> Value {
    let path = vectors_dir().join("signed_envelope.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("signed_envelope.json parses")
}

#[test]
fn seeded_identities_match_typescript() {
    let vectors = load_signed_envelope_vectors();
    for entry in vectors["identities"].as_array().unwrap() {
        let seed = entry["seed"].as_u64().unwrap();
        let id = KeypairSigningIdentity::from_numeric_seed(seed);
        let serialized = id.to_json();
        assert_eq!(
            serialized.private_key,
            entry["privateKey"].as_str().unwrap()
        );
        assert_eq!(serialized.public_key, entry["publicKey"].as_str().unwrap());
        assert_eq!(
            id.key_id().unwrap().as_str(),
            entry["keyId"].as_str().unwrap()
        );
        assert_eq!(
            id.principal().as_str(),
            entry["principal"].as_str().unwrap()
        );

        // Round-trip through JSON matches TS format.
        let restored = KeypairSigningIdentity::from_json(&serialized).expect("restores from json");
        assert_eq!(restored.principal(), id.principal());
    }
}

#[tokio::test]
async fn signed_objects_match_typescript_byte_for_byte() {
    let vectors = load_signed_envelope_vectors();
    for case in vectors["signedObjects"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let seed = case["seed"].as_u64().unwrap();
        let domain = case["domain"].as_str().unwrap();
        let obj = &case["object"];
        let id = KeypairSigningIdentity::from_numeric_seed(seed);

        let input = signing_input(domain, obj).expect("signing_input");
        assert_eq!(
            String::from_utf8(input).unwrap(),
            case["signingInput"].as_str().unwrap(),
            "signingInput mismatch for {name}"
        );
        let hash = signed_hash(domain, obj).expect("signed_hash");
        assert_eq!(
            hash,
            case["signedHash"].as_str().unwrap(),
            "signedHash mismatch for {name}"
        );

        let signed = sign_object(domain, obj, &id).await.expect("sign_object");
        assert_eq!(signed, case["signed"], "signed object mismatch for {name}");

        // Verify both Rust-produced and TS-produced signed objects.
        assert!(verify_object_by_principal(domain, &signed, &id.principal()));
        assert!(verify_object_by_principal(
            domain,
            &case["signed"],
            &id.principal()
        ));
        // Wrong domain must fail.
        assert!(!verify_object_by_principal(
            "wrong",
            &signed,
            &id.principal()
        ));
    }
}

#[tokio::test]
async fn signed_rpc_calls_match_typescript_byte_for_byte() {
    let vectors = load_signed_envelope_vectors();
    for case in vectors["signedCalls"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let seed = case["seed"].as_u64().unwrap();
        let method = case["method"].as_str().unwrap().to_owned();
        let params = if case["paramsOmitted"].as_bool().unwrap() {
            None
        } else {
            Some(case["params"].clone())
        };
        let now_ms = case["nowMs"].as_i64().unwrap();
        let nonce = base64url_decode(case["nonceB64"].as_str().unwrap()).unwrap();
        let interface_hash = case["interfaceHash"].as_str().map(str::to_owned);
        let id = KeypairSigningIdentity::from_numeric_seed(seed);

        let signed = sign_rpc_call(
            &id,
            SignRpcCallOptions {
                method,
                params,
                now_ms: Some(now_ms),
                nonce: Some(nonce),
                interface_hash,
            },
        )
        .await
        .expect("sign_rpc_call");

        assert_eq!(
            serde_json::to_value(&signed.call_meta).unwrap(),
            case["callMeta"],
            "callMeta mismatch for {name}"
        );
        assert_eq!(
            signed.call_hash,
            case["callHash"].as_str().unwrap(),
            "callHash mismatch for {name}"
        );
        assert_eq!(
            signed.wire_params, case["wireParams"],
            "wireParams mismatch for {name}"
        );
    }
}

#[tokio::test]
async fn signed_capabilities_match_typescript_byte_for_byte() {
    let vectors = load_signed_envelope_vectors();
    for case in vectors["capabilities"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let seed = case["seed"].as_u64().unwrap();
        let id = KeypairSigningIdentity::from_numeric_seed(seed);
        let unsigned: Capability =
            serde_json::from_value(case["unsigned"].clone()).expect("Capability deserializes");

        let signed = sign_capability(&unsigned, &id)
            .await
            .expect("sign_capability");
        assert_eq!(
            signed.to_json_value().unwrap(),
            case["signed"],
            "signed capability mismatch for {name}"
        );
        assert_eq!(
            signed.content_hash().unwrap(),
            case["hash"].as_str().unwrap(),
            "capability hash mismatch for {name}"
        );

        // Deserializing TS SignedCapability preserves signature & hash.
        let from_ts: SignedCapability =
            serde_json::from_value(case["signed"].clone()).expect("TS SignedCapability parses");
        assert_eq!(
            from_ts.content_hash().unwrap(),
            case["hash"].as_str().unwrap()
        );
    }
}

#[test]
fn verify_rpc_call_matches_typescript_verdicts() {
    let vectors = load_signed_envelope_vectors();
    for case in vectors["verifyRpcCalls"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let res = verify_rpc_call(VerifyRpcCallOptions {
            wire_method: case["wireMethod"].as_str().unwrap(),
            wire_params: Some(&case["wireParams"]),
            now_ms: Some(case["nowMs"].as_i64().unwrap()),
            max_skew_ms: Some(case["maxSkewMs"].as_i64().unwrap()),
            require_signed: case["requireSigned"].as_bool().unwrap(),
        });

        let expected_ok = case["expectedOk"].as_bool().unwrap();
        assert_eq!(
            res.is_ok(),
            expected_ok,
            "ok verdict mismatch for {name}: {res:?}"
        );
        if let Ok(verified) = res {
            let expected_signed = case["expectedSigned"].as_bool().unwrap();
            assert_eq!(
                verified.identity.is_some(),
                expected_signed,
                "signed mismatch for {name}"
            );
            if let Some(identity) = verified.identity {
                assert_eq!(
                    identity.signer.as_str(),
                    case["expectedSigner"].as_str().unwrap(),
                    "signer mismatch for {name}"
                );
                assert_eq!(
                    identity.call_hash,
                    case["expectedCallHash"].as_str().unwrap(),
                    "callHash mismatch for {name}"
                );
                assert_eq!(
                    identity.capabilities.len(),
                    case["expectedCapCount"].as_u64().unwrap() as usize,
                    "capCount mismatch for {name}"
                );
            }
            assert_eq!(
                verified.params.unwrap_or(Value::Null),
                case["expectedParams"],
                "stripped params mismatch for {name}"
            );
        }
    }
}

#[test]
fn permits_matches_typescript_verdicts() {
    let vectors = load_signed_envelope_vectors();
    for case in vectors["permitVerdicts"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let raw_call = &case["call"];
        let call = Call {
            target: CallTarget {
                service_id: raw_call["target"]["serviceId"].as_str().unwrap().to_owned(),
                interface_id: raw_call["target"]["interfaceId"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                member: raw_call["target"]["member"].as_str().unwrap().to_owned(),
                interface_hash: raw_call["target"]["interfaceHash"]
                    .as_str()
                    .map(str::to_owned),
            },
            params: raw_call["params"].clone(),
            nonce: raw_call["nonce"].as_str().unwrap().to_owned(),
            signed_at_ms: raw_call["signedAtMs"].as_i64().unwrap(),
            signer: PrincipalId::new(raw_call["signer"].as_str().unwrap()),
            call_hash: raw_call["callHash"].as_str().unwrap().to_owned(),
        };
        let capabilities: Vec<SignedCapability> =
            serde_json::from_value(case["capabilities"].clone()).unwrap();
        let accepted_roots: Vec<AcceptedRootIssuer> = case["acceptedRoots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| AcceptedRootIssuer {
                principal: PrincipalId::new(r.as_str().unwrap()),
                is_public: true,
            })
            .collect();
        let now_ms = case["nowMs"].as_i64().unwrap();

        let verdict = permits(
            &call,
            &capabilities,
            |_| accepted_roots.clone(),
            now_ms,
            None,
        );
        let expected_ok = case["expectedOk"].as_bool().unwrap();
        assert_eq!(
            verdict.is_allowed(),
            expected_ok,
            "permits verdict mismatch for {name}: {verdict:?}"
        );
        if let PermitResult::Allowed { root_issuer, .. } = verdict {
            assert_eq!(
                root_issuer.as_str(),
                case["expectedRootIssuer"].as_str().unwrap(),
                "rootIssuer mismatch for {name}"
            );
        }
    }
}

#[tokio::test]
async fn key_store_in_memory_and_file_round_trip() {
    let mem = InMemoryKeyStore::new();
    assert!(mem.load("slot-a").await.unwrap().is_none());
    let created = mem.load_or_create("slot-a").await.unwrap();
    let again = mem.load_or_create("slot-a").await.unwrap();
    assert_eq!(created.principal(), again.principal());
    assert!(mem.delete("slot-a").await.unwrap());
    assert!(mem.load("slot-a").await.unwrap().is_none());

    // File-backed key store + sibling caps storage.
    let dir =
        std::env::temp_dir().join(format!("linkrpc-rust-identity-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);

    let file_store = FileKeyStore::new(&dir);
    let f1 = file_store.load_or_create("agent:test").await.unwrap();
    let f2 = file_store.load_or_create("agent:test").await.unwrap();
    assert_eq!(f1.principal(), f2.principal());

    let explicit_file = dir.join("explicit-agent.json");
    let principal = Principal::from_file(&explicit_file).await.unwrap();
    let issuer = KeypairSigningIdentity::from_numeric_seed(1);
    let cap = issue_capability(
        &issuer,
        IssueCapabilityOptions {
            audience: principal.public_identity(),
            permissions: vec![Permission::invoke("hello", "greeter", ["hello"])],
            expires_at_ms: None,
            parent: None,
        },
    )
    .await
    .unwrap();
    principal
        .cap_bag()
        .add(std::slice::from_ref(&cap))
        .await
        .unwrap();

    // Reloading from the same file preserves both principal and persisted capabilities.
    let reloaded = Principal::from_file(&explicit_file).await.unwrap();
    assert_eq!(reloaded.id(), principal.id());
    assert_eq!(reloaded.cap_bag().capabilities(), vec![cap]);

    let summary = summarize_grants(&reloaded.cap_bag().capabilities());
    assert_eq!(summary.count, 1);
    assert_eq!(summary.grants[0].issuer, issuer.principal().as_str());
    assert_eq!(summary.grants[0].audience, principal.id().as_str());
    assert!(!summary.grants[0].one_shot);
    assert_eq!(summary.grants[0].permissions[0].service_id, "hello");
    assert_eq!(summary.grants[0].permissions[0].interface_id, "greeter");
    assert_eq!(summary.grants[0].permissions[0].members, vec!["hello"]);
    assert!(summary.grants[0].permissions[0].can_invoke);
    assert!(!summary.grants[0].permissions[0].can_delegate);

    let _ = std::fs::remove_dir_all(&dir);
}

#[link_rpc_interface(id = "echo")]
trait Echo {
    async fn ping(msg: String) -> Result<String, JsonRpcError>;
}

struct EchoImpl;

#[async_trait]
impl Echo for EchoImpl {
    async fn ping(&self, _ctx: &CallCtx, msg: String) -> Result<String, JsonRpcError> {
        Ok(format!("pong:{msg}"))
    }
}

#[tokio::test]
async fn signing_client_signed_and_optional_unsigned_round_trip() {
    let (client_tx, server_tx) = transport_pair();
    // Server accepts both unsigned and validly-signed calls, rejecting tampered signatures.
    let verifying_server_tx = Box::new(VerifiedSignatureTransport::new(Box::new(server_tx), false));
    let server = LinkRpcConnection::new(verifying_server_tx);
    server
        .register_service(
            Arc::new(EchoServer::new(Arc::new(EchoImpl))),
            RegisterOptions::default(),
        )
        .unwrap();
    let server_handle = tokio::spawn({
        let s = server.clone();
        async move { s.run().await }
    });

    let conn = LinkRpcConnection::new(Box::new(client_tx));
    let client_handle = tokio::spawn({
        let c = conn.clone();
        async move { c.run().await }
    });

    // 1. Plain unsigned call still works unchanged.
    let unsigned_client = EchoClient::new(conn.clone());
    assert_eq!(
        unsigned_client.ping("anon".into()).await.unwrap(),
        "pong:anon"
    );

    // 2. Signed call via SigningClient works with generated typed clients and strips `$hubrpc*`.
    let principal = Principal::from_numeric_seed(0);
    let signing = conn.signing(principal);
    let signed_client = EchoClient::new(signing.clone());
    assert_eq!(
        signed_client.ping("signed".into()).await.unwrap(),
        "pong:signed"
    );

    // 3. Per-call unsigned override works on a signing client.
    let raw = signing
        .call_with_ctx(
            "echo::ping",
            json!({ "msg": "override" }),
            SigningCallCtx::unsigned(),
        )
        .await
        .unwrap();
    assert_eq!(raw, json!("pong:override"));

    // 4. Tampered signature is rejected at the transport gate.
    let mut forged = sign_rpc_call(
        &KeypairSigningIdentity::from_numeric_seed(0),
        SignRpcCallOptions {
            method: "echo::ping".into(),
            params: Some(json!({ "msg": "original" })),
            now_ms: None,
            nonce: None,
            interface_hash: None,
        },
    )
    .await
    .unwrap()
    .wire_params;
    forged["msg"] = json!("tampered");
    let err = conn.call("echo::ping", forged).await.unwrap_err();
    assert_eq!(err.code, error_codes::INVALID_REQUEST);
    assert!(
        err.message.contains("bad signature"),
        "unexpected err: {err:?}"
    );

    drop(conn);
    drop(signing);
    drop(server);
    client_handle.abort();
    server_handle.abort();
}
