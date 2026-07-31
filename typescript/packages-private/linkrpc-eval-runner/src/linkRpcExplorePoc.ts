import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
    createSeededMemoryPrincipal,
    defineInterface,
    requestType,
    TransportPair,
} from "@hediet/linkrpc";
import { HubSigningSender } from "@hediet/linkrpc/hub/client";
import {
    createHubServiceInterfaces,
    Hub,
    hubRegisterServiceId,
    registerHubServices,
    RootOverlay,
    withVerifiedSignature,
} from "@hediet/linkrpc-hub/hub/server";
import { McpSocketHost } from "@hediet/linkrpc-mcp/node";
import { z } from "zod";
import { evaluate, type Score, type Scorer } from "./evaluation";
import { FileRecordingStore } from "./fileRecordingStore";
import {
    hashValue,
    RecordingCache,
    type RecordableFunction,
    type ValidationResult,
} from "./recordingCache";

interface McpToolCall {
    readonly name: string;
    readonly arguments: unknown;
    readonly result: unknown;
}

const workspaceIndexInterface = defineInterface(
    {
        id: "vscode.workspaceIndex",
        description: "Searches workspace file paths using include and exclude glob patterns.",
    },
    {
        findFiles: requestType(
            z.object({
                include: z.string(),
                exclude: z.string().optional(),
                maxResults: z.number().int().positive().optional(),
            }),
            z.object({ uris: z.array(z.string()) }),
            { description: "Find matching workspace files without reading their contents." },
        ),
    },
);

const symbolIndexInterface = defineInterface(
    {
        id: "vscode.symbolIndex",
        description: "Searches programming-language symbols and their definitions.",
    },
    {
        findSymbols: requestType(
            z.object({ query: z.string() }),
            z.object({ locations: z.array(z.string()) }),
            { description: "Find symbol definitions by a textual symbol query." },
        ),
    },
);

const pullRequestInterface = defineInterface(
    {
        id: "vscode.pullRequests",
        description: "Reads and updates pull-request review state.",
    },
    {
        createReviewThread: requestType(
            z.object({
                pullRequest: z.number().int().positive(),
                file: z.string(),
                line: z.number().int().positive(),
                body: z.string(),
            }),
            z.object({ threadId: z.string() }),
            { description: "Create an inline review thread at a file and line in a pull request." },
        ),
    },
);

const issueInterface = defineInterface(
    {
        id: "vscode.issues",
        description: "Creates and updates repository issues.",
    },
    {
        createIssue: requestType(
            z.object({ title: z.string(), body: z.string() }),
            z.object({ issueNumber: z.number().int().positive() }),
            { description: "Create a repository issue that is not attached to a code line." },
        ),
    },
);

interface ExploreScenario {
    readonly id: string;
    readonly task: string;
    readonly expectedOperation: string;
    register(hub: Hub): () => void;
}

export const linkRpcExploreScenarios: readonly ExploreScenario[] = [
    {
        id: "workspace-file-search",
        task: "find files by an include glob while excluding generated paths",
        expectedOperation: "workbench::vscode.workspaceIndex::findFiles",
        register: (hub) => {
            const service = hubRegisterServiceId(hub, "workbench");
            service.connection.register(
                workspaceIndexInterface,
                { findFiles: () => ({ uris: [] }) },
                { serviceId: "workbench" },
            );
            service.connection.register(
                symbolIndexInterface,
                { findSymbols: () => ({ locations: [] }) },
                { serviceId: "workbench" },
            );
            return () => service.dispose();
        },
    },
    {
        id: "pull-request-review-thread",
        task: "add an inline review comment to a specific file and line of a pull request",
        expectedOperation: "source-control::vscode.pullRequests::createReviewThread",
        register: (hub) => {
            const service = hubRegisterServiceId(hub, "source-control");
            service.connection.register(
                pullRequestInterface,
                { createReviewThread: () => ({ threadId: "thread-1" }) },
                { serviceId: "source-control" },
            );
            service.connection.register(
                issueInterface,
                { createIssue: () => ({ issueNumber: 1 }) },
                { serviceId: "source-control" },
            );
            return () => service.dispose();
        },
    },
];

