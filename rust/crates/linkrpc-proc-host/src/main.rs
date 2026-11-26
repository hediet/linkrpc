mod job;
mod protocol;

use std::collections::{BTreeMap, VecDeque};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{broadcast, mpsc, Notify};

use crate::job::ProcessTreeHandle;
use crate::protocol::{
    decode_base64, encode_base64, ExitSummary, HelloParams, IdParams, Notification, OutputChunk,
    ProcessSummary, RemoveParams, Request, Response, RpcError, ShutdownParams, SignalParams,
    SpawnParams, WriteParams,
};

const DEFAULT_RING_BYTES: usize = 256 * 1024;
const PROTOCOL_VERSION: u32 = 1;

struct RingBuffer {
    max_bytes: usize,
    total_bytes: usize,
    chunks: VecDeque<(OutputChunk, usize)>,
}

impl RingBuffer {
    fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            total_bytes: 0,
            chunks: VecDeque::new(),
        }
    }

    fn push(&mut self, stream: &'static str, raw: &[u8]) {
        if self.max_bytes == 0 || raw.is_empty() {
            return;
        }
        let chunk = OutputChunk {
            stream,
            data_base64: encode_base64(raw),
        };
        self.total_bytes += raw.len();
        self.chunks.push_back((chunk, raw.len()));
        while self.total_bytes > self.max_bytes && self.chunks.len() > 1 {
            if let Some((_, len)) = self.chunks.pop_front() {
                self.total_bytes -= len;
            }
        }
    }

    fn snapshot(&self) -> Vec<OutputChunk> {
        self.chunks.iter().map(|(c, _)| c.clone()).collect()
    }
}

struct ManagedProcess {
    id: String,
    pid: u32,
    started_at: u64,
    stdin_tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
    tree: Option<ProcessTreeHandle>,
    exit: Option<ExitSummary>,
    ring: RingBuffer,
}

impl ManagedProcess {
    fn summary(&self) -> ProcessSummary {
        ProcessSummary {
            id: self.id.clone(),
            pid: self.pid,
            running: self.exit.is_none(),
            started_at: self.started_at,
            exit: self.exit.clone(),
        }
    }
}

struct HostState {
    token: String,
    processes: Mutex<BTreeMap<String, ManagedProcess>>,
    events: broadcast::Sender<Notification>,
    shutdown_notify: Notify,
}

impl HostState {
    fn new(token: String) -> Arc<Self> {
        let (events, _) = broadcast::channel(512);
        Arc::new(Self {
            token,
            processes: Mutex::new(BTreeMap::new()),
            events,
            shutdown_notify: Notify::new(),
        })
    }

    fn handle_request(self: &Arc<Self>, req: Request) -> Response {
        let result = match req.method.as_str() {
            "list" => self.rpc_list(),
            "spawn" => serde_json::from_value::<SpawnParams>(req.params)
                .map_err(|e| format!("invalid spawn params: {e}"))
                .and_then(|p| self.rpc_spawn(p)),
            "write" => serde_json::from_value::<WriteParams>(req.params)
                .map_err(|e| format!("invalid write params: {e}"))
                .and_then(|p| self.rpc_write(p)),
            "signal" => serde_json::from_value::<SignalParams>(req.params)
                .map_err(|e| format!("invalid signal params: {e}"))
                .and_then(|p| self.rpc_signal(p)),
            "kill" => serde_json::from_value::<IdParams>(req.params)
                .map_err(|e| format!("invalid kill params: {e}"))
                .and_then(|p| self.rpc_kill(p)),
            "output" => serde_json::from_value::<IdParams>(req.params)
                .map_err(|e| format!("invalid output params: {e}"))
                .and_then(|p| self.rpc_output(p)),
            "remove" => serde_json::from_value::<RemoveParams>(req.params)
                .map_err(|e| format!("invalid remove params: {e}"))
                .and_then(|p| self.rpc_remove(p)),
            "shutdown" => serde_json::from_value::<ShutdownParams>(req.params)
                .map_err(|e| format!("invalid shutdown params: {e}"))
                .and_then(|p| self.rpc_shutdown(p)),
            other => Err(format!("unknown method: {other}")),
        };
        match result {
            Ok(val) => Response {
                id: req.id,
                result: Some(val),
                error: None,
            },
            Err(message) => Response {
                id: req.id,
                result: None,
                error: Some(RpcError {
                    code: -32000,
                    message,
                }),
            },
        }
    }

    fn rpc_list(&self) -> Result<Value, String> {
        let guard = self.processes.lock().unwrap();
        let list: Vec<ProcessSummary> = guard.values().map(ManagedProcess::summary).collect();
        Ok(json!({ "processes": list }))
    }

