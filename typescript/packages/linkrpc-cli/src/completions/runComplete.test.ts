import { describe, expect, it } from 'vitest';
import type { DirectorySource } from './directorySource';
import { completeForLine } from './runComplete';

const directory: DirectorySource = {
    entries: async () => [{
        serviceId: 'service',
        interfaceId: 'example.greeter',
        hash: 'hash',
    }],
    methodsOnInterface: async () => ['hello'],
    paramNamesForMethod: async () => ['name'],
};

describe('completeForLine', () => {
    it('resolves dynamic slots below the linkrpc hub profile', async () => {
        const line = 'linkrpc hub call ';
        const result = await completeForLine({
            line,
            point: line.length,
            directoryOverride: directory,
        });

        expect(result.slot).toMatchObject({ kind: 'positional', type: 'methodRef' });
        expect(result.candidates.map((candidate) => candidate.text)).toContain('service');
    });
});
