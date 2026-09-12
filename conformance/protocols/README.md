# Pinned protocol corpora

These files are build/test inputs. Tests never download protocol definitions.

| Directory | Upstream | Pin | Files |
|---|---|---|---|
| `cdp-0.0.1677763` | [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol) | npm `devtools-protocol@0.0.1677763` | `json/browser_protocol.json`, `json/js_protocol.json` |
| `lsp-3.17.5` | [microsoft/vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node) | tag `release/protocol/3.17.5`, commit `4f782ceac1b4444d335a32561bda0ded305c401e` | `protocol/metaModel.json` |

Each directory contains its upstream license. `manifest.json` is a derived,
reviewable pin containing source SHA-256 digests and expected importer totals.
