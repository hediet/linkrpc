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
