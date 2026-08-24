/** Minimal disposable handle; calling `dispose` releases the resource. */

export interface IDisposable {
    dispose(): void;
}
