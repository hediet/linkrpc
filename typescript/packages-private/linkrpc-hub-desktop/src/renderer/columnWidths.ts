import { h } from './dom';

/** A table column the user can resize; cells truncate with an ellipsis at its edge. */
export interface ResizableColumn {
    readonly id: string;
    readonly title: string;
    readonly defaultWidth: number;
}

const MIN_WIDTH = 40;
const MAX_WIDTH = 2_000;

/**
 * Widths of resizable columns in a `table.resizable-columns` (fixed layout),
 * applied as `--col-<id>` CSS variables on a container, so dragging restyles
 * every row without re-rendering. Each column is exactly as wide as set; a
 * trailing filler column takes any remaining space.
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

    /** Columns per row, including the filler (for `colSpan`). */
    public get span(): number {
        return this._columns.length + 1;
    }

    public set(custom: Readonly<Record<string, number>>): void {
        this._custom = { ...custom };
        this._apply();
    }

    /** The header row: a cell per column with a drag handle on its right edge, then the filler. */
    public headerRow(): HTMLElement {
        return h('tr', {}, ...this._columns.map(column => this._header(column)), h('th', { class: 'filler' }));
    }

    /** A cell's content wrapper; truncates with an ellipsis at the column's edge. */
    public cell(props: Record<string, unknown>, ...children: Array<Node | string | undefined | false>): HTMLElement {
        return h('div', { ...props, class: `cell ${(props.class as string | undefined) ?? ''}`.trim() }, ...children);
    }

    private _header(column: ResizableColumn): HTMLElement {
        const handle = h('span', { class: 'col-resizer', title: 'Drag to resize · double-click to reset' });
        const th = h('th', { class: 'resizable' }, this.cell({}, column.title), handle);
        th.style.width = `var(--col-${column.id})`;
        handle.addEventListener('pointerdown', event => this._drag(event, column, th, handle));
        handle.addEventListener('dblclick', () => {
            const { [column.id]: _removed, ...rest } = this._custom;
            this._custom = rest;
            this._apply();
            this._onDidChange();
        });
        handle.addEventListener('click', event => event.stopPropagation());
        return th;
    }

    private _drag(event: PointerEvent, column: ResizableColumn, th: HTMLElement, handle: HTMLElement): void {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = th.getBoundingClientRect().width;
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
            this._container.style.setProperty(`--col-${column.id}`, `${this._custom[column.id] ?? column.defaultWidth}px`);
        }
    }
}
