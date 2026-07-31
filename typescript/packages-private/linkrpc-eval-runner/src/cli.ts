#!/usr/bin/env node
import path from "node:path";
import { defaultLinkRpcExploreModels, runLinkRpcExplorePoc } from "./linkRpcExplorePoc";

async function main(): Promise<void> {
    const [command, ...args] = process.argv.slice(2);
    if (command === "--help" || command === "-h" || command === undefined) {
        printHelp();
        return;
    }
    if (command !== "linkrpc-explore") {
        throw new Error(`Unknown command ${JSON.stringify(command)}`);
    }

    const scenarios: string[] = [];
    const seeds: number[] = [];
    const models: string[] = [];
    let recordingsDirectory = path.resolve(".eval-recordings", "linkrpc-explore");
    let copilotCommand: string | undefined;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const value = args[index + 1];
        if (arg === "--recordings" && value) {
            recordingsDirectory = path.resolve(value);
            index++;
        } else if (arg === "--model" && value) {
            models.push(value);
            index++;
        } else if (arg === "--copilot" && value) {
            copilotCommand = value;
            index++;
        } else if (arg === "--scenario" && value) {
            scenarios.push(value);
            index++;
        } else if (arg === "--seed" && value) {
            const seed = Number(value);
            if (!Number.isInteger(seed)) {
                throw new Error(`Invalid seed ${JSON.stringify(value)}`);
            }
            seeds.push(seed);
            index++;
        } else {
            throw new Error(`Unknown or incomplete option ${JSON.stringify(arg)}`);
        }
    }

    await runLinkRpcExplorePoc({
        recordingsDirectory,
        copilotCommand,
        models: models.length > 0 ? models : undefined,
        scenarios: scenarios.length > 0 ? scenarios : undefined,
        seeds: seeds.length > 0 ? seeds : undefined,
    });
}

function printHelp(): void {
    console.log(`Usage: eval-runner linkrpc-explore [options]

Runs two LinkRPC interface-discovery scenarios with llmSeed 0, 1, and 2.
Default models: ${defaultLinkRpcExploreModels.join(", ")}.

Options:
  --recordings <path>  Append-only recording directory
    --copilot <command>  Copilot CLI command (default: copilot)
    --model <id>         Run only this model (repeatable)
  --scenario <id>      Run only this scenario (repeatable)
  --seed <number>      Run only this llmSeed (repeatable)`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
});