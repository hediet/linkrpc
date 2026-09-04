import { describe, expect, it } from 'vitest';
import { loggingInterface, logStreamEventSchema } from './index';

describe('loggingInterface', () => {
    it('uses the LinkRPC namespace and exposes snapshot/patch streaming', () => {
        expect(loggingInterface.info.id).toBe('linkrpc.logging');
        expect(loggingInterface.members.watchLog.serverStreamSchema).toBe(logStreamEventSchema);
        expect(loggingInterface.ref.watchLog).toEqual({
            interfaceId: 'linkrpc.logging',
            interfaceHash: loggingInterface.schemaHash,
            member: 'watchLog',
        });
    });

    it('validates nested structured log entries', () => {
        const parsed = logStreamEventSchema.safeParse({
            type: 'snapshot',
            revision: 1,
            document: {
                schemaVersion: 1,
                service: 'demo',
                startedAt: '2026-09-04T00:00:00.000Z',
                state: { ready: true },
                entries: [{
                    timestamp: '2026-09-04T00:00:01.000Z',
                    level: 'info',
                    message: 'request',
                    entries: [{
                        timestamp: '2026-09-04T00:00:02.000Z',
                        level: 'debug',
                        message: 'child',
                    }],
                }],
            },
        });
        expect(parsed.success).toBe(true);
    });
});
