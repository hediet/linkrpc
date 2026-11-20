import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    defineInterface,
    LinkRpcConnection,
    requestType,
    TransportPair,
} from '@hediet/linkrpc';
import { connectViaTransport } from '@hediet/linkrpc-client-internal';
import {
    defineServiceCliInterface,
    runServiceApp,
    type ServiceAppOptions,
} from './serviceCli';

const pipelinesInterface = defineInterface(
    { id: 'demo.pipelines', description: 'Demo pipelines interface' },
    {
        listRuns: requestType(
            z.object({
                repository: z.string().optional().describe('GitHub owner/name'),
                pipelineId: z.number().int().describe('Pipeline ID'),
                failedOnly: z.boolean().optional(),
                grep: z.object({
                    pattern: z.string(),
                    ignoreCase: z.boolean().optional(),
                }).optional(),
            }),
            z.object({
                runs: z.array(z.object({ id: z.number(), status: z.string() })),
            }),
            { description: 'List recent runs.', annotations: { readOnly: true } },
        ),
        queueRun: requestType(
            z.object({ pipelineId: z.number().int() }),
            z.object({ id: z.number() }),
            { description: 'Queue a new run.', annotations: { dangerous: true } },
        ).withStream({ server: z.object({ progress: z.string() }) }),
    },
);

const statusInterface = defineInterface(
    { id: 'demo.status', description: 'Service status' },
    {
        ping: requestType(
            z.object({}),
            z.object({ ok: z.boolean() }),
            { description: 'Health check.', annotations: { readOnly: true } },
        ),
    },
);

function captureStream() {
    const stream = new PassThrough();
    let text = '';
    stream.on('data', chunk => { text += String(chunk); });
    return { stream, text: () => text };
}

function makeHarness(overrides: Partial<ServiceAppOptions> = {}) {
    const receivedCalls: { method: string; params: unknown }[] = [];
    const servers: LinkRpcConnection[] = [];

    const stdout = captureStream();
    const stderr = captureStream();
    const serve = vi.fn(async () => {});
    const connect = vi.fn(async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.b);
        server.register(pipelinesInterface, {
            listRuns: async params => {
                receivedCalls.push({ method: 'listRuns', params });
                return { runs: [{ id: 101, status: 'completed' }] };
            },
            queueRun: async (params, _ctx, stream) => {
                receivedCalls.push({ method: 'queueRun', params });
                await stream.send({ progress: 'queued' });
                return { id: 202 };
            },
        }, { serviceId: 'demo/svc' });
        server.register(statusInterface, {
            ping: async params => {
                receivedCalls.push({ method: 'ping', params });
                return { ok: true };
            },
        }, { serviceId: 'demo/svc' });
        servers.push(server);
        const conn = connectViaTransport(pair.a);
        return { channel: conn.channel, close: () => { conn.close(); server.close(); } };
    });

    const baseOptions: ServiceAppOptions = {
        name: 'demo-cli',
        description: 'Demo service and CLI',
        defaultServiceId: 'demo/svc',
        interfaces: [
            defineServiceCliInterface({
                interface: pipelinesInterface,
                command: 'pipelines',
                fillParams: (params, { paramNames }) => {
                    if (paramNames.has('repository') && params.repository === undefined) {
                        return { ...params, repository: 'acme/app' };
                    }
                    return params;
                },
                formatResult: {
                    listRuns: r => r.runs.map(run => `#${run.id} ${run.status}`).join('\n'),
                },
            }),
            defineServiceCliInterface({
                interface: statusInterface,
                command: 'status',
            }),
        ],
        serve,
        connect,
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        isTty: false,
        ...overrides,
    };

    return {
        options: baseOptions,
        receivedCalls,
        serve,
        connect,
        stdout,
        stderr,
        dispose: () => { for (const s of servers) s.close(); },
    };
}

