#![allow(unused)]

use std::{env, sync::Arc, time::Duration};

use async_trait::async_trait;
use linkrpc::prelude::*;
use linkrpc_tokio::NdjsonTransport;
use tokio::{sync::Notify, time::timeout};

include!(concat!(env!("OUT_DIR"), "/protocol_schemas.rs"));

use selected::{cdp_dom as cdp, lsp_textdocument as lsp};

const DEADLINE: Duration = Duration::from_secs(10);
const CDP_PREFIX: &str = "DOM.";
const LSP_PREFIX: &str = "textDocument/";

fn fixture_error(message: &str) -> JsonRpcError {
    JsonRpcError::new(-32000, message)
}

struct CdpServerService {
    connection: LinkRpcConnection,
}

#[async_trait]
impl cdp::CdpDomService for CdpServerService {
    async fn get_document(
        &self,
        _ctx: &CallCtx,
        params: cdp::GetDocumentParams,
    ) -> Result<cdp::GetDocumentResult, JsonRpcError> {
        if params.depth == Some(-99) {
            return Err(fixture_error("cdp fixture error"));
        }
        assert_eq!(params.depth, Some(2));
        let mut root = cdp::DomNode::new(1, 1, 9, "#document".into(), "".into(), "".into());
        root.children = Some(vec![cdp::DomNode::new(
            2,
            2,
            1,
            "HTML".into(),
            "html".into(),
            "".into(),
        )]);
        cdp::CdpDomClient::with_prefix(self.connection.clone(), CDP_PREFIX)
            .document_updated(cdp::DocumentUpdatedParams::new())
            .await?;
        Ok(cdp::GetDocumentResult::new(root))
    }

    async fn document_updated(
        &self,
        _ctx: &CallCtx,
        _params: cdp::DocumentUpdatedParams,
    ) -> Result<(), JsonRpcError> {
        Ok(())
    }
}

struct LspServerService {
    connection: LinkRpcConnection,
}

#[async_trait]
impl lsp::LspTextdocumentService for LspServerService {
    async fn did_open(
        &self,
        _ctx: &CallCtx,
        params: lsp::DidOpenTextDocumentParams,
    ) -> Result<(), JsonRpcError> {
        assert_eq!(params.text_document.uri, "file:///interop.json");
        assert_eq!(params.text_document.language_id, "json");
        assert_eq!(params.text_document.version, 1);
        assert_eq!(params.text_document.text, "{}");
        lsp::LspTextdocumentClient::with_prefix(self.connection.clone(), LSP_PREFIX)
            .publish_diagnostics(lsp::PublishDiagnosticsParams::new(
                "file:///interop.json".into(),
                vec![],
            ))
            .await
    }

    async fn publish_diagnostics(
        &self,
        _ctx: &CallCtx,
        _params: lsp::PublishDiagnosticsParams,
    ) -> Result<(), JsonRpcError> {
        Ok(())
    }

    async fn selection_range(
        &self,
        _ctx: &CallCtx,
        params: lsp::SelectionRangeParams,
    ) -> Result<lsp::SelectionRangeResult, JsonRpcError> {
        if params.text_document.uri == "file:///error.json" {
            return Err(fixture_error("lsp fixture error"));
        }
        assert_eq!(params.text_document.uri, "file:///interop.json");
        if params.positions.is_empty() {
            return Ok(lsp::SelectionRangeResult::Variant1(()));
        }
        assert_eq!(params.positions.len(), 1);
        assert_eq!(params.positions[0].line, 1);
        assert_eq!(params.positions[0].character, 2);
        let mut selection = lsp::SelectionRange::new(lsp::Range::new(
            lsp::Position::new(1, 0),
            lsp::Position::new(1, 5),
        ));
        selection.parent = Some(Box::new(lsp::SelectionRange::new(lsp::Range::new(
            lsp::Position::new(0, 0),
            lsp::Position::new(3, 0),
        ))));
        Ok(lsp::SelectionRangeResult::Variant0(vec![selection]))
    }
}

