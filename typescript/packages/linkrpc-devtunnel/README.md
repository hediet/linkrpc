# @hediet/linkrpc-devtunnel

Connects the LinkRPC hubs on your machines through private
[Dev Tunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/), signed
in with your Microsoft account. Machines may come and go; each hub reaches the
hubs that are currently online.

## Setup

Give every hub an ID under one shared namespace, and run `linkrpc-devtunnel` as
a [hub daemon](../linkrpc-hub-daemon/README.md) service whose `serviceId` is
that namespace:

```jsonc
{
    "hubServiceId": "me/pc",          // "me/laptop", "me/devbox", ...
    "services": {
        "devtunnel": {
            "command": ["node", "/path/to/linkrpc-devtunnel/dist/cli.js"],
            "serviceId": "me"
        }
    }
}
```

Sign in once per machine with the Azure CLI: `az login`. The service gets Dev
Tunnels tokens with `az account get-access-token`; no app registration is
needed. Pass `--azure-cli <path>` if `az` is not on the service's `PATH`.

A call to `me/laptop/...` on the PC then reaches the laptop's hub, and
`linkrpc hub ls` on any machine lists the services of all online hubs:

```sh
linkrpc hub ls
linkrpc hub call 'me/laptop/compute::linkrpc.computeNode.command::run' --params '{"command":"hostname"}'
```

(`me/laptop/compute` being a [compute node](../linkrpc-compute-node/README.md)
service on the laptop.) A hub drops off while its machine sleeps; to keep the
laptop reachable while you work with it remotely, hold a
[keep-awake call](../linkrpc-compute-node/README.md#keeping-the-machine-awake)
open on its compute node.

## How it works

- **Hosting.** The service hosts a private tunnel for its hub (label
  `linkrpc-hub`, the hub ID as description), creating it on first start. Each
  incoming tunnel connection is piped into the hub's application endpoint
  (from the daemon's discovery file, or `--hub-endpoint`), so a remote hub's
  traffic enters like a local application's.
- **Connecting.** Every 30 seconds it lists the account's `linkrpc-hub`
  tunnels. For each online peer it opens a tunnel connection to the peer's hub
  and a connection to the local hub on which it claims the peer's hub ID. That
  claim lies inside the service's granted namespace, so it needs no
  capability. Every call routed to the claim is forwarded verbatim, like
  `linkrpc hub tunnel`: the caller's signature travels with the call, and the
  peer hub checks it. Streams and cancellation are bridged. Lost links
  reconnect; a peer that goes offline releases its claim.
- **Reconnecting.** A link that dies silently (the machine slept, the network
  changed) is noticed by keep-alives: after three unanswered pings, 15 seconds
  apart, the link closes and reconnects. Connection attempts and tunnel
  listings give up after 60 seconds and are retried, as are hung `az` calls,
  so the mesh recovers on its own once the network is back.
- Peers outside the granted namespace are skipped.

## Security

- Tunnels are owner-only: only your Microsoft account can host or connect, and
  the tunnel encrypts traffic end to end.
- A remote hub is admitted like a local application. With `forwardChecking`,
  every hub checks the calls entering it, so list the CLI identities of all
  your machines in each hub's `rootPrincipalIds`.
- The hub's application endpoint must not require a token; remote hubs cannot
  present one.

Options: `--no-host`, `--no-connect`, `--azure-cli <path>`,
`--hub-endpoint <path>`, `--discovery-interval <seconds>`.
