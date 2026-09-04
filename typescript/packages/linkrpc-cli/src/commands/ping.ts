import type { CliChannel } from "@hediet/linkrpc-client";

export async function pingCommand(channel: CliChannel): Promise<string> {
    const start = performance.now();
    await channel.sendRequest("hubrpc.defaults::get", {});
    const latencyMs = performance.now() - start;
    return `pong  ${latencyMs.toFixed(1)}ms`;
}
