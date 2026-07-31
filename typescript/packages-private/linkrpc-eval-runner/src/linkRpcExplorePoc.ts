import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
    createSeededMemoryPrincipal,
    TransportPair,
} from "@hediet/linkrpc";
import { HubSigningSender } from "@hediet/linkrpc/hub/client";
import {
    createHubServiceInterfaces,
    Hub,
    registerHubServices,
    RootOverlay,
    withVerifiedSignature,
} from "@hediet/linkrpc-hub/hub/server";
import type { McpExploreCall, McpToolCall } from "@hediet/linkrpc-mcp";
import { McpSocketHost } from "@hediet/linkrpc-mcp/node";
import { evaluate, type Score, type Scorer } from "./evaluation";
import { FileRecordingStore } from "./fileRecordingStore";
import {
    getLinkRpcExploreScenario,
    linkRpcExploreScenarios,
    registerLinkRpcExploreCatalog,
    type ExploreScenario,
} from "./linkRpcExploreScenarios";
import {
    hashValue,
    RecordingCache,
    type RecordableFunction,
    type ValidationResult,
} from "./recordingCache";

export interface LinkRpcExploreInput {
    readonly scenarioId: string;
    readonly sampleId: number;
    readonly model: string;
}

export interface LinkRpcExploreOutput {
    readonly answer: string;
    readonly model: string | undefined;
    readonly toolCalls: readonly McpToolCall[];
    readonly exploreCalls: readonly McpExploreCall[];
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
    readonly samples?: readonly number[];
}

export const defaultLinkRpcExploreModels = [
    "claude-haiku-4.5",
    "gpt-5.4-mini",
    "gpt-5.6-luna",
] as const;

export async function runLinkRpcExplorePoc(options: LinkRpcExplorePocOptions): Promise<void> {
    const scenarios = selectScenarios(options.scenarios);
    const samples = options.samples ?? [0, 1, 2];
    const models = options.models ?? defaultLinkRpcExploreModels;
    const inputs = scenarios.flatMap((scenario) =>
        models.flatMap((model) =>
            samples.map((sampleId) => ({ scenarioId: scenario.id, sampleId, model })),
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
            + ` sample=${result.input.sampleId} ${result.output.cacheKind}`
            + ` answer=${scores.answer} explore=${scores.explore} efficiency=${scores.efficiency}`
            + ` toolCalls=${result.output.toolCalls.length}`
            + ` exploreCalls=${result.output.exploreCalls.length}`
            + ` cost=${formatMetric(result.output.metrics.cost)}`
            + ` costUnit=${result.output.metrics.costUnit ?? "n/a"}`
            + ` outputTokens=${formatMetric(result.output.metrics.outputTokens, 0)}`,
        );
        console.log(`  ${result.output.answer.replace(/\s+/g, " ").trim()}`);
    }

    const metrics = summarizeMetrics(results.map((result) => result.output.metrics));
    console.log(
        `runs=${results.length}`
        + ` answer=${averageScore(results, "answer").toFixed(3)}`
        + ` explore=${averageScore(results, "explore").toFixed(3)}`
        + ` efficiency=${averageScore(results, "efficiency").toFixed(3)}`
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
    public readonly version = "6";

    public constructor(private readonly _copilotCommand: string) { }

    public async run(input: LinkRpcExploreInput): Promise<{
        readonly output: LinkRpcExploreOutput;
        readonly evidence: readonly McpToolCall[];
    }> {
        const scenario = getScenario(input.scenarioId);
        const toolCalls: McpToolCall[] = [];
        const exploreCalls: McpExploreCall[] = [];
        const environment = await startScenarioEnvironment(
            scenario,
            (call) => toolCalls.push(call),
            (call) => exploreCalls.push(call),
        );
        const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "linkrpc-explore-eval-"));
        try {
            const configPath = path.join(temporaryDirectory, "mcp.json");
            await writeFile(configPath, JSON.stringify(createMcpConfig(environment), undefined, 2));
            const response = await invokeCopilot(
                this._copilotCommand,
                createLinkRpcExplorePrompt(scenario.id),
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
                exploreCalls: [...exploreCalls],
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

export interface LinkRpcExploreScores {
    readonly answer: Score;
    readonly explore: Score;
    readonly efficiency: Score;
}

export function scoreLinkRpcExploreOutput(
    input: LinkRpcExploreInput,
    output: LinkRpcExploreOutput,
): LinkRpcExploreScores {
    const expected = getScenario(input.scenarioId).expectedOperation;
    const actual = output.answer.trim();
    const successfulExploreCalls = output.exploreCalls.filter((call) => "result" in call).length;
    const exploreCallCount = output.exploreCalls.length;
    return {
        answer: {
            name: "answer",
            value: actual === expected ? 1 : 0,
            details: { expected, actual },
        },
        explore: {
            name: "explore",
            value: successfulExploreCalls > 0 ? 1 : 0,
            details: {
                successfulExploreCalls,
                failedExploreCalls: exploreCallCount - successfulExploreCalls,
            },
        },
        efficiency: {
            name: "efficiency",
            value: exploreCallCount === 0
                ? 0
                : exploreCallCount <= 2
                    ? 1
                    : exploreCallCount <= 4
                        ? 0.5
                        : 0,
            details: { exploreCalls: exploreCallCount },
        },
    };
}

const exploreScorers: readonly Scorer<LinkRpcExploreInput, LinkRpcExploreEvaluationOutput>[] = [
    (input, output) => scoreLinkRpcExploreOutput(input, output).answer,
    (input, output) => scoreLinkRpcExploreOutput(input, output).explore,
    (input, output) => scoreLinkRpcExploreOutput(input, output).efficiency,
];

interface ScenarioEnvironment {
    readonly url: string;
    readonly authorizationToken: string;
    dispose(): void;
}

async function startScenarioEnvironment(
    scenario: ExploreScenario,
    onToolCall?: (call: McpToolCall) => void,
    onExploreCall?: (call: McpExploreCall) => void,
): Promise<ScenarioEnvironment> {
    const hub = new Hub({ debugName: `eval-${scenario.id}` });
    const hubServices = createHubServiceInterfaces(hub);
    const disposeScenario = registerLinkRpcExploreCatalog(hub);
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
                    onExploreCall,
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

export function createLinkRpcExplorePrompt(scenarioId: string): string {
    const scenario = getScenario(scenarioId);
    return [
        "Use only the linkrpc-eval MCP server and its runLinkRpcScript tool.",
        "Discover the available LinkRPC interfaces with con.explore. Do not execute a domain operation.",
        `Identify the exact fully qualified LinkRPC operation for this task: ${scenario.task}.`,
        "Reply with only serviceId::interfaceId::member and no explanation.",
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

function averageScore(
    results: readonly { readonly scores: readonly Score[] }[],
    name: string,
): number {
    const values = results.flatMap((result) =>
        result.scores.filter((score) => score.name === name).map((score) => score.value)
    );
    return values.length === 0
        ? 0
        : values.reduce((sum, value) => sum + value, 0) / values.length;
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
    return getLinkRpcExploreScenario(id);
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isToolError(result: unknown): boolean {
    return typeof result === "object"
        && result !== null
        && (result as { isError?: unknown }).isError === true;
}