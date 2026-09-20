import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { assertTrustedRun, finalizeRelease, prepareRelease, reserveNext, reserveStable } from "./release.mjs";
import { cargoPackages, command, inspectCandidates, npmPackages, packRelease, rewriteCargoManifest, rewriteNpmManifest, root } from "./release-pack.mjs";

const sha = "a".repeat(40);
const bases = { npm: "0.0.1", cargo: "0.1.0" };
function source(id = 1) {
	return { id, repository: { full_name: "hediet/linkrpc" }, head_repository: { full_name: "hediet/linkrpc" },
		head_branch: "main", event: "push", path: ".github/workflows/package-artifacts.yml",
		status: "completed", conclusion: "success", head_sha: sha, created_at: "2026-09-18T18:00:00Z" };
}

class Github {
	repository = "hediet/linkrpc";
	tags = new Map();
	runs = new Map([[1, source()]]);
	async getRun(id) { return this.runs.get(id); }
	async getTag(name) { return this.tags.get(name); }
	async getTagNames(prefix) { return [...this.tags.keys()].filter((name) => name.startsWith(prefix)); }
	async createTag(name, sha, message) {
		if (this.tags.has(name)) return false;
		this.tags.set(name, { sha, message });
		return true;
	}
}

test("next reservations retry idempotently and share a suffix across ecosystem bases", async () => {
	const github = new Github();
	assert.equal(await reserveNext(github, source(), bases), "next.20260918.1");
	assert.equal(await reserveNext(github, source(), bases), "next.20260918.1");
	assert.equal(await reserveNext(github, source(2), bases), "next.20260918.2");
	assert.equal(await reserveNext(github, { ...source(3), created_at: "2026-09-19T00:00:00Z" }, bases), "next.20260919.1");
	await assert.rejects(reserveNext(github, { ...source(), head_sha: "b".repeat(40) }, bases), /changed commit/);
	await assert.rejects(reserveNext(github, source(), { ...bases, npm: "0.0.2" }), /base versions changed/);
	await assert.rejects(reserveNext(github, { ...source(), created_at: "2026-02-30T00:00:00Z" }, bases));
});

test("atomic reservations resolve concurrent distinct and identical source runs", async () => {
	const github = new Github();
	const values = await Promise.all([1, 2, 3, 1, 2, 3].map((id) => reserveNext(github, source(id), bases)));
	assert.equal(new Set(values).size, 3);
	assert.deepEqual(values.slice(0, 3), values.slice(3));
	const [a, b] = await Promise.all([1, 2].map((id) => reserveStable(github, source(id), "npm", bases.npm)));
	assert.deepEqual(a, b);
	assert.equal(a.runId, 1);
});

test("stable reservation is immutable, namespaced, and finalized only after upload", async () => {
	const github = new Github();
	const npm = await reserveStable(github, source(), "npm", bases.npm);
	assert.deepEqual(await reserveStable(github, source(2), "npm", bases.npm), npm);
	const cargo = await reserveStable(github, source(2), "cargo", bases.cargo, "linkrpc");
	assert.equal(cargo.runId, 2);
	await finalizeRelease(github, { stable: { npm, "cargo/linkrpc": cargo } });
	await finalizeRelease(github, { stable: { npm, "cargo/linkrpc": cargo } });
	assert.equal(await reserveStable(github, source(3), "npm", bases.npm), undefined);
	assert.equal(await reserveStable(github, source(3), "cargo", bases.cargo, "linkrpc"), undefined);
	assert.ok(await reserveStable(github, source(3), "cargo", bases.cargo, "linkrpc-tokio"));
	assert.ok(await reserveStable(github, source(3), "npm", "0.0.2"));
});

test("stable recovery uses reserved source bytes, while next uses current source", async () => {
	const github = new Github();
	github.runs.set(2, { ...source(2), head_sha: "b".repeat(40) });
	await reserveStable(github, source(), "npm", bases.npm);
	for (const key of cargoPackages) await reserveStable(github, source(), "cargo", bases.cargo, key);
	const downloads = [];
	const packages = [];
	const options = {
		github, sourceRunId: 2, directory: "unused",
		download: async (id) => downloads.push(id),
		inspect: async () => ({ bases }),
		pack: async (args) => packages.push(args),
	};
	const state = await prepareRelease(options);
	assert.deepEqual(downloads, [2, 1]);
	assert.equal(packages.length, 6);
	assert.ok(packages.filter((p) => p.tag === "latest").every((p) => p.sha === sha));
	assert.deepEqual(packages.filter((p) => p.tag === "next").map((p) => p.version),
		["0.0.1-next.20260918.1", "0.1.0-next.20260918.1"]);
	packages.length = 0;
	await prepareRelease(options); // An upload failure leaves both stable and next retryable.
	assert.equal(packages.length, 6);
	await finalizeRelease(github, state);
	packages.length = 0;
	await prepareRelease(options);
	assert.equal(packages.length, 2);
	assert.ok(packages.every((p) => p.tag === "next"));
});

