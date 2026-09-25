# Package artifacts and releases

GitHub Actions produces artifacts only. **ArtifactGate is the only registry
publisher**; CI has no npm or Cargo registry credentials.

## Safe rollout

Use one active owner-wide ArtifactGate ingestion pipeline per artifact type
(npm, Cargo, and VSIX) for all `hediet` repositories. Keep the corresponding
asset-name filters (`npm-*`, `cargo-crate-*`, and `*.vsix`), but no repository,
workflow, or branch restrictions. Restrict publication in package-specific
rules, not duplicate repository-specific ingestion pipelines.
Preserve ingestion history by disabling
redundant pipelines when they cannot be deleted because artifacts reference them.

Before pushing the release workflow, enable ArtifactGate's Cargo dependency gate.
Set npm's `npmTagSource` to `package-json` and Cargo's `waitForDependencies` to
`true`; npm needs no dependency gate. Publication rules must accept only
successful, trusted `main` runs.

During rollout, keep owner-wide ingestion broad and use the LinkRPC
publication-rule regexp `^\.github/workflows/(package-artifacts|release)\.yml$`.
This keeps the current publisher working until the new workflow is active.
After verifying a successful release, narrow the LinkRPC publication rules to
`.github/workflows/release.yml`, without narrowing shared ingestion. Do not switch
away from the current workflow before its replacement is available.

The candidate workflow emits only `candidate-packages`; publication rules must
exclude that artifact even if shared ingestion discovers it. Do not manually
publish candidates or backfill historical artifacts during rollout.

### Bootstrap already-published stable versions

Before activation, confirm the published registry versions and their successful
source runs, then initialize annotated completion tags for those bases:

| Completion tag | Successful source SHA | Packages run |
| --- | --- | --- |
| `npm/v0.0.1` | `44f8427ac89ed244983c3cb70c78794bef2f6cf2` | `35387798620` |
| `cargo/linkrpc/v0.1.1` | `1dc26fdbffefc61c1b8b741307dfb462958a389b` | `35392158401` |
| `cargo/linkrpc-macros/v0.1.1` | `1dc26fdbffefc61c1b8b741307dfb462958a389b` | `35392158401` |
| `cargo/linkrpc-tokio/v0.1.1` | `1dc26fdbffefc61c1b8b741307dfb462958a389b` | `35392158401` |

The tag points to the source run's commit. Its JSON annotation contains
`ecosystem`, `version`, `sha`, and numeric `runId`; Cargo additionally contains
`package` with the exact crate name. Create only absent references. Verify the
commit and annotation of an existing tag rather than overwriting it. Bootstrap
does not need candidate reservation tags.

Keep older `cargo/{crate}/v0.1.0` markers untouched. The workflow does not consume
an ecosystem-wide `cargo/v0.1.0` marker. The committed bases have since advanced
to npm 0.0.2 and Cargo 0.2.1, so their first successful release generates stable
and next artifacts. If either base was already published before activation,
bootstrap it from its verified source run as well. ArtifactGate's skip-existing
policy is the final safeguard against republishing an existing version.

`package-artifacts.yml` (workflow **Packages**) checks Rust formatting, clippy,
workspace tests, TypeScript build/tests/guest typechecking, conformance vectors,
and release-tool tests, all at one commit. Only then does it upload
`candidate-packages`. PRs may create that artifact, but its name does not match
the previous publication patterns. Its npm packages also have `private: true`.

`release.yml` (workflow **Release packages**) is triggered by completion of
Packages, and accepts only successful same-repository `main` push or manual
builds. It checks out the source run's exact commit and independently validates
the source run through the GitHub API before downloading any candidates.
Candidate manifest/VCS provenance must match that commit. A failed check never
produces publication artifacts.

## Versions and immutable reservations

The five npm packages share the committed base version **0.0.3**. The Rust
crates `linkrpc-macros`, `linkrpc`, and `linkrpc-tokio` share **0.3.0**.
The examples remain unpublished and are not packaged.

These bases add static endpoint contracts, typed root/service/default/bare
bindings, contract export and generation in the CLI, and shared Rust component
generation. Consumers of generated bindings must upgrade the runtime library
alongside their generator.

