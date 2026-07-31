# Eval Runner

Generic scored evaluations and append-only, evidence-validating function recordings.

The POC command runs two LinkRPC discovery scenarios, each with exactly two domain
interfaces and three `llmSeed` inputs. It invokes the real Copilot CLI against a
loopback LinkRPC MCP server. Before reusing a recording, it replays the complete
ordered MCP tool transcript in a fresh session and compares every result.

```sh
pnpm start linkrpc-explore
```

Use `--scenario <id>`, `--seed <number>`, or `--model <id>` for a focused run.
The default model matrix is `claude-haiku-4.5`, `gpt-5.4-mini`, and
`gpt-5.6-luna`.

Every output records the raw Copilot CLI usage summary and normalized metrics.
`metrics.costUnit` identifies whether `metrics.cost` is measured in AI credits
or legacy premium requests. Recordings default to
`.eval-recordings/linkrpc-explore` and are never overwritten.
