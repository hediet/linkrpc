import { describe, expect, it } from "vitest";
import {
    createLinkRpcExplorePrompt,
    scoreLinkRpcExploreOutput,
    type LinkRpcExploreInput,
    type LinkRpcExploreOutput,
} from "./linkRpcExplorePoc";
import { linkRpcExploreScenarios } from "./linkRpcExploreScenarios";

describe("LinkRPC explore evaluation", () => {
    it("uses the exact same prompt for every sample", () => {
        const scenarioId = "workspace-symbol-references";
        const first: LinkRpcExploreInput = {
            scenarioId,
            sampleId: 0,
            model: "test-model",
        };
        const second: LinkRpcExploreInput = {
            scenarioId,
            sampleId: 1,
            model: "test-model",
        };

        const firstPrompt = createLinkRpcExplorePrompt(first.scenarioId);
        const secondPrompt = createLinkRpcExplorePrompt(second.scenarioId);
        expect(firstPrompt).toBe(secondPrompt);
        expect(firstPrompt).not.toMatch(/sample|seed/i);
    });

    it("requires an exact operation answer", () => {
        const input = testInput();
        const exact = testOutput("workbench::vscode.symbolIndex::findReferences");
        const explained = testOutput(
            "Use workbench::vscode.symbolIndex::findReferences for this task.",
        );

        expect(scoreLinkRpcExploreOutput(input, exact).answer.value).toBe(1);
        expect(scoreLinkRpcExploreOutput(input, explained).answer.value).toBe(0);
    });

    it("scores successful exploration and actual nested call count", () => {
        const input = testInput();
        const efficient = testOutput("wrong", [
            { arguments: { kind: "grep" }, result: { kind: "grep", entries: [] } },
            { arguments: { kind: "inspect" }, result: { kind: "inspect" } },
        ]);
        const noisy = testOutput("wrong", [
            { arguments: { kind: "grep" }, error: "invalid pattern" },
            { arguments: { kind: "browse" }, result: { kind: "browse", entries: [] } },
            { arguments: { kind: "grep" }, result: { kind: "grep", entries: [] } },
            { arguments: { kind: "inspect" }, result: { kind: "inspect" } },
            { arguments: { kind: "inspect" }, result: { kind: "inspect" } },
        ]);

        expect(scoreLinkRpcExploreOutput(input, efficient)).toMatchObject({
            explore: { value: 1 },
            efficiency: { value: 1 },
        });
        expect(scoreLinkRpcExploreOutput(input, noisy)).toMatchObject({
            explore: {
                value: 1,
                details: { successfulExploreCalls: 4, failedExploreCalls: 1 },
            },
            efficiency: { value: 0 },
        });
    });

    it("provides varied tasks with unique expected operations", () => {
        expect(linkRpcExploreScenarios).toHaveLength(6);
        expect(new Set(linkRpcExploreScenarios.map((scenario) => scenario.expectedOperation)).size)
            .toBe(linkRpcExploreScenarios.length);
        expect(new Set(linkRpcExploreScenarios.map((scenario) =>
            scenario.expectedOperation.split("::")[0]
        )).size).toBe(6);
    });
});

function testInput(): LinkRpcExploreInput {
    return {
        scenarioId: "workspace-symbol-references",
        sampleId: 0,
        model: "test-model",
    };
}

function testOutput(
    answer: string,
    exploreCalls: LinkRpcExploreOutput["exploreCalls"] = [
        { arguments: { kind: "grep" }, result: { kind: "grep", entries: [] } },
    ],
): LinkRpcExploreOutput {
    return {
        answer,
        model: "test-model",
        toolCalls: [],
        exploreCalls,
        usage: { aiCredits: 1 },
        metrics: {
            cost: 1,
            costUnit: "aiCredits",
            outputTokens: 10,
            apiDurationMs: 100,
            sessionDurationMs: 200,
        },
    };
}
