import { describe, expect, it, vi } from 'vitest';
import { ParticipantConnectorConfigSchema } from '../config';
import { SocketServer } from '../hub/server/node';
import {
    configureParticipants,
    validateConfiguredParticipants,
    type ConfiguredParticipant,
} from './configuredParticipants';

function participant(
    name: string,
    overrides: Record<string, unknown> = {},
): ConfiguredParticipant {
    return {
        name,
        config: ParticipantConnectorConfigSchema.parse({
            kind: 'uri',
            uri: 'wss://hub.example.test',
            ...overrides,
        }),
    };
}

describe('configured participants', () => {
    it('accepts the reusable connector kinds and excludes cmd-env', () => {
        for (const config of [
            { kind: 'uri', uri: 'wss://hub.example.test' },
            { kind: 'ws', url: 'wss://hub.example.test' },
            { kind: 'socket', path: '/tmp/hub.sock' },
            { kind: 'cmd-stdio', argv: ['node', 'service.js'] },
        ]) {
            expect(ParticipantConnectorConfigSchema.safeParse(config).success).toBe(true);
        }
        expect(ParticipantConnectorConfigSchema.safeParse({
            kind: 'cmd-env',
            argv: ['node', 'service.js'],
        }).success).toBe(false);
    });

    it('rejects conflicting routes before starting participants', () => {
        expect(() => validateConfiguredParticipants([
            participant('a', { routeServiceIds: ['shared'] }),
            participant('b', { routeServiceIds: ['shared'] }),
        ])).toThrow(/route conflict/);
    });

    it('rejects more than one default route', () => {
        expect(() => validateConfiguredParticipants([
            participant('a', { defaultRoute: true }),
            participant('b', { defaultRoute: true }),
        ])).toThrow(/default-route conflict/);
    });

    it('disposes an attachment while remote registration is still pending', async () => {
        const server = await SocketServer.start();
        server.setConnectionHandler(() => { });
        const disposeAttachment = vi.fn();
        let attached = false;
        const configured = configureParticipants({
            participants: [{
                name: 'pending',
                config: ParticipantConnectorConfigSchema.parse({
                    kind: 'socket',
                    path: server.endpoint,
                    claimServiceIds: ['pending/service'],
                }),
            }],
            attachParticipant: () => {
                attached = true;
                return {
                    claimPrefix: () => { },
                    setDefaultRoute: () => { },
                    request: () => new Promise(() => { }),
                    dispose: disposeAttachment,
                };
            },
        });

        try {
            await waitFor(() => attached);
            configured.dispose();
            expect(disposeAttachment).toHaveBeenCalledOnce();
        } finally {
            configured.dispose();
            server.dispose();
        }
    });
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('waitFor timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