test("already released stable bases still produce next, without reserving another stable candidate", async () => {
	const github = new Github();
	for (const { ecosystem, packageKey } of [{ ecosystem: "npm" }, ...cargoPackages.map((packageKey) => ({ ecosystem: "cargo", packageKey }))]) {
		const version = bases[ecosystem];
		await github.createTag(`${ecosystem}${packageKey ? `/${packageKey}` : ""}/v${version}`, "b".repeat(40),
			JSON.stringify({ ecosystem, ...(packageKey ? { package: packageKey } : {}), version, sha: "b".repeat(40), runId: 99 }));
	}
	const packages = [];
	const options = {
		github, sourceRunId: 1, directory: "unused",
		download: async () => {}, inspect: async () => ({ bases }),
		pack: async (args) => packages.push(args),
	};
	const state = await prepareRelease(options);
	assert.deepEqual(state.stable, {});
	assert.equal(packages.length, 2);
	assert.deepEqual(packages.map((p) => [p.ecosystem, p.version, p.tag]), [
		["npm", "0.0.1-next.20260918.1", "next"],
		["cargo", "0.1.0-next.20260918.1", "next"],
	]);
	assert.ok([...github.tags.keys()].every((name) => !name.startsWith("release-candidates/")));
	packages.length = 0;
	await prepareRelease(options);
	assert.deepEqual(packages.map((p) => p.version), ["0.0.1-next.20260918.1", "0.1.0-next.20260918.1"]);
});

test("published Cargo baseline markers preserve original identities and allow first Tokio and npm stable", async () => {
	const github = new Github();
	const original = {
		ecosystem: "cargo", version: "0.1.0",
		sha: "13046a5afee1f8165f2c8277ffba476b4548be60", runId: 35364716115,
	};
	for (const key of ["linkrpc", "linkrpc-macros"]) {
		await github.createTag(`cargo/${key}/v0.1.0`, original.sha, JSON.stringify({ ...original, package: key }));
	}
	const packages = [];
	const state = await prepareRelease({
		github, sourceRunId: 1, directory: "unused",
		download: async () => {}, inspect: async () => ({ bases }),
		pack: async (args) => packages.push(args),
	});
	assert.deepEqual(Object.keys(state.stable), ["npm", "cargo/linkrpc-tokio"]);
	assert.deepEqual(packages.map((p) => [p.ecosystem, p.tag, p.packageKeys]), [
		["npm", "next", undefined], ["cargo", "next", undefined],
		["npm", "latest", undefined], ["cargo", "latest", ["linkrpc-tokio"]],
	]);
	assert.equal(await github.getTag("release-candidates/cargo/linkrpc/v0.1.0"), undefined);
	assert.equal(await github.getTag("release-candidates/cargo/linkrpc-macros/v0.1.0"), undefined);
	await finalizeRelease(github, state);
	for (const key of ["linkrpc", "linkrpc-macros"]) {
		assert.deepEqual(JSON.parse((await github.getTag(`cargo/${key}/v0.1.0`)).message), { ...original, package: key });
	}
	assert.equal(JSON.parse((await github.getTag("cargo/linkrpc-tokio/v0.1.0")).message).sha, sha);
});