describe('runServiceApp', () => {
    it('routes serve subcommand and LINKRPC_ENDPOINT to serve(), while --cli overrides env', async () => {
        const h1 = makeHarness();
        try {
            await runServiceApp(h1.options, ['serve', '--az', '/bin/az']);
            expect(h1.serve).toHaveBeenCalledWith(['--az', '/bin/az']);
            expect(h1.connect).not.toHaveBeenCalled();
        } finally { h1.dispose(); }

        const h2 = makeHarness({ env: { LINKRPC_ENDPOINT: 'npipe://./pipe/test' } });
        try {
            await runServiceApp(h2.options, ['--az', '/bin/az']);
            expect(h2.serve).toHaveBeenCalledWith(['--az', '/bin/az']);
            expect(h2.connect).not.toHaveBeenCalled();
        } finally { h2.dispose(); }

        const h3 = makeHarness({ env: { LINKRPC_ENDPOINT: 'npipe://./pipe/test' } });
        try {
            await runServiceApp(h3.options, ['--cli', 'status', 'ping']);
            expect(h3.serve).not.toHaveBeenCalled();
            expect(JSON.parse(h3.stdout.text())).toEqual({ ok: true });
        } finally { h3.dispose(); }
    });

    it('renders offline root, group, and method help with annotations without connecting', async () => {
        const h = makeHarness();
        try {
            await runServiceApp(h.options, ['--help']);
            expect(h.stdout.text()).toContain('demo-cli — Demo service and CLI');
            expect(h.stdout.text()).toContain('pipelines');
            expect(h.stdout.text()).toContain('status');
            expect(h.connect).not.toHaveBeenCalled();

            const gOut = captureStream();
            await runServiceApp({ ...h.options, stdout: gOut.stream }, ['pipelines', '--help']);
            expect(gOut.text()).toContain('list-runs');
            expect(gOut.text()).toContain('[readOnly]');
            expect(gOut.text()).toContain('queue-run');
            expect(gOut.text()).toContain('[dangerous]');

            const mOut = captureStream();
            await runServiceApp({ ...h.options, stdout: mOut.stream }, ['pipelines', 'list-runs', '--help']);
            expect(mOut.text()).toContain('--pipeline-id <integer>');
            expect(mOut.text()).toContain('required');
            expect(mOut.text()).toContain('--repository <string>');
            expect(h.connect).not.toHaveBeenCalled();
        } finally { h.dispose(); }
    });

    it('parses kebab-case, nested dot-paths, boolean shortcuts, and applies schema-aware fillParams', async () => {
        const h = makeHarness();
        try {
            await runServiceApp(h.options, [
                'pipelines', 'list-runs',
                '--pipeline-id', '421',
                '--failed-only',
                '--grep.pattern', 'ERR',
                '--grep.ignore-case',
            ]);
            expect(h.receivedCalls).toEqual([{
                method: 'listRuns',
                params: {
                    repository: 'acme/app',
                    pipelineId: 421,
                    failedOnly: true,
                    grep: { pattern: 'ERR', ignoreCase: true },
                },
            }]);

            // queueRun has no `repository` param, so fillParams does not inject it.
            await runServiceApp(h.options, ['pipelines', 'queue-run', '--pipeline-id', '421']);
            expect(h.receivedCalls[1]).toEqual({
                method: 'queueRun',
                params: { pipelineId: 421 },
            });
            expect(h.stderr.text()).toContain('{"progress":"queued"}');
        } finally { h.dispose(); }
    });

    it('uses formatResult on TTY and JSON when piped or --json is set', async () => {
        const hTty = makeHarness({ isTty: true });
        try {
            await runServiceApp(hTty.options, ['pipelines', 'list-runs', '--pipeline-id', '421']);
            expect(hTty.stdout.text()).toBe('#101 completed\n');
        } finally { hTty.dispose(); }

        const hJson = makeHarness({ isTty: true });
        try {
            await runServiceApp(hJson.options, ['pipelines', 'list-runs', '--pipeline-id', '421', '--json']);
            expect(JSON.parse(hJson.stdout.text())).toEqual({ runs: [{ id: 101, status: 'completed' }] });
        } finally { hJson.dispose(); }
    });

    it('supports flat commands for a single unnamed interface and validates offline', async () => {
        const h = makeHarness({
            interfaces: [defineServiceCliInterface({ interface: pipelinesInterface })],
        });
        try {
            await expect(runServiceApp(h.options, ['list-runs', '--pipline-id', '421']))
                .rejects.toThrow('Did you mean --pipeline-id?');
            await expect(runServiceApp(h.options, ['list-runs']))
                .rejects.toThrow('Parameter validation failed:');
            expect(h.connect).not.toHaveBeenCalled();

            await runServiceApp(h.options, ['list-runs', '--pipeline-id', '7']);
            expect(h.receivedCalls).toEqual([{ method: 'listRuns', params: { pipelineId: 7 } }]);
        } finally { h.dispose(); }
    });

    it('dispatches extraCommands with connected context', async () => {
        const extra = vi.fn(async (args, ctx) => {
            ctx.stdout.write(`extra:${ctx.serviceId}:${args.join(',')}\n`);
        });
        const h = makeHarness({ extraCommands: { watch: extra } });
        try {
            await runServiceApp(h.options, ['--service', 'custom/svc', 'watch', '123']);
            expect(h.stdout.text()).toBe('extra:custom/svc:123\n');
        } finally { h.dispose(); }
    });
});
