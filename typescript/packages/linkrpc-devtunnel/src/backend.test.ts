import { expect, it } from 'vitest';
import { isSdkCancellation } from './backend';

it('recognizes the Dev Tunnels SDK cancellation error, and only it', () => {
    // Mirrors `@microsoft/dev-tunnels-ssh`'s `CancellationError`, a plain Error subclass.
    class CancellationError extends Error { }
    expect(isSdkCancellation(new CancellationError('Operation cancelled.'))).toBe(true);
    expect(isSdkCancellation(new Error('Operation cancelled.'))).toBe(false);
    expect(isSdkCancellation('Operation cancelled.')).toBe(false);
});
