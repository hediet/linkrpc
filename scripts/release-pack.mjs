import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "smol-toml";
import { create as createTar } from "tar";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const npmPackages = ["linkrpc", "linkrpc-infra", "linkrpc-hub", "linkrpc-cli", "linkrpc-mcp"];
export const cargoPackages = ["linkrpc-macros", "linkrpc", "linkrpc-tokio"];
export const basePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function command(program, args, options = {}) {
	try {
		if (process.platform === "win32" && ["npm", "corepack"].includes(program)) {
			assert.ok(args.every((arg) => !/["%!\r\n]/.test(arg)));
			return execFileSync(process.env.ComSpec ?? "cmd.exe",
				["/d", "/s", "/c", `${program} ${args.map((arg) => `"${arg}"`).join(" ")}`],
				{ encoding: "utf8", stdio: "pipe", windowsVerbatimArguments: true, ...options });
		}
		return execFileSync(program, args, { encoding: "utf8", stdio: "pipe", ...options });
	} catch (error) {
		throw new Error(`${program} failed: ${error.stderr?.toString() || error.message}`, { cause: error });
	}
}

async function scratch(parent, action) {
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(join(parent, "work-"));
	try { return await action(directory); }
	finally { await rm(directory, { recursive: true, force: true }); }
}

function archiveEntries(path, prefix) {
	const entries = command("tar", ["-tzf", path]).trim().split(/\r?\n/);
	assert.ok(entries.length > 0 && entries.every((entry) =>
		entry.startsWith(`${prefix}/`) && !entry.includes("\\") && !entry.split("/").includes("..")),
		`Unsafe archive paths: ${path}`);
	// Neither ecosystem needs links in its package archives.
	assert.ok(command("tar", ["-tvzf", path]).trim().split(/\r?\n/).every((line) => /^[d-]/.test(line)),
		`Archive links are not supported: ${path}`);
	return entries;
}

function archiveText(path, entry) {
	return command("tar", ["-xOzf", path, entry]);
}

export function rewriteNpmManifest(manifest, version, tag) {
	assert.match(version.split("-")[0], basePattern);
	assert.ok((tag === "latest" && basePattern.test(version)) ||
		(tag === "next" && /^\d+\.\d+\.\d+-next\.\d{8}\.[1-9]\d*$/.test(version)));
	const result = structuredClone(manifest);
	delete result.private;
	result.version = version;
	result.publishConfig = { ...result.publishConfig, tag };
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
		for (const [name, requirement] of Object.entries(result[field] ?? {})) {
			if (npmPackages.some((key) => name === `@hediet/${key}`)) result[field][name] = version;
			assert.ok(!String(result[field][name]).startsWith("workspace:"), `Unresolved ${field}: ${name} ${requirement}`);
		}
	}
	return result;
}

export function rewriteCargoManifest(text, name, version) {
	const manifest = parse(text);
	assert.equal(manifest.package.name, name);
	assert.match(manifest.package.version, basePattern);
	manifest.package.version = version;
	const internalDependency = { linkrpc: "linkrpc-macros", "linkrpc-tokio": "linkrpc" }[name];
	if (internalDependency) assert.ok(manifest.dependencies[internalDependency]);
	const check = (value) => {
		if (!value || typeof value !== "object") return;
		for (const [key, item] of Object.entries(value)) {
			assert.notEqual(key, "workspace", "Cargo archives must be normalized.");
			// Paths to targets (lib, bin, etc.) are valid; dependency paths are not.
			if (["dependencies", "dev-dependencies", "build-dependencies"].includes(key)) {
				for (const [alias, dependency] of Object.entries(item)) {
					assert.ok(typeof dependency === "string" || !("path" in dependency),
						"Cargo archives must not contain path dependencies.");
					const packageName = typeof dependency === "string" ? alias : dependency.package ?? alias;
					if (cargoPackages.includes(packageName)) {
						const requirement = version.includes("-") ? `=${version}` : version;
						if (typeof dependency === "string") item[alias] = requirement;
						else dependency.version = requirement;
					}
				}
			}
			check(item);
		}
	};
	check(manifest);
	return stringify(manifest);
}

export async function inspectCandidates(input, sha) {
	const info = JSON.parse(await readFile(join(input, "candidates.json"), "utf8"));
	assert.equal(info.sha, sha, "Candidates must belong to the trusted CI commit.");
	assert.deepEqual(Object.keys(info.bases).sort(), ["cargo", "npm"]);
	for (const base of Object.values(info.bases)) assert.match(base, basePattern);
	const packages = [];
	for (const key of npmPackages) {
		const path = join(input, `${key}.tgz`);
		archiveEntries(path, "package");
		const manifest = JSON.parse(archiveText(path, "package/package.json"));
		assert.equal(manifest.name, `@hediet/${key}`);
		assert.equal(manifest.version, info.bases.npm);
		assert.equal(manifest.private, true);
		assert.equal(manifest.gitHead, sha);
		assert.equal(manifest.gitDirty, false);
		packages.push({ ecosystem: "npm", key, path, manifest });
	}
	for (const key of cargoPackages) {
		const path = join(input, `${key}.crate`);
		const prefix = `${key}-${info.bases.cargo}`;
		archiveEntries(path, prefix);
		const manifest = archiveText(path, `${prefix}/Cargo.toml`);
		assert.equal(parse(manifest).package.version, info.bases.cargo);
		assert.ok([undefined, true].includes(parse(manifest).package.publish), "Candidate crate must be publishable.");
		rewriteCargoManifest(manifest, key, info.bases.cargo);
		const vcs = JSON.parse(archiveText(path, `${prefix}/.cargo_vcs_info.json`));
		assert.equal(vcs.git.sha1, sha);
		assert.ok(!vcs.git.dirty, "Dirty crate candidates cannot be released.");
		packages.push({ ecosystem: "cargo", key, path, prefix, manifest });
	}
	return { ...info, packages };
}

export async function packRelease({ input, output, sha, ecosystem, version, tag, packageKeys }) {
	const candidates = await inspectCandidates(input, sha);
	assert.equal(version.split("-")[0], candidates.bases[ecosystem]);
	assert.ok((tag === "latest" && basePattern.test(version)) ||
		(tag === "next" && /^\d+\.\d+\.\d+-next\.\d{8}\.[1-9]\d*$/.test(version)));
	const channel = tag === "latest" ? "stable" : "next";
	return scratch(join(output, ".work"), async (staging) => {
		const outputs = [];
		const selected = candidates.packages.filter((p) => p.ecosystem === ecosystem && (!packageKeys || packageKeys.includes(p.key)));
		if (packageKeys) assert.equal(selected.length, packageKeys.length, "Missing selected release packages.");
		for (const candidate of selected) {
			const directory = join(staging, candidate.key);
			await mkdir(directory);
			const destination = resolve(output, `${ecosystem === "npm" ? "npm" : "cargo-crate"}-${channel}-${candidate.key}`);
			await mkdir(destination, { recursive: true });
			if (ecosystem === "npm") {
				command("tar", ["-xzf", candidate.path, "-C", directory]);
				const packageDirectory = join(directory, "package");
				await writeFile(join(packageDirectory, "package.json"),
					JSON.stringify(rewriteNpmManifest(candidate.manifest, version, tag), null, 2) + "\n");
				const [packed] = JSON.parse(command("npm", ["pack", "--ignore-scripts", "--json",
					"--pack-destination", destination], { cwd: packageDirectory }));
				outputs.push(join(destination, packed.filename));
			} else {
				const prefix = `${candidate.key}-${version}`;
				const packageDirectory = join(directory, prefix);
				await mkdir(packageDirectory);
				command("tar", ["-xzf", candidate.path, "--strip-components=1", "-C", packageDirectory]);
				await writeFile(join(packageDirectory, "Cargo.toml"),
					rewriteCargoManifest(candidate.manifest, candidate.key, version));
				const path = join(destination, `${prefix}.crate`);
				// Preserve every Cargo-produced file, including Cargo.toml.orig and VCS provenance.
				await createTar({ file: path, cwd: directory, gzip: true, portable: true,
					mtime: new Date(0) }, [prefix]);
				outputs.push(path);
			}
		}
		return outputs;
	});
}

export async function createCandidates(output, sha) {
	assert.match(sha, /^[a-f0-9]{40}$/);
	assert.equal(command("git", ["rev-parse", "HEAD"], { cwd: root }).trim(), sha);
	assert.equal(command("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root }).trim(), "",
		"Candidates must be built from a clean checkout.");
	await mkdir(output, { recursive: true });
	const bases = {};
	await scratch(join(output, ".work"), async (staging) => {
		for (const key of npmPackages) {
			const directory = join(staging, key);
			await mkdir(directory);
			command("corepack", ["pnpm", "--filter", `@hediet/${key}`, "pack", "--pack-destination", directory],
				{ cwd: join(root, "typescript") });
			const archives = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
			assert.equal(archives.length, 1);
			command("tar", ["-xzf", join(directory, archives[0]), "-C", directory]);
			const manifestPath = join(directory, "package", "package.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			bases.npm ??= manifest.version;
			assert.equal(manifest.version, bases.npm);
			Object.assign(manifest, { private: true, gitHead: sha, gitDirty: false });
			await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
			command("tar", ["-czf", join(output, `${key}.tgz`), "-C", directory, "package"]);
		}
		const workspace = parse(await readFile(join(root, "rust", "Cargo.toml"), "utf8"));
		bases.cargo = workspace.workspace.package.version;
		for (const key of cargoPackages) {
			command("cargo", ["package", "--locked", "--exclude-lockfile",
				...(key !== "linkrpc-macros" ? ["--no-verify"] : []), "-p", key], { cwd: join(root, "rust") });
			await cp(join(root, "rust", "target", "package", `${key}-${bases.cargo}.crate`), join(output, `${key}.crate`));
		}
	});
	await writeFile(join(output, "candidates.json"), JSON.stringify({ sha, bases }, null, 2) + "\n");
	await inspectCandidates(output, sha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	assert.equal(process.argv[2], "candidates");
	await createCandidates(resolve("artifacts", "candidates"), process.env.GITHUB_SHA);
}
