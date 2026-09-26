import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IRequestSender, RawStreamingCall } from '../../connection/channel';
import { DEFAULT_RPC_TIMEOUT_MS } from '../../connection/requestTimeout';
import type { SigningCallCtx } from '../../identity/signingSender';
import type { JsonValue } from '../../protocol/jsonValue';
import { fetchSchema } from './directoryWalk';

afterEach(() => vi.useRealTimers());

function sender(result: Promise<JsonValue>) {
    const call = {
        result, send: vi.fn(), cancel: vi.fn(), dispose: vi.fn(), ping: vi.fn(async () => {}),
    } satisfies RawStreamingCall;
    const channel = {
        sendRequest: vi.fn(async () => null),
        sendNotification: vi.fn(async () => {}),
        sendRequestWithStream: vi.fn(() => call),
        close: vi.fn(),
    } satisfies IRequestSender<SigningCallCtx>;
    return { channel, call };
}

describe('fetchSchema', () => {
    it('preserves addressed schema requests and clears the deadline on success', async () => {
        vi.useFakeTimers();
        const schema = { id: 'example', hash: 'abc', methods: {} };
        const { channel, call } = sender(Promise.resolve({ schema }));
        await expect(fetchSchema(channel, 'example', 'abc', 'cloud/service', 8000)).resolves.toEqual(schema);
        expect(channel.sendRequestWithStream).toHaveBeenCalledWith(
            'cloud/service::hubrpc.schemas::get', { interfaceId: 'example', hash: 'abc' },
        );
        expect(channel.sendRequest).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(8000);
        expect(call.cancel).not.toHaveBeenCalled();
        expect(call.dispose).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels and disposes a stalled schema request at the explicit deadline', async () => {
        vi.useFakeTimers();
        const { channel, call } = sender(new Promise(() => {}));
        const pending = fetchSchema(channel, 'example', undefined, 'cloud/service', 25);
        const rejected = expect(pending).rejects.toThrow("hub schema 'example' at 'cloud/service' timed out after 25ms");
        await vi.advanceTimersByTimeAsync(24);
        expect(call.cancel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(call.cancel).toHaveBeenCalledTimes(1);
        expect(call.dispose).toHaveBeenCalledTimes(1);
        expect(call.dispose).toHaveBeenCalledWith(call.cancel.mock.calls[0]?.[0]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds legacy four-argument and root calls by the default deadline', async () => {
        vi.useFakeTimers();
        const { channel, call } = sender(new Promise(() => {}));
        const pending = fetchSchema(channel, 'example', undefined);
        const rejected = expect(pending).rejects.toThrow(`timed out after ${DEFAULT_RPC_TIMEOUT_MS}ms`);
        await vi.advanceTimersByTimeAsync(DEFAULT_RPC_TIMEOUT_MS);
        await rejected;
        expect(channel.sendRequestWithStream).toHaveBeenCalledWith(
            'hubrpc.schemas::get', { interfaceId: 'example' },
        );
        expect(call.cancel).toHaveBeenCalledTimes(1);
        expect(call.dispose).toHaveBeenCalledTimes(1);
    });
});
