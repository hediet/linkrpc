import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { basePattern, cargoPackages, command, inspectCandidates, packRelease } from "./release-pack.mjs";

export function assertTrustedRun(run, repository) {
	assert.equal(run.repository.full_name, repository);
	assert.equal(run.head_repository.full_name, repository, "Fork artifacts cannot be released.");
	assert.equal(run.head_branch, "main");
	assert.ok(["push", "workflow_dispatch"].includes(run.event), "PR builds cannot produce releases.");
	assert.equal(run.path, ".github/workflows/package-artifacts.yml");
	assert.equal(run.status, "completed");
	assert.equal(run.conclusion, "success", "Both Rust and TypeScript checks must succeed.");
	assert.match(run.head_sha, /^[a-f0-9]{40}$/);
	assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
}

function readClaim(tag, expected = {}) {
	assert.ok(tag?.message, "Reservations must be annotated tags.");
	const claim = JSON.parse(tag.message);
	assert.equal(claim.sha, tag.sha, "Reservation commit changed.");
	assert.match(claim.sha, /^[a-f0-9]{40}$/);
	assert.ok(Number.isSafeInteger(claim.runId) && claim.runId > 0);
	for (const [key, value] of Object.entries(expected)) assert.deepEqual(claim[key], value);
	return claim;
}