test("untrusted or failed runs never download, reserve, or pack", async () => {
	assertTrustedRun(source(), "hediet/linkrpc");
	assertTrustedRun({ ...source(), event: "workflow_dispatch" }, "hediet/linkrpc");
	const variants = [
		{ head_branch: "feature" }, { head_repository: { full_name: "fork/linkrpc" } },
		{ repository: { full_name: "fork/linkrpc" } }, { event: "pull_request" }, { event: "pull_request_target" },
		{ path: ".github/workflows/rust.yml" }, { conclusion: "failure" }, { conclusion: "skipped" },
		{ status: "in_progress" }, { head_sha: "short" }, { id: 0 },
	];
	for (const variant of variants) {
		const github = new Github();
		github.runs.set(1, { ...source(), ...variant });
		await assert.rejects(prepareRelease({
			github, sourceRunId: 1, directory: "unused",
			download: () => assert.fail("Must not download"), pack: () => assert.fail("Must not pack"),
		}));
		assert.equal(github.tags.size, 0);
	}
});

test("a reserved stable run must remain trusted and match its SHA", async () => {
	const github = new Github();
	await reserveStable(github, source(), "npm", bases.npm);
	github.runs.set(1, { ...source(), event: "pull_request" });
	github.runs.set(2, source(2));
	await assert.rejects(prepareRelease({
		github, sourceRunId: 2, directory: "unused", download: async () => {},
		inspect: async () => ({ bases }), pack: async () => {},
	}), /PR builds/);
});

test("required peers, optional deps, development deps and publishConfig survive npm rewriting", () => {
	const version = "0.0.1-next.20260918.1";
	const original = {
		version: bases.npm, private: true,
		publishConfig: { access: "public", exports: { ".": "./dist/index.js" } },
		dependencies: { "@hediet/linkrpc": "workspace:*", external: "^1" },
		peerDependencies: { "@hediet/linkrpc-hub": "workspace:^" },
		optionalDependencies: { "@hediet/linkrpc-infra": "workspace:~" },
		devDependencies: { "@hediet/linkrpc-cli": "workspace:*" },
	};
	const result = rewriteNpmManifest(original, version, "next");
	for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
		assert.ok(Object.entries(result[field]).filter(([key]) => key.startsWith("@hediet/")).every(([, v]) => v === version));
	}
	assert.equal(result.private, undefined);
	assert.equal(result.publishConfig.access, "public");
	assert.equal(result.publishConfig.tag, "next");
	assert.deepEqual(result.publishConfig.exports, original.publishConfig.exports);
	assert.equal(original.private, true);
	assert.throws(() => rewriteNpmManifest({ dependencies: { unknown: "workspace:*" } }, version, "next"), /Unresolved/);
	assert.throws(() => rewriteNpmManifest(original, version, "latest"));
});

test("Cargo rewrites normalized manifests, pins prerelease macros, and rejects unresolved paths", () => {
	const text = '[package]\nname = "linkrpc"\nversion = "0.1.0"\n[dependencies.linkrpc-macros]\nversion = "0.1.0"\n';
	const manifest = parse(rewriteCargoManifest(text, "linkrpc", "0.1.0-next.20260918.1"));
	assert.equal(manifest.package.version, "0.1.0-next.20260918.1");
	assert.equal(manifest.dependencies["linkrpc-macros"].version, "=0.1.0-next.20260918.1");
	assert.equal(parse(rewriteCargoManifest(text, "linkrpc", "0.1.0")).dependencies["linkrpc-macros"].version, "0.1.0");
	assert.throws(() => rewriteCargoManifest(text + 'path = "../linkrpc-macros"\n', "linkrpc", "0.1.0"), /path dependencies/);
	assert.throws(() => rewriteCargoManifest(text + 'workspace = true\n', "linkrpc", "0.1.0"), /normalized/);
});

test("Tokio prereleases pin internal dependencies including renamed target/build/dev dependencies", () => {
	const text = `[package]
name = "linkrpc-tokio"
version = "0.1.0"
[dependencies.linkrpc]
version = "0.1.0"
features = ["client"]
[build-dependencies.macros]
package = "linkrpc-macros"
version = "0.1.0"
[target.'cfg(unix)'.dev-dependencies]
linkrpc = "0.1.0"
external = "1"
`;
	const manifest = parse(rewriteCargoManifest(text, "linkrpc-tokio", "0.1.0-next.20260918.1"));
	assert.equal(manifest.dependencies.linkrpc.version, "=0.1.0-next.20260918.1");
	assert.deepEqual(manifest.dependencies.linkrpc.features, ["client"]);
	assert.equal(manifest["build-dependencies"].macros.version, "=0.1.0-next.20260918.1");
	assert.equal(manifest.target["cfg(unix)"]["dev-dependencies"].linkrpc, "=0.1.0-next.20260918.1");
	assert.equal(manifest.target["cfg(unix)"]["dev-dependencies"].external, "1");
});