export interface LinkRpcExploreInput {
    readonly scenarioId: string;
    readonly llmSeed: number;
    readonly model: string;
}

export interface LinkRpcExploreOutput {
    readonly answer: string;
    readonly model: string | undefined;
    readonly toolCalls: readonly McpToolCall[];
    readonly usage: CopilotUsage;
    readonly metrics: LinkRpcExploreMetrics;
}

export interface CopilotUsage {
    readonly premiumRequests?: number;
    readonly aiCredits?: number;
    readonly totalApiDurationMs?: number;
    readonly sessionDurationMs?: number;
    readonly [key: string]: unknown;
}

export interface LinkRpcExploreMetrics {
    readonly cost: number | undefined;
    readonly costUnit: "premiumRequests" | "aiCredits" | undefined;
    readonly outputTokens: number | undefined;
    readonly apiDurationMs: number | undefined;
    readonly sessionDurationMs: number | undefined;
}

export interface LinkRpcExploreEvaluationOutput extends LinkRpcExploreOutput {
    readonly cacheKind: "computed" | "reused";
    readonly recordingId: string;
}

export interface LinkRpcExplorePocOptions {
    readonly recordingsDirectory: string;
    readonly copilotCommand?: string;
    readonly models?: readonly string[];
    readonly scenarios?: readonly string[];
    readonly seeds?: readonly number[];
}

export const defaultLinkRpcExploreModels = [
    "claude-haiku-4.5",
    "gpt-5.4-mini",
    "gpt-5.6-luna",
] as const;

export async function runLinkRpcExplorePoc(options: LinkRpcExplorePocOptions): Promise<void> {
    const scenarios = selectScenarios(options.scenarios);
    const seeds = options.seeds ?? [0, 1, 2];
    const models = options.models ?? defaultLinkRpcExploreModels;
    const inputs = scenarios.flatMap((scenario) =>
        models.flatMap((model) =>
            seeds.map((llmSeed) => ({ scenarioId: scenario.id, llmSeed, model })),
        ),
    );
    const recordable = new LinkRpcExploreRecordable(options.copilotCommand ?? "copilot");
    const cache = new RecordingCache(new FileRecordingStore(options.recordingsDirectory));

    const results = await evaluate<LinkRpcExploreInput, LinkRpcExploreEvaluationOutput>({
        inputs,
        run: async (input) => {
            const resolution = await cache.resolve(recordable, input);
            return {
                ...resolution.output,
                cacheKind: resolution.kind,
                recordingId: resolution.recordingId,
            };
        },
        scorers: exploreScorers,
    });

    for (const result of results) {
        const scores = Object.fromEntries(result.scores.map((score) => [score.name, score.value]));
        console.log(
            `${result.input.scenarioId} model=${result.output.model ?? result.input.model}`
            + ` seed=${result.input.llmSeed} ${result.output.cacheKind}`
            + ` answer=${scores.answer} explore=${scores.explore} efficiency=${scores.efficiency}`
            + ` calls=${result.output.toolCalls.length}`
            + ` cost=${formatMetric(result.output.metrics.cost)}`
            + ` costUnit=${result.output.metrics.costUnit ?? "n/a"}`
            + ` outputTokens=${formatMetric(result.output.metrics.outputTokens, 0)}`,
        );
        console.log(`  ${result.output.answer.replace(/\s+/g, " ").trim()}`);
    }

    const allScores = results.flatMap((result) => result.scores);
    const average = allScores.length === 0
        ? 0
        : allScores.reduce((sum, score) => sum + score.value, 0) / allScores.length;
    const metrics = summarizeMetrics(results.map((result) => result.output.metrics));
    console.log(
        `overall=${average.toFixed(3)} runs=${results.length}`
        + ` cost=${formatMetric(metrics.cost)}`
        + ` costUnit=${metrics.costUnit ?? "n/a"}`
        + ` outputTokens=${formatMetric(metrics.outputTokens, 0)}`,
    );
}

