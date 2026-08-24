import React from 'react';
import { render } from 'ink';
import type { ApprovalCommandClient } from '../commands/approval';
import { ApprovalApp } from './ApprovalApp';
import { ApprovalUiModel } from './ApprovalUiModel';

export interface RunApprovalUiOptions {
    readonly client: ApprovalCommandClient;
    readonly signal: AbortSignal;
}

export async function runApprovalUi(options: RunApprovalUiOptions): Promise<void> {
    const model = new ApprovalUiModel(options.client);
    const instance = render(<ApprovalApp model={model} />);
    const onAbort = () => instance.unmount();
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    try {
        await raceAbort(model.refresh(), options.signal);
        if (options.signal.aborted) return;
        await instance.waitUntilExit();
    } finally {
        options.signal.removeEventListener('abort', onAbort);
        instance.unmount();
        model.dispose();
    }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            resolve(undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}
