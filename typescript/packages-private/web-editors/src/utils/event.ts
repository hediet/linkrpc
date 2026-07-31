export interface IDisposable {
    dispose(): void;
}

export type EventListener<T> = (event: T) => void;
export type Event<T> = (listener: EventListener<T>) => IDisposable;

export class Emitter<T> {
    private readonly _listeners = new Set<EventListener<T>>();

    public readonly event: Event<T> = (listener) => {
        this._listeners.add(listener);
        return { dispose: () => this._listeners.delete(listener) };
    };

    public fire(value: T): void {
        for (const listener of this._listeners) {
            try {
                listener(value);
            } catch (e) {
                console.error("Emitter listener threw:", e);
            }
        }
    }

    public dispose(): void {
        this._listeners.clear();
    }
}