class LinkRpcExploreRecordable implements RecordableFunction<
    LinkRpcExploreInput,
    LinkRpcExploreOutput,
    readonly McpToolCall[]
> {
    public readonly id = "linkrpc-explore/copilot-cli";
    public readonly version = "5";

    public constructor(private readonly _copilotCommand: string) { }

    public async run(input: LinkRpcExploreInput): Promise<{
        readonly output: LinkRpcExploreOutput;
        readonly evidence: readonly McpToolCall[];
    }> {
        const scenario = getScenario(input.scenarioId);
        const toolCalls: McpToolCall[] = [];
        const environment = await startScenarioEnvironment(scenario, (call) => toolCalls.push(call));
        const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "linkrpc-explore-eval-"));
        try {
            const configPath = path.join(temporaryDirectory, "mcp.json");
            await writeFile(configPath, JSON.stringify(createMcpConfig(environment), undefined, 2));
            const response = await invokeCopilot(
                this._copilotCommand,
                createPrompt(scenario, input.llmSeed),
                input.model,
                configPath,
                temporaryDirectory,
            );
            if (!toolCalls.some((call) => !isToolError(call.result))) {
                throw new Error("Copilot completed without a successful LinkRPC MCP tool call");
            }
            const output: LinkRpcExploreOutput = {
                answer: response.content,
                model: response.model,
                toolCalls: [...toolCalls],
                usage: response.usage,
                metrics: createMetrics(response.usage, response.outputTokens),
            };
            return { output, evidence: [...toolCalls] };
        } finally {
            environment.dispose();
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }

    public async validate(
        input: LinkRpcExploreInput,
        evidence: readonly McpToolCall[],
    ): Promise<ValidationResult> {
        if (evidence.length === 0) {
            return { valid: false, reason: "recording has no MCP evidence" };
        }
        const scenario = getScenario(input.scenarioId);
        const environment = await startScenarioEnvironment(scenario);
        let client: Client | undefined;
        try {
            client = new Client({ name: "linkrpc-explore-replay", version: "0.0.1" });
            const transport = new StreamableHTTPClientTransport(new URL(environment.url), {
                requestInit: {
                    headers: { Authorization: `Bearer ${environment.authorizationToken}` },
                },
            });
            await client.connect(transport);
            for (let index = 0; index < evidence.length; index++) {
                const expected = evidence[index];
                const actual = await client.callTool({
                    name: expected.name,
                    arguments: expected.arguments as Record<string, unknown>,
                });
                if (hashValue(actual) !== hashValue(expected.result)) {
                    return {
                        valid: false,
                        reason: { kind: "tool-result-mismatch", call: index, name: expected.name },
                    };
                }
            }
            return { valid: true };
        } catch (error) {
            return { valid: false, reason: describeError(error) };
        } finally {
            await client?.close().catch(() => undefined);
            environment.dispose();
        }
    }
}

const exploreScorers: readonly Scorer<LinkRpcExploreInput, LinkRpcExploreEvaluationOutput>[] = [
    (input, output): Score => {
        const expected = getScenario(input.scenarioId).expectedOperation;
        return {
            name: "answer",
            value: output.answer.includes(expected) ? 1 : 0,
            details: { expected },
        };
    },
    (_input, output): Score => ({
        name: "explore",
        value: output.toolCalls.some((call) =>
            call.name === "runLinkRpcScript"
            && typeof (call.arguments as { code?: unknown }).code === "string"
            && (call.arguments as { code: string }).code.includes("con.explore")
        ) ? 1 : 0,
    }),
    (_input, output): Score => ({
        name: "efficiency",
        value: output.toolCalls.length <= 3 ? 1 : output.toolCalls.length <= 5 ? 0.5 : 0,
        details: { toolCalls: output.toolCalls.length },
    }),
];

interface ScenarioEnvironment {
    readonly url: string;
    readonly authorizationToken: string;
    dispose(): void;
}