    fn rpc_spawn(self: &Arc<Self>, params: SpawnParams) -> Result<Value, String> {
        if params.command.is_empty() {
            return Err("command must not be empty".into());
        }
        {
            let mut guard = self.processes.lock().unwrap();
            if let Some(existing) = guard.get_mut(&params.id) {
                if existing.exit.is_none() {
                    if !params.replace {
                        return Err(format!("process '{}' is already running", params.id));
                    }
                    if let Some(tree) = existing.tree.take() {
                        tree.kill();
                    }
                    existing.stdin_tx = None;
                }
                guard.remove(&params.id);
            }
        }

        let mut cmd = Command::new(&params.command[0]);
        cmd.args(&params.command[1..]);
        if let Some(cwd) = &params.cwd {
            cmd.current_dir(cwd);
        }
        if !params.env.is_empty() {
            cmd.env_clear();
            cmd.envs(&params.env);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn '{}': {e}", params.command[0]))?;
        let pid = child.id().ok_or("spawned process has no PID")?;
        let tree = ProcessTreeHandle::attach(pid);
        let started_at = now_ms();

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        if let Some(stdin) = stdin {
            tokio::spawn(pump_stdin(stdin, stdin_rx));
        }

        let id = params.id.clone();
        let summary = {
            let mut guard = self.processes.lock().unwrap();
            let proc = ManagedProcess {
                id: id.clone(),
                pid,
                started_at,
                stdin_tx: Some(stdin_tx),
                tree: Some(tree),
                exit: None,
                ring: RingBuffer::new(params.ring_buffer_bytes.unwrap_or(DEFAULT_RING_BYTES)),
            };
            let summary = proc.summary();
            guard.insert(id.clone(), proc);
            summary
        };

        if let Some(stdout) = stdout {
            tokio::spawn(pump_output(Arc::clone(self), id.clone(), "stdout", stdout));
        }
        if let Some(stderr) = stderr {
            tokio::spawn(pump_output(Arc::clone(self), id.clone(), "stderr", stderr));
        }
        tokio::spawn(watch_exit(Arc::clone(self), id, pid, child));

        Ok(serde_json::to_value(summary).unwrap())
    }

    fn rpc_write(&self, params: WriteParams) -> Result<Value, String> {
        let data = decode_base64(&params.data_base64)?;
        let guard = self.processes.lock().unwrap();
        let proc = guard
            .get(&params.id)
            .ok_or_else(|| format!("unknown process '{}'", params.id))?;
        let tx = proc
            .stdin_tx
            .as_ref()
            .ok_or_else(|| format!("process '{}' stdin is closed", params.id))?;
        tx.send(data)
            .map_err(|_| format!("process '{}' stdin is closed", params.id))?;
        Ok(json!({}))
    }

    fn rpc_signal(&self, params: SignalParams) -> Result<Value, String> {
        let guard = self.processes.lock().unwrap();
        let proc = guard
            .get(&params.id)
            .ok_or_else(|| format!("unknown process '{}'", params.id))?;
        if let Some(tree) = &proc.tree {
            tree.signal(&params.signal);
        }
        Ok(json!({}))
    }

    fn rpc_kill(&self, params: IdParams) -> Result<Value, String> {
        let mut guard = self.processes.lock().unwrap();
        let proc = guard
            .get_mut(&params.id)
            .ok_or_else(|| format!("unknown process '{}'", params.id))?;
        proc.stdin_tx = None;
        if let Some(tree) = proc.tree.take() {
            tree.kill();
            drop(tree);
        }
        Ok(json!({}))
    }

    fn rpc_output(&self, params: IdParams) -> Result<Value, String> {
        let guard = self.processes.lock().unwrap();
        let proc = guard
            .get(&params.id)
            .ok_or_else(|| format!("unknown process '{}'", params.id))?;
        Ok(json!({ "chunks": proc.ring.snapshot() }))
    }

    fn rpc_remove(&self, params: RemoveParams) -> Result<Value, String> {
        let mut guard = self.processes.lock().unwrap();
        if let Some(proc) = guard.get_mut(&params.id) {
            if proc.exit.is_none() {
                if !params.force {
                    return Err(format!("process '{}' is still running", params.id));
                }
                if let Some(tree) = proc.tree.take() {
                    tree.kill();
                }
            }
            guard.remove(&params.id);
        }
        Ok(json!({}))
    }

    fn rpc_shutdown(&self, params: ShutdownParams) -> Result<Value, String> {
        if params.kill_children {
            let mut guard = self.processes.lock().unwrap();
            for proc in guard.values_mut() {
                proc.stdin_tx = None;
                if let Some(tree) = proc.tree.take() {
                    tree.kill();
                    drop(tree);
                }
            }
            guard.clear();
        }
        self.shutdown_notify.notify_waiters();
        Ok(json!({}))
    }
}

async fn pump_stdin(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(data) = rx.recv().await {
        if stdin.write_all(&data).await.is_err() {
            break;
        }
        let _ = stdin.flush().await;
    }
}

async fn pump_output<R: AsyncRead + Unpin>(
    state: Arc<HostState>,
    id: String,
    stream: &'static str,
    mut reader: R,
) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let slice = &buf[..n];
                let data_base64 = encode_base64(slice);
                {
                    let mut guard = state.processes.lock().unwrap();
                    if let Some(proc) = guard.get_mut(&id) {
                        proc.ring.push(stream, slice);
                    }
                }
                let _ = state.events.send(Notification {
                    method: "output",
                    params: json!({
                        "id": id,
                        "stream": stream,
                        "dataBase64": data_base64,
                    }),
                });
            }
        }
    }
}

