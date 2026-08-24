import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runApprovalUi } from './runApprovalUi';

const mocks = vi.hoisted(() => {
    const refresh = vi.fn(async () => { });
    const dispose = vi.fn();
    const unmount = vi.fn();
    return {
        refresh,
        dispose,
        unmount,
        render: vi.fn(() => ({
            waitUntilExit: async () => { },
            unmount,
        })),
        ApprovalUiModel: class {
            public readonly refresh = refresh;

            constructor(_client: unknown) { }

            public dispose(): void {
                dispose();
            }
        },
    };
});

vi.mock('ink', () => ({ render: mocks.render }));
vi.mock('./ApprovalUiModel', () => ({ ApprovalUiModel: mocks.ApprovalUiModel }));
vi.mock('./ApprovalApp', () => ({ ApprovalApp: () => null }));

describe('runApprovalUi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('refreshes before waiting and always tears down the Ink tree and model', async () => {
        const signal = new AbortController().signal;
        await runApprovalUi({ client: {} as never, signal });

        expect(mocks.refresh).toHaveBeenCalledOnce();
        expect(mocks.render).toHaveBeenCalledOnce();
        expect(mocks.unmount).toHaveBeenCalledOnce();
        expect(mocks.dispose).toHaveBeenCalledOnce();
    });

    it('unmounts when the command signal is aborted', async () => {
        const stop = new AbortController();
        mocks.refresh.mockImplementationOnce(async () => stop.abort());

        await runApprovalUi({ client: {} as never, signal: stop.signal });

        expect(mocks.unmount).toHaveBeenCalled();
        expect(mocks.dispose).toHaveBeenCalledOnce();
    });
});