export async function reserveNext(github, run, bases) {
	for (const base of Object.values(bases)) assert.match(base, basePattern);
	assert.match(run.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
	const timestamp = new Date(run.created_at);
	assert.equal(timestamp.toISOString(), run.created_at.replace("Z", ".000Z"));
	const date = timestamp.toISOString().slice(0, 10).replaceAll("-", "");
	const prefix = `next-builds/${date}/`;
	for (let attempt = 0; attempt < 20; attempt++) {
		const claims = await Promise.all((await github.getTagNames(prefix)).map(async (name) => {
			const index = name.slice(prefix.length);
			assert.match(index, /^[1-9]\d*$/);
			assert.ok(Number.isSafeInteger(Number(index)));
			return { ...readClaim(await github.getTag(name), { suffix: `next.${date}.${index}` }), index: Number(index) };
		}));
		const existing = claims.filter((claim) => claim.runId === run.id);
		assert.ok(existing.length <= 1, "Run has multiple next reservations.");
		if (existing.length) {
			assert.equal(existing[0].sha, run.head_sha, "Reserved run changed commit.");
			assert.deepEqual(existing[0].bases, bases, "Reserved base versions changed.");
			return existing[0].suffix;
		}
		const index = Math.max(0, ...claims.map((claim) => claim.index)) + 1;
		assert.ok(Number.isSafeInteger(index));
		const suffix = `next.${date}.${index}`;
		if (await github.createTag(`${prefix}${index}`, run.head_sha,
			JSON.stringify({ runId: run.id, sha: run.head_sha, bases, suffix }), { allowExisting: true })) return suffix;
	}
	throw new Error("Next reservation remained contended; retry the release.");
}

export async function reserveStable(github, run, ecosystem, version, packageKey) {
	assert.ok(ecosystem === "npm" ? packageKey === undefined : ecosystem === "cargo" && cargoPackages.includes(packageKey));
	const identity = { ecosystem, ...(packageKey ? { package: packageKey } : {}), version };
	const name = `${ecosystem}${packageKey ? `/${packageKey}` : ""}/v${version}`;
	const released = await github.getTag(name);
	if (released) {
		readClaim(released, identity);
		return undefined;
	}
	const candidateName = `release-candidates/${name}`;
	let tag = await github.getTag(candidateName);
	if (!tag) {
		const claim = { ...identity, sha: run.head_sha, runId: run.id };
		await github.createTag(candidateName, run.head_sha, JSON.stringify(claim), { allowExisting: true });
		tag = await github.getTag(candidateName);
	}
	return readClaim(tag, identity);
}

export async function prepareRelease({ github, sourceRunId, download, inspect = inspectCandidates, pack = packRelease, directory }) {
	const run = await github.getRun(sourceRunId);
	assert.equal(run.id, sourceRunId, "Source run changed identity.");
	assertTrustedRun(run, github.repository);
	const inputs = new Map();
	const load = async (source) => {
		if (inputs.has(source.id)) return inputs.get(source.id);
		assertTrustedRun(source, github.repository);
		const input = join(directory, `source-${source.id}`);
		await download(source.id, input);
		const info = await inspect(input, source.head_sha);
		const result = { input, info };
		inputs.set(source.id, result);
		return result;
	};
	const current = await load(run);
	const suffix = await reserveNext(github, run, current.info.bases);
	const state = { next: true, stable: {} };
	const output = join(directory, "release");
	for (const ecosystem of ["npm", "cargo"]) {
		const version = current.info.bases[ecosystem];
		await pack({ input: current.input, output, sha: run.head_sha, ecosystem, version: `${version}-${suffix}`, tag: "next" });
	}
	for (const { ecosystem, packageKey } of [{ ecosystem: "npm" }, ...cargoPackages.map((packageKey) => ({ ecosystem: "cargo", packageKey }))]) {
		const version = current.info.bases[ecosystem];
		const candidate = await reserveStable(github, run, ecosystem, version, packageKey);
		if (candidate) {
			const candidateRun = candidate.runId === run.id ? run : await github.getRun(candidate.runId);
			assert.equal(candidateRun.id, candidate.runId, "Reserved stable run changed identity.");
			assert.equal(candidateRun.head_sha, candidate.sha, "Reserved stable run changed identity.");
			const stable = await load(candidateRun);
			assert.equal(stable.info.bases[ecosystem], version);
			await pack({ input: stable.input, output, sha: candidate.sha, ecosystem, version, tag: "latest",
				...(packageKey ? { packageKeys: [packageKey] } : {}) });
			state.stable[ecosystem === "npm" ? "npm" : `cargo/${packageKey}`] = candidate;
		}
	}
	return state;
}

export async function finalizeRelease(github, state) {
	for (const [scope, candidate] of Object.entries(state.stable)) {
		assert.ok(candidate.ecosystem === "npm" ? candidate.package === undefined :
			candidate.ecosystem === "cargo" && cargoPackages.includes(candidate.package));
		assert.equal(scope, candidate.package ? `${candidate.ecosystem}/${candidate.package}` : candidate.ecosystem);
		const name = `${scope}/v${candidate.version}`;
		const claim = readClaim(await github.getTag(`release-candidates/${name}`));
		assert.deepEqual(claim, candidate);
		await github.createTag(name, candidate.sha, JSON.stringify(candidate), { allowExisting: true });
		assert.deepEqual(readClaim(await github.getTag(name)), candidate, "Stable tags are immutable.");
	}
}

export class GithubRepository {
	constructor(repository, token) {
		assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
		assert.ok(token, "GH_TOKEN is required.");
		this.repository = repository;
		this.token = token;
	}
	getRun(id) {
		assert.ok(Number.isSafeInteger(id) && id > 0);
		return this.request(`actions/runs/${id}`);
	}
	async getTag(name) {
		const ref = await this.request(`git/ref/tags/${name}`, { allowMissing: true });
		if (!ref) return undefined;
		assert.equal(ref.object.type, "tag", "Release tags must be annotated.");
		const tag = await this.request(`git/tags/${ref.object.sha}`);
		assert.equal(tag.object.type, "commit");
		return { sha: tag.object.sha, message: tag.message };
	}
	async getTagNames(prefix) {
		const refs = await this.request(`git/matching-refs/tags/${prefix}`);
		return refs.map((ref) => {
			assert.ok(ref.ref.startsWith(`refs/tags/${prefix}`));
			return ref.ref.slice("refs/tags/".length);
		});
	}
	async createTag(name, sha, message, { allowExisting = false } = {}) {
		const tag = await this.request("git/tags", { body: { tag: name, object: sha, type: "commit", message } });
		const ref = await this.request("git/refs", { body: { ref: `refs/tags/${name}`, sha: tag.sha }, allowExisting });
		return ref !== undefined;
	}
	async request(path, { body, allowMissing = false, allowExisting = false } = {}) {
		const response = await fetch(`https://api.github.com/repos/${this.repository}/${path}`, {
			method: body ? "POST" : "GET",
			headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(30_000),
		});
		if (allowMissing && response.status === 404) return undefined;
		if (!response.ok) {
			const detail = await response.text();
			if (allowExisting && response.status === 422 && JSON.parse(detail).message === "Reference already exists") return undefined;
			throw new Error(`GitHub ${path}: ${response.status} ${detail}`);
		}
		return response.json();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const github = new GithubRepository(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
	const directory = resolve("artifacts");
	const statePath = join(directory, "release-state.json");
	if (process.argv[2] === "prepare") {
		assert.ok(process.env.GITHUB_OUTPUT);
		const state = await prepareRelease({
			github, sourceRunId: Number(process.env.SOURCE_RUN_ID), directory,
			download: async (id, destination) => {
				await mkdir(destination, { recursive: true });
				command("gh", ["run", "download", String(id), "--repo", github.repository,
					"--dir", destination, "--name", "candidate-packages"], { stdio: "inherit", timeout: 180_000 });
			},
		});
		await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
		await appendFile(process.env.GITHUB_OUTPUT, [
			`npm_stable=${!!state.stable.npm}`,
			...cargoPackages.map((key) => `cargo_${key.replaceAll("-", "_")}_stable=${!!state.stable[`cargo/${key}`]}`),
			"",
		].join("\n"));
	} else if (process.argv[2] === "finalize") {
		await finalizeRelease(github, JSON.parse(await readFile(statePath, "utf8")));
	} else {
		throw new Error("Usage: node scripts/release.mjs <prepare|finalize>");
	}
}
