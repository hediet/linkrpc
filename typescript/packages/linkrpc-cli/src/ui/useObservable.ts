import { useEffect, useReducer, useRef } from "react";
import { autorun, type IObservable } from "@vscode/observables";

/**
 * Minimal React hook that subscribes a component to an observable value.
 *
 * We don't pull in `@vscode/observables-react` here because it imports
 * `react-dom` (for `unstable_batchedUpdates`), which doesn't exist on the
 * terminal renderer (`ink`). The mechanics are the same — `autorun` plus a
 * `useReducer`-driven forceUpdate.
 */
export function useObservable<T>(obs: IObservable<T>): T {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
    const valueRef = useRef<{ value: T } | undefined>(undefined);

    useEffect(() => {
        const disposable = autorun((reader) => {
            const v = obs.read(reader);
            const prev = valueRef.current;
            valueRef.current = { value: v };
            if (prev !== undefined) forceUpdate();
        });
        return () => disposable.dispose();
    }, [obs]);

    if (valueRef.current === undefined) {
        // First render: read the current value without subscribing.
        // `get()` skips the reader-based dependency tracking.
        valueRef.current = { value: obs.get() };
    }
    return valueRef.current.value;
}
