# LinkRPC conformance

This directory contains language-neutral fixtures, generators, malformed-input
cases, canonicalization vectors, signatures, capabilities, and behavioral
scenarios shared by every implementation.

To regenerate the vectors, first build the TypeScript workspace:

```sh
cd ../typescript
pnpm install --frozen-lockfile
pnpm build
```

Then run the generators:

```sh
cd ../conformance/generate
npm run gen
```

Schema-normalization vectors call the built TypeScript normalizer directly.
They cover lowering producer type arrays to wire `anyOf` unions; the Rust
conformance tests consume the same fixtures to verify normalization and hashes.
