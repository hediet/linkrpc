#!/usr/bin/env node
import { hostComputeNode } from './index';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log([
        'Usage: linkrpc-compute-node',
        '',
        'Serve shell, file system, HTTP, TCP, and keep-awake access to this machine as',
        'linkrpc.computeNode.* under the service ID the hub grants. Connects to',
        'LINKRPC_ENDPOINT (set by the hub daemon for its services).',
    ].join('\n'));
    process.exit(0);
}

try {
    const host = await hostComputeNode();
    console.log('compute node ready');
    await host.done;
    process.exit(0);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