struct CdpClientService(Arc<Notify>);

#[async_trait]
impl cdp::CdpDomService for CdpClientService {
    async fn get_document(
        &self,
        _ctx: &CallCtx,
        _params: cdp::GetDocumentParams,
    ) -> Result<cdp::GetDocumentResult, JsonRpcError> {
        Err(JsonRpcError::new(error_codes::METHOD_NOT_FOUND, "client"))
    }

    async fn document_updated(
        &self,
        _ctx: &CallCtx,
        _params: cdp::DocumentUpdatedParams,
    ) -> Result<(), JsonRpcError> {
        self.0.notify_one();
        Ok(())
    }
}

struct LspClientService(Arc<Notify>);

#[async_trait]
impl lsp::LspTextdocumentService for LspClientService {
    async fn did_open(
        &self,
        _ctx: &CallCtx,
        _params: lsp::DidOpenTextDocumentParams,
    ) -> Result<(), JsonRpcError> {
        Ok(())
    }

    async fn publish_diagnostics(
        &self,
        _ctx: &CallCtx,
        params: lsp::PublishDiagnosticsParams,
    ) -> Result<(), JsonRpcError> {
        assert_eq!(params.uri, "file:///interop.json");
        assert!(params.diagnostics.is_empty());
        self.0.notify_one();
        Ok(())
    }

    async fn selection_range(
        &self,
        _ctx: &CallCtx,
        _params: lsp::SelectionRangeParams,
    ) -> Result<lsp::SelectionRangeResult, JsonRpcError> {
        Err(JsonRpcError::new(error_codes::METHOD_NOT_FOUND, "client"))
    }
}

fn connection() -> LinkRpcConnection {
    LinkRpcConnection::new(Box::new(NdjsonTransport::new(
        tokio::io::stdin(),
        tokio::io::stdout(),
    )))
}

fn register<S: ServiceExport + 'static>(
    connection: &LinkRpcConnection,
    service: S,
    prefix: &str,
    _interface_id: &str,
) {
    connection
        .register_service(
            Arc::new(service),
            RegisterOptions {
                bare_prefix: Some(prefix.to_string()),
                ..Default::default()
            },
        )
        .expect("register generated service adapter");
}

async fn server(protocol: &str) {
    let connection = connection();
    match protocol {
        "cdp" => {
            register(
                &connection,
                cdp::CdpDomServer::new(Arc::new(CdpServerService {
                    connection: connection.clone(),
                })),
                CDP_PREFIX,
                "cdp.dom",
            );
            connection.enable_reflection();
            let interface = cdp::CdpDomServer::<CdpServerService>::interface();
            eprintln!("READY {} {}", interface.id(), interface.schema_hash());
        }
        "lsp" => {
            register(
                &connection,
                lsp::LspTextdocumentServer::new(Arc::new(LspServerService {
                    connection: connection.clone(),
                })),
                LSP_PREFIX,
                "lsp.textdocument",
            );
            connection.enable_reflection();
            let interface = lsp::LspTextdocumentServer::<LspServerService>::interface();
            eprintln!("READY {} {}", interface.id(), interface.schema_hash());
        }
        _ => usage(),
    }
    connection.run().await;
}

async fn client(protocol: &str) {
    let connection = connection();
    let notification = Arc::new(Notify::new());
    match protocol {
        "cdp" => register(
            &connection,
            cdp::CdpDomServer::new(Arc::new(CdpClientService(notification.clone()))),
            CDP_PREFIX,
            "cdp.dom",
        ),
        "lsp" => register(
            &connection,
            lsp::LspTextdocumentServer::new(Arc::new(LspClientService(notification.clone()))),
            LSP_PREFIX,
            "lsp.textdocument",
        ),
        _ => usage(),
    }

    let driver = connection.clone();
    tokio::spawn(async move { driver.run().await });
    match protocol {
        "cdp" => run_cdp_client(connection, notification).await,
        "lsp" => run_lsp_client(connection, notification).await,
        _ => unreachable!(),
    }
    eprintln!("PASS {protocol}");
    // Tokio's blocking stdio reader cannot be cancelled while the peer keeps its
    // output open. All assertions have completed, so terminate without waiting
    // for the detached connection driver.
    std::process::exit(0);
}

