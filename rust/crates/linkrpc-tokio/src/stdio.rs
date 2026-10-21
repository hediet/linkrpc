//! `cmd-stdio:` endpoints: spawn a child and speak NDJSON over its stdin/stdout.
//!
//! Spawning mirrors the TS hub's `spawnCommand`: a verbatim `command` runs through the OS shell,
//! `argv` runs directly — except on Windows for binaries that are not `.exe`/`.com` (e.g. npm
//! `.cmd` shims), which need `cmd.exe`. The child's stderr is inherited, no `hubrpc::initialize` handshake is
//! written (the parent owns the child), and the child is killed when the transport is dropped.

use std::collections::BTreeMap;
use std::io;
use std::process::Stdio;

use async_trait::async_trait;
use linkrpc::prelude::{EndpointCommand, JsonRpcMessage, MessageTransport, TransportError};
use tokio::process::{Child, Command};

use crate::ndjson::NdjsonTransport;

/// An [`NdjsonTransport`] over a spawned child's stdio that owns the child process.
pub struct ChildStdioTransport {
    inner: NdjsonTransport,
    _child: Child,
}

impl ChildStdioTransport {
    /// Spawn `command` (with `env` added to the inherited environment) and connect to its stdio.
    pub fn spawn(
        command: &EndpointCommand,
        env: Option<&BTreeMap<String, String>>,
    ) -> io::Result<Self> {
        let mut child = build_command(command)?
            .envs(env.into_iter().flatten())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stdin = child.stdin.take().expect("stdin is piped");
        Ok(ChildStdioTransport {
            inner: NdjsonTransport::new(stdout, stdin),
            _child: child,
        })
    }
}

fn build_command(command: &EndpointCommand) -> io::Result<Command> {
    match command {
        EndpointCommand::Argv(argv) => {
            let (program, args) = argv.split_first().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "cmd-stdio: empty argv command")
            })?;
            if cfg!(windows) && !is_windows_executable(program) {
                return Ok(shell_command(&argv.join(" ")));
            }
            let mut command = Command::new(program);
            command.args(args);
            Ok(command)
        }
        EndpointCommand::Command(line) if line.trim().is_empty() => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cmd-stdio: empty command",
        )),
        EndpointCommand::Command(line) => Ok(shell_command(line)),
    }
}

fn is_windows_executable(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with(".exe") || lower.ends_with(".com")
}

/// Run `line` through the OS shell, like Node's `spawn(..., { shell: true })`.
#[cfg(windows)]
fn shell_command(line: &str) -> Command {
    let mut command = Command::new("cmd.exe");
    command
        .args(["/d", "/s", "/c"])
        .raw_arg(format!("\"{line}\""));
    command
}

#[cfg(not(windows))]
fn shell_command(line: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", line]);
    command
}

#[async_trait]
impl MessageTransport for ChildStdioTransport {
    async fn send(&self, msg: JsonRpcMessage) -> Result<(), TransportError> {
        self.inner.send(msg).await
    }

    async fn recv(&self) -> Option<JsonRpcMessage> {
        self.inner.recv().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn program_and_args(command: &EndpointCommand) -> (String, Vec<String>) {
        let command = build_command(command).unwrap();
        let std = command.as_std();
        (
            std.get_program().to_string_lossy().into_owned(),
            std.get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
        )
    }

    #[test]
    fn executables_in_argv_run_directly() {
        let argv = vec!["node.exe".to_owned(), "a b".to_owned()];
        assert_eq!(
            program_and_args(&EndpointCommand::Argv(argv)),
            ("node.exe".to_owned(), vec!["a b".to_owned()])
        );
    }

    #[cfg(windows)]
    #[test]
    fn shims_and_verbatim_commands_use_the_windows_shell() {
        let shell = |line: &str| {
            (
                "cmd.exe".to_owned(),
                ["/d", "/s", "/c", &format!("\"{line}\"")]
                    .map(str::to_owned)
                    .to_vec(),
            )
        };
        assert_eq!(
            program_and_args(&EndpointCommand::Argv(vec!["linkrpc".into(), "hub".into()])),
            shell("linkrpc hub")
        );
        assert_eq!(
            program_and_args(&EndpointCommand::Command("node s.js".into())),
            shell("node s.js")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn verbatim_commands_use_sh() {
        assert_eq!(
            program_and_args(&EndpointCommand::Command("node s.js".into())),
            (
                "/bin/sh".to_owned(),
                vec!["-c".to_owned(), "node s.js".to_owned()]
            )
        );
    }

    #[test]
    fn empty_commands_are_rejected() {
        for command in [
            EndpointCommand::Command("  ".into()),
            EndpointCommand::Argv(vec![]),
        ] {
            let error = ChildStdioTransport::spawn(&command, None)
                .err()
                .expect("empty command fails");
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        }
    }
}