Every source CI run reserves one annotated tag `next-builds/YYYYMMDD/N`. The
date is the source run's UTC creation date, not the retry date. Its message
records the run ID, commit, both bases and suffix. Atomic reference creation
resolves contention; a retry of the same run reuses its reservation. Both
ecosystems use the **same** `next.YYYYMMDD.N` suffix, e.g.
`0.0.3-next.20260920.1` and `0.3.0-next.20260920.1`.

Stable candidates are independently reserved at
`release-candidates/npm/v0.0.3` and `release-candidates/cargo/{crate}/v0.3.0`.
Cargo reservations are per crate so adding an unpublished crate cannot change
the recorded source identity of an already-published stable version.
Reservations are created before packing and never moved. Until all artifact
uploads succeed, a retry or later run can recover the original candidate's
artifacts and revalidate its successful trusted CI run. After upload, immutable
completion tags `npm/v0.0.3` and `cargo/{crate}/v0.3.0` suppress future stable
generation for those package/base combinations. These tags mean **artifacts generated**, not registry
publication confirmed. Registry availability/retries remain ArtifactGate's
responsibility. Bump committed bases intentionally for a new stable release.

The release concurrency group serializes normal runs, while atomic reservations
also defend against competing clients. Candidate artifacts are retained for 90
days; a failed stable candidate must be recovered before expiration. Missing or
expired reserved candidates fail closed: do not delete/move reservation tags to
silently substitute another commit. Finish recovery before changing base versions.

## ArtifactGate contract

Final workflow path: **`.github/workflows/release.yml`**.

| Ecosystem | Artifact name | Files inside |
| --- | --- | --- |
| npm | `npm-{next,stable}-{package}` | one `*.tgz` |
| Cargo | `cargo-crate-{next,stable}-{crate}` | one `*.crate` |

npm package keys: `linkrpc`, `linkrpc-infra`, `linkrpc-hub`, `linkrpc-cli`,
`linkrpc-mcp` (all scoped `@hediet/`). Cargo crate keys: `linkrpc-macros`,
`linkrpc`, `linkrpc-tokio`.

Workspace output paths are
`artifacts/release/npm-{next,stable}-{package}/*.tgz` and
`artifacts/release/cargo-crate-{next,stable}-{crate}/*.crate`.
Use publication rules selecting **`npm-*`** and **`cargo-crate-*`** only from this
repository's final release workflow; shared owner-wide ingestion stays broad.
Each artifact contains exactly one publishable archive.
Repeated workflow attempts overwrite same-run upload artifacts; reserved
versions and source identity do not change.

The generated npm manifests set `publishConfig.tag` to `next` or `latest`,
preserving other `publishConfig` fields. Internal dependencies, optional
dependencies, peers (including the required infra peer), and development
dependencies use the matching generated version. No workspace references
remain. npm publication does not require dependency ordering.

Cargo candidates come from `cargo package --locked --exclude-lockfile`;
`linkrpc` and `linkrpc-tokio` use `--no-verify` because their generated internal
dependencies may not yet exist in the registry.
Release repacking retains the original Cargo file set, `Cargo.toml.orig`, and
`.cargo_vcs_info.json`; only the normalized manifest and archive root/version
change. Archive timestamps and owner metadata are normalized so retries of a
reserved release produce identical bytes. The normalized manifest has no workspace/path dependencies and pins
all generated prerelease internal requirements exactly, e.g.
`=0.3.0-next.20260920.1`, including target-specific, renamed, build, and dev
dependencies. ArtifactGate must wait for dependencies to be available in the
Cargo registry index: `linkrpc-macros` before `linkrpc`, and `linkrpc` before
`linkrpc-tokio` (for both channels). Upload order is not itself a dependency gate.

## Local validation

From `scripts`, run `npm ci --ignore-scripts` and `npm test`. Tests cover
reservations, retry and concurrent identities, stable recovery/once-only
completion, trust gates, actual npm tarballs, and normalized crate archives.
Run `corepack pnpm check` in `typescript`, and `cargo fmt --all -- --check`,
`cargo clippy --workspace --all-targets -- -D warnings`, and
`cargo test --workspace --locked` in `rust`.

No release command should be run with a GitHub write token locally just to
test packing: use the pure packing helpers and tests instead. Production
candidate creation requires a clean checkout at `GITHUB_SHA`.
