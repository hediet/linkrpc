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
    const samples: number[] = [];
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
        } else if (arg === "--sample" && value) {
            const sample = Number(value);
            if (!Number.isInteger(sample)) {
                throw new Error(`Invalid sample ${JSON.stringify(value)}`);
            }
            samples.push(sample);
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
        samples: samples.length > 0 ? samples : undefined,
    });
}

function printHelp(): void {
    console.log(`Usage: eval-runner linkrpc-explore [options]

Runs the LinkRPC interface-discovery scenarios with three independent samples.
Default models: ${defaultLinkRpcExploreModels.join(", ")}.

Options:
  --recordings <path>  Append-only recording directory
  --copilot <command>  Copilot CLI command (default: copilot)
  --model <id>         Run only this model (repeatable)
  --scenario <id>      Run only this scenario (repeatable)
  --sample <number>    Run only this sample id (repeatable)`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
});