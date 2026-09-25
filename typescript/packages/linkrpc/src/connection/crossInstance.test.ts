import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TransportPair } from '../transport/messageTransport';

describe('independent core module instances', () => {
    it('groups, registers and dispatches members authored by another copy', async () => {
        const authoring = await Promise.all([
            import('../schema/defineInterfaceTemplate'),
            import('../schema/memberTypes'),
        ]);
        vi.resetModules();
        const [definitions, connection, receivingMembers] = await Promise.all([
            import('./interfaceDefinition'),
            import('./linkRpcConnection'),
            import('../schema/memberTypes'),
        ]);
        const [authoringTemplates, authoredMembers] = authoring;
        expect(authoredMembers.RequestType).not.toBe(receivingMembers.RequestType);

        const Echo = authoringTemplates.defineInterfaceTemplate(
            { id: 'cross-copy.echo', parameters: ['Value'] },
            <V>({ Value }: { Value: import('../schema/memberTypes').Schema<V> }) => ({
                watch: authoredMembers.requestType(Value, Value).withStream({ server: Value }),
                changed: authoredMembers.notificationType(Value),
            }),
        );
        const iface = definitions.defineInterface({ id: 'cross-copy' }, {
            workspace: Echo({ Value: z.string() }),
        });
        expect(Object.keys(iface.members)).toEqual(['workspace$watch', 'workspace$changed']);
        expect(iface.toSchema()['x-interface-templates']).toMatchObject({
            instances: [{ name: 'workspace', members: { watch: 'workspace$watch', changed: 'workspace$changed' } }],
        });

        const transports = new TransportPair();
        const server = connection.LinkRpcConnection.fromTransport(transports.a);
        const client = connection.LinkRpcConnection.fromTransport(transports.b);
        try {
            let changed = '';
            let onChanged!: () => void;
            const notificationReceived = new Promise<void>(resolve => { onChanged = resolve; });
            server.register(iface, {
                workspace: {
                    watch: async (value, _ctx, stream) => {
                        await stream.send(value);
                        return value.toUpperCase();
                    },
                    changed: value => { changed = value; onChanged(); },
                },
            });
            expect(() => client.getBare(iface)).toThrow(/streaming method/);
            const remote = client.get(iface);
            let streamed = '';
            expect(await remote.workspace.watch('hello', { onMessage: value => { streamed = value; } })).toBe('HELLO');
            expect(streamed).toBe('hello');
            remote.workspace.changed('updated');
            await notificationReceived;
            expect(changed).toBe('updated');
        } finally {
            client.close();
            server.close();
        }
    });
});