async function startScenarioEnvironment(
    scenario: ExploreScenario,
    onToolCall?: (call: McpToolCall) => void,
): Promise<ScenarioEnvironment> {
    const hub = new Hub({ debugName: `eval-${scenario.id}` });
    const hubServices = createHubServiceInterfaces(hub);
    const disposeScenario = scenario.register(hub);
    const principal = await createSeededMemoryPrincipal({ seed: 0 });
    const host = await McpSocketHost.start({
        label: `eval-${scenario.id}`,
        transport: "http",
        createSession: async () => {
            const hubPair = new TransportPair();
            const upstream = hub.attach(hubPair.b);
            const overlay = new RootOverlay({ uplink: hubPair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: "hub" });
            const participantPair = new TransportPair();
            overlay.connectParticipant(withVerifiedSignature(
                participantPair.a,
                { verifySignatures: true },
            ));
            return {
                serverOptions: {
                    provider: async () => HubSigningSender.create(participantPair.b, principal),
                    onToolCall,
                },
                dispose: () => {
                    overlay.dispose();
                    upstream.dispose();
                    hubPair.a.dispose();
                    hubPair.b.dispose();
                    participantPair.a.dispose();
                    participantPair.b.dispose();
                },
            };
        },
    });
    const endpoint = host.endpoint;
    if (endpoint.kind !== "tcp") {
        host.dispose();
        disposeScenario();
        hubServices.dispose();
        throw new Error("Expected an HTTP MCP endpoint");
    }
    return {
        url: `http://${endpoint.host}:${endpoint.port}${endpoint.requestPath}`,
        authorizationToken: endpoint.authorizationToken,
        dispose: () => {
            host.dispose();
            disposeScenario();
            hubServices.dispose();
        },
    };
}

function createMcpConfig(environment: ScenarioEnvironment): unknown {
    return {
        mcpServers: {
            "linkrpc-eval": {
                type: "http",
                url: environment.url,
                tools: ["runLinkRpcScript"],
                headers: {
                    Authorization: `Bearer ${environment.authorizationToken}`,
                },
            },
        },
    };
}

function createPrompt(scenario: ExploreScenario, llmSeed: number): string {
    return [
        "Use only the linkrpc-eval MCP server and its runLinkRpcScript tool.",
        "Discover the available LinkRPC interfaces with con.explore. Do not execute a domain operation.",
        `Identify the exact fully qualified LinkRPC operation for this task: ${scenario.task}.`,
        "Reply with only serviceId::interfaceId::member and no explanation.",
        `Sample identity (llmSeed): ${llmSeed}.`,
    ].join("\n");
}

interface CopilotResponse {
    readonly content: string;
    readonly model: string | undefined;
    readonly usage: CopilotUsage;
    readonly outputTokens: number | undefined;
}

async function invokeCopilot(
    command: string,
    prompt: string,
    model: string,
    configPath: string,
    cwd: string,
): Promise<CopilotResponse> {
    const invocation = await resolveCopilotInvocation(command, cwd);
    const args = [
        "-p",
        prompt,
        "--output-format=json",
        `--model=${model}`,
        `--additional-mcp-config=@${configPath}`,
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        "--no-ask-user",
        "--no-remote",
        "--no-color",
        "--log-level=none",
        "--allow-tool=linkrpc-eval(runLinkRpcScript)",
        `--session-id=${randomUUID()}`,
    ];
    const { stdout, stderr, exitCode } = await runProcess(
        invocation.command,
        [...invocation.args, ...args],
        cwd,
        invocation.shell,
    );
    if (exitCode !== 0) {
        throw new Error(`Copilot exited with code ${exitCode}: ${stderr || stdout}`);
    }

    let response: Omit<CopilotResponse, "usage"> | undefined;
    let usage: CopilotUsage | undefined;
    const outputTokens: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) {
            continue;
        }
        const event = JSON.parse(line) as {
            type?: string;
            data?: { content?: unknown; model?: unknown; outputTokens?: unknown };
            usage?: unknown;
        };
        if (event.type === "assistant.message"
            && typeof (event.data as { content?: unknown } | undefined)?.content === "string") {
            const data = event.data as { content: string; model?: unknown; outputTokens?: unknown };
            response = {
                content: data.content,
                model: typeof data.model === "string" ? data.model : undefined,
                outputTokens: undefined,
            };
            if (typeof data.outputTokens === "number") {
                outputTokens.push(data.outputTokens);
            }
        } else if (event.type === "result" && isCopilotUsage(event.usage)) {
            usage = event.usage;
        }
    }
    if (!response) {
        throw new Error(`Copilot produced no assistant.message event: ${stdout}`);
    }
    if (!usage) {
        throw new Error(`Copilot produced no result usage: ${stdout}`);
    }
    const metrics = createMetrics(usage, sumDefined(outputTokens));
    if (metrics.cost === undefined) {
        throw new Error(`Copilot result usage contained no billing cost: ${JSON.stringify(usage)}`);
    }
    return { ...response, usage, outputTokens: metrics.outputTokens };
}

