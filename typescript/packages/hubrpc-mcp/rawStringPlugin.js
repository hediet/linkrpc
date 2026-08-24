import fs from "node:fs";

const RAW_SUFFIX = "?raw";

/**
 * Rollup plugin implementing Vite-style `import text from "./file?raw"` so a
 * file's raw contents can be embedded as a string. Vitest gets this natively
 * from Vite; this brings the same behaviour to the rollup build. Used so the
 * `connection.d.ts` doc resource lives as a real TypeScript declaration file
 * (single source of truth) instead of an escaped template literal.
 *
 * @returns {import('rollup').Plugin}
 */
export function rawString() {
    return {
        name: "raw-string",
        async resolveId(source, importer) {
            if (!source.endsWith(RAW_SUFFIX)) {
                return null;
            }
            const bare = source.slice(0, -RAW_SUFFIX.length);
            const resolved = await this.resolve(bare, importer, { skipSelf: true });
            if (!resolved) {
                return null;
            }
            return resolved.id + RAW_SUFFIX;
        },
        load(id) {
            if (!id.endsWith(RAW_SUFFIX)) {
                return null;
            }
            const file = id.slice(0, -RAW_SUFFIX.length);
            const code = fs.readFileSync(file, "utf8");
            this.addWatchFile(file);
            return {
                code: `export default ${JSON.stringify(code)};`,
                map: { mappings: "" },
            };
        },
    };
}