async fn watch_exit(state: Arc<HostState>, id: String, pid: u32, mut child: tokio::process::Child) {
    let status = child.wait().await;
    let (code, signal) = match status {
        Ok(st) => {
            #[cfg(unix)]
            let sig = {
                use std::os::unix::process::ExitStatusExt;
                st.signal().map(|s| format!("SIG{s}"))
            };
            #[cfg(not(unix))]
            let sig: Option<String> = None;
            (st.code(), sig)
        }
        Err(_) => (None, None),
    };
    let summary = ExitSummary {
        code,
        signal,
        exited_at: now_ms(),
    };
    {
        let mut guard = state.processes.lock().unwrap();
        if let Some(proc) = guard.get_mut(&id) {
            if proc.pid == pid {
                proc.stdin_tx = None;
                // Dropping the Job Object handle kills any orphaned descendants immediately.
                proc.tree = None;
                proc.exit = Some(summary.clone());
            }
        }
    }
    let _ = state.events.send(Notification {
        method: "exit",
        params: json!({
            "id": id,
            "pid": pid,
            "code": summary.code,
            "signal": summary.signal,
            "exitedAt": summary.exited_at,
        }),
    });
}

async fn serve_connection<S>(state: Arc<HostState>, stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut lines = BufReader::new(reader).lines();

    // First message must authenticate with `hello`.
    let Ok(Some(first_line)) = lines.next_line().await else {
        return;
    };
    let Ok(req) = serde_json::from_str::<Request>(&first_line) else {
        return;
    };
    let auth_ok = req.method == "hello"
        && serde_json::from_value::<HelloParams>(req.params)
            .map(|p| p.token == state.token)
            .unwrap_or(false);
    let resp = if auth_ok {
        Response {
            id: req.id,
            result: Some(json!({
                "pid": std::process::id(),
                "version": PROTOCOL_VERSION,
            })),
            error: None,
        }
    } else {
        Response {
            id: req.id,
            result: None,
            error: Some(RpcError {
                code: -32001,
                message: "unauthorized".into(),
            }),
        }
    };
    let mut line = serde_json::to_string(&resp).unwrap();
    line.push('\n');
    if writer.write_all(line.as_bytes()).await.is_err() {
        return;
    }
    if !auth_ok {
        return;
    }

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer_task = tokio::spawn(async move {
        while let Some(mut msg) = out_rx.recv().await {
            msg.push('\n');
            if writer.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let mut events = state.events.subscribe();
    let event_tx = out_tx.clone();
    let event_task = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(notif) => {
                    if let Ok(text) = serde_json::to_string(&notif) {
                        if event_tx.send(text).is_err() {
                            break;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    while let Ok(Some(raw)) = lines.next_line().await {
        if raw.trim().is_empty() {
            continue;
        }
        let req = match serde_json::from_str::<Request>(&raw) {
            Ok(req) => req,
            Err(e) => {
                let err = Response {
                    id: Value::Null,
                    result: None,
                    error: Some(RpcError {
                        code: -32700,
                        message: format!("parse error: {e}"),
                    }),
                };
                if let Ok(text) = serde_json::to_string(&err) {
                    let _ = out_tx.send(text);
                }
                continue;
            }
        };
        let resp = state.handle_request(req);
        if let Ok(text) = serde_json::to_string(&resp) {
            if out_tx.send(text).is_err() {
                break;
            }
        }
    }

    event_task.abort();
    drop(out_tx);
    let _ = writer_task.await;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_args() -> Result<(String, String), String> {
    let mut args = std::env::args().skip(1);
    let mut endpoint: Option<String> = None;
    let mut token: Option<String> = std::env::var("LINKRPC_PROC_HOST_TOKEN").ok();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--endpoint" => {
                endpoint = args.next();
            }
            "--token" => {
                token = args.next();
            }
            "--help" | "-h" => {
                return Err(
                    "Usage: linkrpc-proc-host --endpoint <pipe-or-unix-path> [--token <secret>]"
                        .into(),
                );
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    let endpoint = endpoint.ok_or("missing --endpoint")?;
    let token = token.ok_or("missing --token or LINKRPC_PROC_HOST_TOKEN")?;
    Ok((endpoint, token))
}

#[cfg(windows)]
async fn run_server(endpoint: &str, state: Arc<HostState>) -> Result<(), String> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = endpoint.strip_prefix("npipe:").unwrap_or(endpoint);
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(pipe_name)
        .map_err(|e| format!("failed to create named pipe '{pipe_name}': {e}"))?;

    loop {
        tokio::select! {
            _ = state.shutdown_notify.notified() => break,
            res = server.connect() => {
                match res {
                    Ok(()) => {
                        let connected = server;
                        server = ServerOptions::new()
                            .create(pipe_name)
                            .map_err(|e| format!("failed to recreate named pipe '{pipe_name}': {e}"))?;
                        let st = Arc::clone(&state);
                        tokio::spawn(serve_connection(st, connected));
                    }
                    Err(e) => return Err(format!("pipe accept error: {e}")),
                }
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn run_server(endpoint: &str, state: Arc<HostState>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let sock_path = endpoint.strip_prefix("unix:").unwrap_or(endpoint);
    let _ = std::fs::remove_file(sock_path);
    let listener = UnixListener::bind(sock_path)
        .map_err(|e| format!("failed to bind unix socket '{sock_path}': {e}"))?;
    let _ = std::fs::set_permissions(sock_path, std::fs::Permissions::from_mode(0o600));

    loop {
        tokio::select! {
            _ = state.shutdown_notify.notified() => break,
            res = listener.accept() => {
                match res {
                    Ok((stream, _)) => {
                        let st = Arc::clone(&state);
                        tokio::spawn(serve_connection(st, stream));
                    }
                    Err(e) => return Err(format!("unix accept error: {e}")),
                }
            }
        }
    }
    let _ = std::fs::remove_file(sock_path);
    Ok(())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let (endpoint, token) = match parse_args() {
        Ok(v) => v,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    };
    let state = HostState::new(token);
    if let Err(err) = run_server(&endpoint, state).await {
        eprintln!("linkrpc-proc-host: {err}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        for sample in [
            b"".as_slice(),
            b"a",
            b"ab",
            b"abc",
            b"hello world!\n\x00\xff",
        ] {
            let enc = encode_base64(sample);
            let dec = decode_base64(&enc).unwrap();
            assert_eq!(dec, sample);
        }
    }

    #[tokio::test]
    async fn spawns_streams_output_and_kills_process_tree() {
        let state = HostState::new("secret".into());
        #[cfg(windows)]
        let command = vec![
            "cmd.exe".to_string(),
            "/c".to_string(),
            "echo hello-proc-host".to_string(),
        ];
        #[cfg(unix)]
        let command = vec![
            "sh".to_string(),
            "-c".to_string(),
            "echo hello-proc-host".to_string(),
        ];

        let mut events = state.events.subscribe();
        let spawned = state
            .rpc_spawn(SpawnParams {
                id: "svc-1".into(),
                command,
                cwd: None,
                env: BTreeMap::new(),
                replace: false,
                ring_buffer_bytes: None,
            })
            .unwrap();
        assert_eq!(spawned["id"], "svc-1");
        assert!(spawned["pid"].as_u64().unwrap() > 0);

        // Wait for exit event.
        let mut saw_exit = false;
        for _ in 0..20 {
            if let Ok(Ok(notif)) =
                tokio::time::timeout(std::time::Duration::from_secs(5), events.recv()).await
            {
                if notif.method == "exit" && notif.params["id"] == "svc-1" {
                    assert_eq!(notif.params["code"], 0);
                    saw_exit = true;
                    break;
                }
            }
        }
        assert!(saw_exit, "expected exit notification");

        let out = state.rpc_output(IdParams { id: "svc-1".into() }).unwrap();
        let chunks = out["chunks"].as_array().unwrap();
        let text: String = chunks
            .iter()
            .filter_map(|c| c["dataBase64"].as_str())
            .map(|b64| String::from_utf8_lossy(&decode_base64(b64).unwrap()).into_owned())
            .collect();
        assert!(text.contains("hello-proc-host"), "got output: {text:?}");
    }
}
