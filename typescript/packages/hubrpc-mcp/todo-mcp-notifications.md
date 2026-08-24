# TODO: MCP notifications for parked script logs

`runHubRpcScript` uses `console.log` as the script-facing progress API. Logs are
stored on the sandbox task and returned by `runHubRpcScript` or
`awaitHubRpcTask`. Stream messages are logged automatically when a
`con.call` does not provide `onStreamMessage`.

Expose these logs live through MCP notifications without making notification
delivery the only way the language model can observe them.

## MCP progress notifications

When the client supplies `_meta.progressToken`, a tool handler can send:

```ts
await extra.sendNotification({
    method: "notifications/progress",
    params: {
        progressToken: extra._meta.progressToken,
        progress: sequence,
        message: log.text,
    },
});
```

Use a monotonically increasing log sequence as `progress`; omit `total` for
unbounded streams.

A progress token belongs to one active MCP request. It must not be used after
that request returns. Consequently:

- `runHubRpcScript` can report logs produced during its foreground phase.
- Once `runHubRpcScript` returns a parked task, its progress stream is over.
- `awaitHubRpcTask` should report logs produced while that await request is
  active. A later await call uses its own progress token.

Do not keep `runHubRpcScript` open indefinitely merely to preserve its progress
token. Parking exists to avoid client and tool-call timeouts.

## MCP logging notifications

MCP `notifications/message` can carry connection-level diagnostic messages
after the original tool call has returned:

```ts
await server.sendLoggingMessage({
    level: "info",
    data: {
        taskId,
        sequence,
        text: log.text,
    },
});
```

This may be useful for human-facing output panels, but clients can filter or
hide logging notifications and are not required to add them to model context.
Treat this as an optional diagnostic mirror, not as reliable task output.

## Proposed design

Keep `console.log` as the only general script-to-host logging API:

1. Store every accepted log on its parked task.
2. Add a task-log subscription that emits each accepted log with a stable,
   monotonically increasing sequence number.
3. While `runHubRpcScript` or `awaitHubRpcTask` has an active progress token,
   mirror new logs through `notifications/progress`.
4. Continue returning logs in tool results so the language model can consume
   them even when the MCP client does not expose notifications.
5. Optionally mirror logs through `notifications/message` for human
   diagnostics.

Add a cursor to `awaitHubRpcTask`, for example:

```ts
{
    taskId: string;
    timeoutMs?: number;
    afterLogSequence?: number;
}
```

Its result should include only newer logs and return the next cursor:

```ts
{
    status: "running";
    taskId: string;
    logs: SandboxLog[];
    nextLogSequence: number;
}
```

This prevents a long-running traffic watch from returning its complete log
history on every poll.

## Reliability and flow control

- Preserve logs in tool results even if progress notification delivery fails.
- Do not let notification sends block the QuickJS pump or HubRPC stream
  callback.
- Use a bounded log buffer and explicit overflow records for high-volume
  streams such as traffic watching.
- Bound notification message size independently from the retained task log.
- Coalesce or rate-limit progress notifications when a client cannot keep up.
- Keep task IDs and sequence numbers in diagnostic logging notifications so
  concurrent or retained tasks can be correlated.
- Stop per-request progress subscriptions when the MCP request completes or is
  cancelled.
- Do not cancel the parked task merely because an `awaitHubRpcTask` request is
  cancelled or times out.

## Validation

- A foreground script log is delivered through progress and in the final tool
  result.
- A parked traffic watch delivers new logs during `awaitHubRpcTask`.
- A second await with a cursor does not repeat earlier logs.
- Clients that omit `progressToken` continue to receive logs in tool results.
- Notification failure does not fail or cancel the script.
- High-volume logging is bounded and reports dropped entries.
- Cancelling an await removes only its progress subscription.
- Cancelling the task stops stream callbacks and all later notifications.
