import { h } from './dom';

/** A table column whose max width the user can drag; cells truncate with an ellipsis beyond it. */
export interface ResizableColumn {
    readonly id: string;
    readonly title: string;
    readonly defaultMaxWidth: number;
}

const MIN_WIDTH = 40;
const MAX_WIDTH = 2_000;

/**
 * Max widths of resizable columns, applied as `--col-<id>` CSS variables on a
 * container, so dragging restyles every row without re-rendering.
 */
export class ColumnWidths {
    private _custom: Record<string, number> = {};

    constructor(
        private readonly _container: HTMLElement,
        private readonly _columns: readonly ResizableColumn[],
        /** Called when a drag or reset finishes. */
        private readonly _onDidChange: () => void,
    ) {
        this._apply();
    }

    public get custom(): Readonly<Record<string, number>> {
        return this._custom;
    }

    public set(custom: Readonly<Record<string, number>>): void {
        this._custom = { ...custom };
        this._apply();
    }

    /** A cell's content wrapper, limited to its column's max width. */
    public cell(column: ResizableColumn, props: Record<string, unknown>, ...children: Array<Node | string | undefined | false>): HTMLElement {
        const element = h('div', { ...props, class: `cell ${(props.class as string | undefined) ?? ''}`.trim() }, ...children);
        element.style.maxWidth = `var(--col-${column.id})`;
        return element;
    }

    /** A header cell with a drag handle on its right edge; double-click the handle to reset. */
    public header(column: ResizableColumn): HTMLElement {
        const content = this.cell(column, {}, column.title);
        const handle = h('span', { class: 'col-resizer', title: 'Drag to set the max width · double-click to reset' });
        handle.addEventListener('pointerdown', event => this._drag(event, column, content, handle));
        handle.addEventListener('dblclick', () => {
            const { [column.id]: _removed, ...rest } = this._custom;
            this._custom = rest;
            this._apply();
            this._onDidChange();
        });
        handle.addEventListener('click', event => event.stopPropagation());
        return h('th', { class: 'resizable' }, content, handle);
    }

    private _drag(event: PointerEvent, column: ResizableColumn, content: HTMLElement, handle: HTMLElement): void {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = content.getBoundingClientRect().width;
        const onMove = (move: PointerEvent) => {
            const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + move.clientX - startX)));
            this._custom = { ...this._custom, [column.id]: width };
            this._container.style.setProperty(`--col-${column.id}`, `${width}px`);
        };
        const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            this._onDidChange();
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    }

    private _apply(): void {
        for (const column of this._columns) {
            this._container.style.setProperty(`--col-${column.id}`, `${this._custom[column.id] ?? column.defaultMaxWidth}px`);
        }
    }
}