async function fixture(directory) {
	const input = join(directory, "candidates");
	await mkdir(input, { recursive: true });
	await writeFile(join(input, "candidates.json"), JSON.stringify({ sha, bases }));
	for (const key of npmPackages) {
		const workspace = join(directory, key);
		await mkdir(join(workspace, "package", "dist"), { recursive: true });
		const manifest = JSON.parse(await readFile(join(root, "typescript", "packages", key, "package.json"), "utf8"));
		for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
			for (const [name, value] of Object.entries(manifest[field] ?? {})) {
				if (value.startsWith("workspace:")) manifest[field][name] = bases.npm;
			}
		}
		Object.assign(manifest, { version: bases.npm, private: true, gitHead: sha, gitDirty: false });
		await writeFile(join(workspace, "package", "package.json"), JSON.stringify(manifest));
		await writeFile(join(workspace, "package", "dist", "index.js"), 'export const value = "packed";\n');
		command("tar", ["-czf", join(input, `${key}.tgz`), "-C", workspace, "package"]);
	}
	for (const key of cargoPackages) {
		const prefix = `${key}-${bases.cargo}`;
		const workspace = join(directory, prefix);
		await mkdir(join(workspace, "src"), { recursive: true });
		const manifest = `[package]\nname = "${key}"\nversion = "${bases.cargo}"\nedition = "2021"\npublish = true\n` +
			(key === "linkrpc" ? '[dependencies.linkrpc-macros]\nversion = "0.1.0"\n' :
				key === "linkrpc-tokio" ? '[dependencies.linkrpc]\nversion = "0.1.0"\n' : "[lib]\nproc-macro = true\n");
		await writeFile(join(workspace, "Cargo.toml"), manifest);
		await writeFile(join(workspace, "Cargo.toml.orig"), '[package]\nversion.workspace = true\n');
		await writeFile(join(workspace, ".cargo_vcs_info.json"), JSON.stringify({ git: { sha1: sha }, path_in_vcs: `rust/crates/${key}` }));
		await writeFile(join(workspace, "src", "lib.rs"), "// original crate source\n");
		await writeFile(join(workspace, "README.md"), "Original crate README\n");
		command("tar", ["-czf", join(input, `${key}.crate`), "-C", directory, prefix]);
	}
	return input;
}

test("real npm pack and Cargo archives preserve contents and consistent generated dependencies", async (t) => {
	const directory = join(root, "artifacts", `test-${randomUUID()}`);
	t.after(() => rm(directory, { recursive: true, force: true }));
	const input = await fixture(directory);
	assert.equal((await inspectCandidates(input, sha)).packages.length, 8);
	await assert.rejects(inspectCandidates(input, "b".repeat(40)), /trusted CI commit/);
	for (const tag of ["next", "latest"]) {
		for (const ecosystem of ["npm", "cargo"]) {
			const version = `${bases[ecosystem]}${tag === "next" ? "-next.20260918.1" : ""}`;
			const outputs = await packRelease({ input, output: join(directory, "release"), sha, ecosystem, version, tag });
			assert.equal(outputs.length, ecosystem === "npm" ? 5 : 3);
			for (const path of outputs) {
				if (ecosystem === "npm") {
					const manifest = JSON.parse(command("tar", ["-xOzf", path, "package/package.json"]));
					assert.equal(manifest.version, version);
					assert.equal(manifest.publishConfig.tag, tag);
					assert.equal(manifest.private, undefined);
					assert.equal(manifest.gitHead, sha);
					assert.equal(command("tar", ["-xOzf", path, "package/dist/index.js"]), 'export const value = "packed";\n');
					for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
						for (const [name, value] of Object.entries(manifest[field] ?? {})) {
							if (npmPackages.some((key) => name === `@hediet/${key}`)) assert.equal(value, version);
							assert.ok(!value.startsWith("workspace:"));
						}
					}
					if (manifest.name === "@hediet/linkrpc-infra") {
						assert.equal(manifest.peerDependencies["@hediet/linkrpc"], version);
						assert.equal(manifest.publishConfig.exports["."], "./dist/index.js");
					}
				} else {
					const key = path.includes("linkrpc-macros") ? "linkrpc-macros" : path.includes("linkrpc-tokio") ? "linkrpc-tokio" : "linkrpc";
					const prefix = `${key}-${version}`;
					const manifest = parse(command("tar", ["-xOzf", path, `${prefix}/Cargo.toml`]));
					assert.equal(manifest.package.version, version);
					if (key === "linkrpc") assert.equal(manifest.dependencies["linkrpc-macros"].version, tag === "next" ? `=${version}` : version);
					if (key === "linkrpc-tokio") assert.equal(manifest.dependencies.linkrpc.version, tag === "next" ? `=${version}` : version);
					assert.equal(command("tar", ["-xOzf", path, `${prefix}/Cargo.toml.orig`]), '[package]\nversion.workspace = true\n');
					assert.equal(command("tar", ["-xOzf", path, `${prefix}/src/lib.rs`]), "// original crate source\n");
					assert.equal(command("tar", ["-xOzf", path, `${prefix}/README.md`]), "Original crate README\n");
					assert.equal(JSON.parse(command("tar", ["-xOzf", path, `${prefix}/.cargo_vcs_info.json`])).git.sha1, sha);
					assert.ok(!command("tar", ["-tzf", path]).includes("Cargo.lock"));
				}
			}
		}
	}
	const tokioOnly = await packRelease({
		input, output: join(directory, "tokio-only"), sha, ecosystem: "cargo",
		version: bases.cargo, tag: "latest", packageKeys: ["linkrpc-tokio"],
	});
	assert.equal(tokioOnly.length, 1);
	assert.ok(tokioOnly[0].endsWith("linkrpc-tokio-0.1.0.crate"));
});

