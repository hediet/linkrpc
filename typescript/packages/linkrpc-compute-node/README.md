# @hediet/linkrpc-compute-node

A LinkRPC service that gives remote access to this machine through the
[`linkrpc.computeNode.*` interfaces](../linkrpc-infra/README.md#compute-nodes):
shell commands (with streamed output and stdin), the file system, HTTP requests
to local ports, and TCP forwarding.

Run it as a [hub daemon](../linkrpc-hub-daemon/README.md) service:

```jsonc
"services": {
    "compute": { "command": ["node", "/path/to/linkrpc-compute-node/dist/cli.js"] }
}
```

It connects to `LINKRPC_ENDPOINT` and registers under the service ID the hub
grants, here `<hubServiceId>/compute`:

```sh
linkrpc hub call '<hubServiceId>/compute::linkrpc.computeNode.command::run' --params '{"command":"hostname"}'
```

It acts with the full rights of the OS user. Only run it on hubs that admit
trusted principals, e.g. with `forwardChecking` and your own identities in
`rootPrincipalIds`.

`hostComputeNode()` (the package entry) starts the same service in-process.