async function resolveCopilotInvocation(
    command: string,
    cwd: string,
): Promise<{ readonly command: string; readonly args: readonly string[]; readonly shell: boolean }> {
    if (process.platform !== "win32" || command !== "copilot") {
        return { command, args: [], shell: process.platform === "win32" };
    }

    const located = await runProcess("where.exe", ["copilot.cmd"], cwd, false);
    if (located.exitCode === 0) {
        for (const shim of located.stdout.split(/\r?\n/).filter(Boolean)) {
            const loader = path.join(path.dirname(shim.trim()), "node_modules", "@github", "copilot", "npm-loader.js");
            try {
                await access(loader);
                return { command: process.execPath, args: [loader], shell: false };
            } catch {
                // Try the next shim on PATH.
            }
        }
    }
    return { command: "copilot.cmd", args: [], shell: true };
}

function runProcess(
    command: string,
    args: readonly string[],
    cwd: string,
    shell: boolean,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            windowsHide: true,
            shell,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? -1 }));
    });
}

function isCopilotUsage(value: unknown): value is CopilotUsage {
    return typeof value === "object"
        && value !== null;
}

function createMetrics(
    usage: CopilotUsage,
    outputTokens: number | undefined,
): LinkRpcExploreMetrics {
    const costUnit = typeof usage.aiCredits === "number"
        ? "aiCredits"
        : typeof usage.premiumRequests === "number"
            ? "premiumRequests"
            : undefined;
    return {
        cost: costUnit ? usage[costUnit] as number : undefined,
        costUnit,
        outputTokens,
        apiDurationMs: usage.totalApiDurationMs,
        sessionDurationMs: usage.sessionDurationMs,
    };
}

function summarizeMetrics(metrics: readonly LinkRpcExploreMetrics[]): LinkRpcExploreMetrics {
    const costUnits = new Set(metrics.map((item) => item.costUnit).filter(Boolean));
    const costUnit = costUnits.size === 1
        ? metrics.find((item) => item.costUnit)?.costUnit
        : undefined;
    return {
        cost: costUnit ? sumDefined(metrics.map((item) => item.cost)) : undefined,
        costUnit,
        outputTokens: sumDefined(metrics.map((item) => item.outputTokens)),
        apiDurationMs: sumDefined(metrics.map((item) => item.apiDurationMs)),
        sessionDurationMs: sumDefined(metrics.map((item) => item.sessionDurationMs)),
    };
}

function sumDefined(values: readonly (number | undefined)[]): number | undefined {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length > 0 ? defined.reduce((sum, value) => sum + value, 0) : undefined;
}

function formatMetric(value: number | undefined, fractionDigits = 3): string {
    return value === undefined ? "n/a" : value.toFixed(fractionDigits);
}

function selectScenarios(ids: readonly string[] | undefined): readonly ExploreScenario[] {
    if (!ids || ids.length === 0) {
        return linkRpcExploreScenarios;
    }
    return ids.map(getScenario);
}

function getScenario(id: string): ExploreScenario {
    const scenario = linkRpcExploreScenarios.find((candidate) => candidate.id === id);
    if (!scenario) {
        throw new Error(`Unknown scenario ${JSON.stringify(id)}`);
    }
    return scenario;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isToolError(result: unknown): boolean {
    return typeof result === "object"
        && result !== null
        && (result as { isError?: unknown }).isError === true;
}