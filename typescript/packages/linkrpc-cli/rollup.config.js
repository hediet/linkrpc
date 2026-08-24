import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import dts from 'rollup-plugin-dts';

/**
 * Externals: Node builtins + every bare specifier resolve from node_modules
 * at run time — same policy as the previous esbuild build. The exceptions are
 * `@vscode/observables` and `@hediet/linkrpc-client`, which are bundled into
 * the output because the client helpers are a private, source-only workspace
 * package and must not be referenced at run time.
 */
const external = (id) => {
    if (id === '@vscode/observables' || id.startsWith('@vscode/observables/')) {
        return false;
    }
    // Bundled: the shared hub-client primitives live in a private, source-only
    // workspace package, so they must not be referenced at run time.
    if (id === '@hediet/linkrpc-client' || id.startsWith('@hediet/linkrpc-client/')) {
        return false;
    }
    if (
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('\0') &&
        !/^[a-zA-Z]:/.test(id)
    ) {
        return true;
    }
    return false;
};

const plugins = () => [
    resolve({ extensions: ['.mjs', '.js', '.json', '.node', '.ts'] }),
    typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
        noEmit: false,
        exclude: ['**/*.test.ts', 'build.ts'],
        include: [
            'src/**/*.ts',
            'src/**/*.tsx',
            '../../packages-private/linkrpc-client/src/**/*.ts',
        ],
    }),
];

/**
 * Silence bundler noise from third-party dependencies we don't control
 * (e.g. `zod`'s internal circular imports). Warnings from our own `src/`
 * still surface.
 */
const onwarn = (warning, warn) => {
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

/** @type {import('rollup').RollupOptions[]} */
export default [
    {
        input: { index: 'src/index.ts' },
        output: {
            dir: 'dist',
            format: 'esm',
            sourcemap: true,
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
        },
        external,
        onwarn,
        plugins: plugins(),
    },
    {
        input: { cli: 'src/cli.ts' },
        output: {
            dir: 'dist',
            format: 'esm',
            sourcemap: true,
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
            // Shebang only on the CLI — a shebang in an imported module is a
            // syntax error.
            banner: '#!/usr/bin/env node',
        },
        external,
        onwarn,
        plugins: plugins(),
    },
    {
        // Type declarations for the package entry (`types` → dist/index.d.ts).
        // A dedicated dts pass bundles the .d.ts so the source-only workspace
        // deps that are inlined into the JS build are inlined here too, rather
        // than left as unresolved external imports in the emitted types.
        input: { index: 'src/index.ts' },
        output: {
            dir: 'dist',
            format: 'esm',
            entryFileNames: '[name].d.ts',
            chunkFileNames: 'chunks/[name]-[hash].d.ts',
        },
        external,
        onwarn,
        plugins: [dts()],
    },
];
