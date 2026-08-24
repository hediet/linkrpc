# Rename `$hubrpc` to `$linkrpc`

The signed-call metadata key is currently `$hubrpc` for compatibility with
existing HubRPC peers.

In a future breaking protocol version, rename this key to `$linkrpc`. The
`$linkrpcSignature` and `$linkrpcUnsigned` keys are not part of this rename.