test("workflow trust gates and candidate artifact isolation are explicit", async () => {
	const candidates = await readFile(join(root, ".github", "workflows", "package-artifacts.yml"), "utf8");
	const release = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
	const upload = await readFile(join(root, ".github", "actions", "upload-release", "action.yml"), "utf8");
	assert.ok(candidates.indexOf("cargo test --workspace --locked") < candidates.indexOf("Create candidates"));
	assert.ok(candidates.indexOf("run: pnpm check") < candidates.indexOf("Create candidates"));
	assert.ok(candidates.indexOf("node interop/generate-streaming.mjs --check") < candidates.indexOf("Create candidates"));
	assert.ok(candidates.indexOf("LINKRPC_STREAMING_INTEROP") < candidates.indexOf("Create candidates"));
	assert.match(candidates, /name: candidate-packages/);
	assert.doesNotMatch(candidates, /name: (?:npm-|cargo-crate-)/);
	assert.match(release, /workflows: \[Packages\]/);
	assert.match(release, /conclusion == 'success'/);
	assert.match(release, /head_branch == 'main'/);
	assert.match(release, /head_repository.id == github.event.repository.id/);
	assert.match(release, /event == 'push' \|\| github.event.workflow_run.event == 'workflow_dispatch'/);
	assert.match(release, /ref: \$\{\{ github.event.workflow_run.head_sha \}\}/);
	assert.match(release, /group: package-release/);
	assert.match(release, /cancel-in-progress: false/);
	assert.ok(release.indexOf("Finalize stable") > release.indexOf("Upload stable"));
	assert.doesNotMatch(release + candidates, /(?:npm|cargo) publish|NODE_AUTH_TOKEN|CARGO_REGISTRY_TOKEN/);
	assert.match(upload, /name: cargo-crate-\$\{\{ inputs.channel \}\}-linkrpc-tokio/);
	assert.match(release, /cargo_tokio: \$\{\{ steps.prepare.outputs.cargo_linkrpc_tokio_stable \}\}/);
});

test("repacking a reserved release produces identical archive bytes", async (t) => {
	const directory = join(root, "artifacts", `test-${randomUUID()}`);
	t.after(() => rm(directory, { recursive: true, force: true }));
	const input = await fixture(directory);
	for (const ecosystem of ["npm", "cargo"]) {
		const options = { input, sha, ecosystem, version: `${bases[ecosystem]}-next.20260918.1`, tag: "next" };
		const first = await packRelease({ ...options, output: join(directory, "first") });
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const second = await packRelease({ ...options, output: join(directory, "second") });
		assert.equal(first.length, second.length);
		for (let index = 0; index < first.length; index++) {
			assert.deepEqual(await readFile(first[index]), await readFile(second[index]), `${ecosystem} retry changed archive bytes`);
		}
	}
});