async fn run_cdp_client(connection: LinkRpcConnection, notification: Arc<Notify>) {
    let client = cdp::CdpDomClient::with_prefix(connection, CDP_PREFIX);
    let result = timeout(DEADLINE, client.get_document(cdp_params(2)))
        .await
        .expect("CDP getDocument deadline")
        .expect("CDP getDocument");
    assert_eq!(result.root.node_id, 1);
    assert_eq!(result.root.children.as_ref().unwrap()[0].node_name, "HTML");
    timeout(DEADLINE, notification.notified())
        .await
        .expect("CDP documentUpdated deadline");

    let error = timeout(DEADLINE, client.get_document(cdp_params(-99)))
        .await
        .expect("CDP error deadline")
        .expect_err("CDP fixture request must fail");
    assert_eq!(error.code, -32000);
    assert_eq!(error.message, "cdp fixture error");
}

async fn run_lsp_client(connection: LinkRpcConnection, notification: Arc<Notify>) {
    let client = lsp::LspTextdocumentClient::with_prefix(connection, LSP_PREFIX);
    timeout(
        DEADLINE,
        client.did_open(lsp::DidOpenTextDocumentParams::new(
            lsp::TextDocumentItem::new(
                "file:///interop.json".into(),
                "json".into(),
                1,
                "{}".into(),
            ),
        )),
    )
    .await
    .expect("LSP didOpen deadline")
    .expect("LSP didOpen");
    timeout(DEADLINE, notification.notified())
        .await
        .expect("LSP publishDiagnostics deadline");

    let result = timeout(
        DEADLINE,
        client.selection_range(lsp_params("file:///interop.json")),
    )
    .await
    .expect("LSP selectionRange deadline")
    .expect("LSP selectionRange");
    let lsp::SelectionRangeResult::Variant0(ranges) = result else {
        panic!("expected typed selection ranges");
    };
    assert_eq!(ranges[0].range.start.line, 1);
    assert_eq!(ranges[0].parent.as_ref().unwrap().range.end.line, 3);

    let mut empty = lsp_params("file:///interop.json");
    empty.positions.clear();
    let result = timeout(DEADLINE, client.selection_range(empty))
        .await
        .expect("LSP null result deadline")
        .expect("LSP null result");
    assert!(matches!(result, lsp::SelectionRangeResult::Variant1(())));

    let error = timeout(
        DEADLINE,
        client.selection_range(lsp_params("file:///error.json")),
    )
    .await
    .expect("LSP error deadline")
    .expect_err("LSP fixture request must fail");
    assert_eq!(error.code, -32000);
    assert_eq!(error.message, "lsp fixture error");
}

fn usage() -> ! {
    eprintln!("usage: linkrpc-protocol-interop <server|client> <cdp|lsp>");
    std::process::exit(2);
}

fn cdp_params(depth: i64) -> cdp::GetDocumentParams {
    let mut params = cdp::GetDocumentParams::new();
    params.depth = Some(depth);
    params
}

fn lsp_params(uri: &str) -> lsp::SelectionRangeParams {
    lsp::SelectionRangeParams::new(
        lsp::TextDocumentIdentifier::new(uri.into()),
        vec![lsp::Position::new(1, 2)],
    )
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [mode, protocol] if mode == "server" => server(protocol).await,
        [mode, protocol] if mode == "client" => client(protocol).await,
        _ => usage(),
    }
}
