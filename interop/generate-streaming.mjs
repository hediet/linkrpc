import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const executable = resolve(root, `rust/target/debug/examples/streaming_interop${process.platform === "win32" ? ".exe" : ""}`);
execFileSync("cargo", ["build", "-p", "linkrpc-examples", "--example", "streaming_interop"], {
    cwd: resolve(root, "rust"),
    stdio: "inherit",
});
const directory = mkdtempSync(resolve(tmpdir(), "linkrpc-streaming-"));
try {
    const schema = resolve(directory, "interface.json");
    const exported = JSON.parse(execFileSync(
        executable, ["--schema"], { encoding: "utf8" },
    ));
    writeFileSync(schema, JSON.stringify({ services: [], interfaceSchemas: [exported] }));
    execFileSync(process.execPath, [
        resolve(root, "typescript/packages/linkrpc-cli/dist/linkrpc.js"),
        "codegen",
        "--input", schema,
        "--interface", "dev.linkrpc.streaming-interop",
        "--name", "streamingInterop",
        "--output", resolve(root, "typescript/packages/linkrpc/src/connection/fixtures/streamingInterop.generated.ts"),
        "--preserve-wire-schema",
        ...(check ? ["--check"] : []),
    ], { cwd: root, stdio: "inherit" });
} finally {
    rmSync(directory, { recursive: true });
}
