import type { Plugin } from 'rolldown';
import { defineConfig } from 'tsdown';

const banner = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/`;

/**
 * `@hpke/common` (pulled in via `@hpke/core`) has a Node <= 18 fallback that
 * does `await import("crypto")` when `globalThis.crypto` is missing. That bare
 * `crypto` specifier is dead code in every runtime we target (browsers and
 * Node >= 19 always provide `globalThis.crypto`), but it trips bundlers that
 * disallow bare Node-builtin specifiers (e.g. the app-packager capture). Inline
 * it as an empty module so the offending import disappears from dist/.
 */
const emptyCryptoFallback = (): Plugin => {
    const VIRTUAL = '\0empty-crypto';
    return {
        name: 'empty-crypto-fallback',
        resolveId(id) {
            return id === 'crypto' ? VIRTUAL : null;
        },
        load(id) {
            return id === VIRTUAL ? 'export const webcrypto = undefined;\nexport default {};\n' : null;
        },
    };
};

/**
 * Silence bundler noise originating from third-party dependencies we don't
 * control (e.g. `@hpke/*` `@__PURE__` comment placement and `this`-rewrites,
 * `zod`'s internal circular imports). Warnings from our own `src/` still surface.
 */
const onwarn: NonNullable<import('rolldown').InputOptions['onwarn']> = (warning, warn) => {
    const fromDeps =
        (warning.id ?? '').includes('node_modules') ||
        (warning.ids ?? []).some((id) => id.includes('node_modules')) ||
        (warning.loc?.file ?? '').includes('node_modules') ||
        (warning.message ?? '').includes('node_modules');
    if (
        fromDeps &&
        (warning.code === 'CIRCULAR_DEPENDENCY' ||
            warning.code === 'THIS_IS_UNDEFINED' ||
            warning.code === 'INVALID_ANNOTATION')
    ) {
        return;
    }
    warn(warning);
};

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'node': 'src/node.ts',
        'web': 'src/web.ts',
        'hub/common/index': 'src/hub/common/index.ts',
        'hub/client/index': 'src/hub/client/index.ts',
    },
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    clean: true,
    dts: true,
    // Emit `.js` / `.d.ts` (the package is `"type": "module"`) so the existing
    // `exports` map in package.json keeps resolving.
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    /**
     * Let tsdown own the `exports` map. `devExports` adds a `@vscode/source`
     * condition pointing at the TypeScript sources so that other workspace
     * packages whose tsconfig sets `customConditions: ["@vscode/source"]`
     * resolve `@hediet/linkrpc` straight to `src/` — giving cross-package
     * go-to-definition / find-all-references in the editor without any
     * `paths` mapping or project references. The published `dist` mapping is
     * emitted into `publishConfig.exports`, so consumers of the npm package
     * (and anything without the custom condition) still resolve to `dist/`.
     */
    exports: {
        devExports: '@vscode/source',
    },
    /**
     * `zod` (a declared `peerDependency`) and `ws` (a runtime `dependency`) are
     * auto-externalized by tsdown, so the consumer's own install provides them
     * — that also avoids the dual-instance hazard for `zod`'s `schema._zod`
     * duck-typing and `.safeParse()` calls on consumer-supplied schemas.
     * `@hpke/core` is a real `dependency` too, but we bundle it (and its
     * transitive `@hpke/common`) so the crypto stack ships self-contained.
     */
    deps: {
        alwaysBundle: ['@hpke/core'],
        // Whitelist exactly what we intend to inline: `@hpke/core` and its
        // transitive `@hpke/common`. Anything else bundled from node_modules
        // (a regression) fails the build instead of silently shipping.
        onlyBundle: ['@hpke/core', '@hpke/common'],
    },
    plugins: [emptyCryptoFallback()],
    outputOptions: {
        banner,
        chunkFileNames: 'chunks/[name]-[hash].js',
    },
    inputOptions(inputOptions) {
        inputOptions.onwarn = onwarn;
        return inputOptions;
    },
});
