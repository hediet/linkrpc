import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getHubEnvironment, requireHubEndpoint } from './hubClient';

beforeEach(() => {
    for (const name of ['LINKRPC_ENDPOINT', 'LINKRPC_TOKEN', 'HUBRPC_ENDPOINT', 'HUBRPC_TOKEN']) {
        vi.stubEnv(name, undefined);
    }
});
afterEach(() => vi.unstubAllEnvs());

it('resolves legacy endpoint and token together', () => {
    vi.stubEnv('HUBRPC_ENDPOINT', 'legacy');
    vi.stubEnv('HUBRPC_TOKEN', 'legacy-token');
    vi.stubEnv('LINKRPC_TOKEN', 'different-hub-token');
    expect(getHubEnvironment()).toEqual({ endpoint: 'legacy', token: 'legacy-token' });
    expect(requireHubEndpoint()).toBe('legacy');
});

it('prefers the canonical pair without falling back to another hub token', () => {
    vi.stubEnv('LINKRPC_ENDPOINT', 'canonical');
    vi.stubEnv('HUBRPC_ENDPOINT', 'legacy');
    vi.stubEnv('HUBRPC_TOKEN', 'legacy-token');
    expect(getHubEnvironment()).toEqual({ endpoint: 'canonical', token: undefined });
    vi.stubEnv('LINKRPC_TOKEN', '');
    expect(getHubEnvironment()).toEqual({ endpoint: 'canonical', token: '' });
    vi.stubEnv('LINKRPC_TOKEN', 'canonical-token');
    expect(getHubEnvironment()).toEqual({ endpoint: 'canonical', token: 'canonical-token' });
});

it('preserves explicit endpoint precedence and rejects an empty canonical endpoint', () => {
    vi.stubEnv('LINKRPC_ENDPOINT', '');
    vi.stubEnv('HUBRPC_ENDPOINT', 'legacy');
    expect(() => requireHubEndpoint()).toThrow('LINKRPC_ENDPOINT (or HUBRPC_ENDPOINT) is not set');
    expect(requireHubEndpoint(' explicit ')).toBe('explicit');
});

it('resolves token-only environments for explicit endpoint callers', () => {
    vi.stubEnv('HUBRPC_TOKEN', 'legacy-token');
    expect(getHubEnvironment()).toEqual({ endpoint: undefined, token: 'legacy-token' });
    vi.stubEnv('LINKRPC_TOKEN', '');
    expect(getHubEnvironment()).toEqual({ endpoint: undefined, token: '' });
    expect(() => requireHubEndpoint()).toThrow('LINKRPC_ENDPOINT (or HUBRPC_ENDPOINT) is not set');
});
