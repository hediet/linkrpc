import { h } from './dom';

/** A table column the user can resize; cells truncate with an ellipsis at its edge. */
export interface ResizableColumn {
    readonly id: string;
    readonly title: string;
    /** px; for flexible columns the width at the default window size, used as its relative share. */
    readonly defaultWidth: number;
    /** Shares the table width left by the other columns, in proportion to its width. */
    readonly flexible?: boolean;
}

const MIN_WIDTH = 40;

/**
 * Widths of the resizable columns of a `table.resizable-columns` (fixed
 * layout). Fixed columns are as wide as set; flexible columns share the
 * remaining width in proportion to their weights, so resizing the window
 * redistributes the space among them. Dragging a header's edge makes that
 * column follow the pointer; for a flexible column the other flexible columns
 * keep their proportions. Widths are `--col-<id>` CSS variables on the
 * container, so layout changes restyle every row without re-rendering.
 */
export class ColumnWidths {
    private _custom: Record<string, number> = {};
    private readonly _flexible: readonly ResizableColumn[];

    constructor(
        private readonly _container: HTMLElement,
        private readonly _columns: readonly ResizableColumn[],
        /** Called when a drag or reset finishes. */
        private readonly _onDidChange: () => void,
    ) {
        this._flexible = _columns.filter(column => column.flexible);
        new ResizeObserver(() => this._layout()).observe(_container);
        this._layout();
    }

    /** Changed widths by column id: px for fixed columns, weights for flexible ones. */
    public get custom(): Readonly<Record<string, number>> {
        return this._custom;
    }

    /** Columns per row (for `colSpan`). */
    public get span(): number {
        return this._columns.length;
    }

    public set(custom: Readonly<Record<string, number>>): void {
        this._custom = { ...custom };
        this._layout();
    }

    public headerRow(): HTMLElement {
        return h('tr', {}, ...this._columns.map(column => this._header(column)));
    }

    /** A cell's content wrapper; truncates with an ellipsis at the column's edge. */
    public cell(props: Record<string, unknown>, ...children: Array<Node | string | undefined | false>): HTMLElement {
        return h('div', { ...props, class: `cell ${(props.class as string | undefined) ?? ''}`.trim() }, ...children);
    }

    private _width(column: ResizableColumn): number {
        return this._custom[column.id] ?? column.defaultWidth;
    }

    /** The width the flexible columns share. */
    private _flexibleSpace(): number {
        const fixed = this._columns.filter(column => !column.flexible).reduce((sum, column) => sum + this._width(column), 0);
        return Math.max(MIN_WIDTH * this._flexible.length, this._container.clientWidth - fixed);
    }

    private _header(column: ResizableColumn): HTMLElement {
        const handle = h('span', { class: 'col-resizer', title: 'Drag to resize · double-click to reset' });
        const th = h('th', { class: 'resizable' }, this.cell({}, column.title), handle);
        th.style.width = `var(--col-${column.id})`;
        handle.addEventListener('pointerdown', event => this._drag(event, column, th, handle));
        handle.addEventListener('dblclick', () => {
            const { [column.id]: _removed, ...rest } = this._custom;
            this._custom = rest;
            this._layout();
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
        const space = this._flexibleSpace();
        const otherWeights = this._flexible.filter(other => other !== column).reduce((sum, other) => sum + this._width(other), 0);
        const maxFlexible = space - MIN_WIDTH * (this._flexible.length - 1);
        const onMove = (move: PointerEvent) => {
            const target = Math.max(MIN_WIDTH, startWidth + move.clientX - startX);
            let width = Math.round(target);
            if (column.flexible && otherWeights > 0) {
                // The weight that renders `px` while the others keep theirs: px / space = w / (others + w).
                const px = Math.min(target, maxFlexible);
                width = Math.round(10 * px * otherWeights / Math.max(1, space - px)) / 10;
            }
            this._custom = { ...this._custom, [column.id]: width };
            this._layout();
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

    private _layout(): void {
        const space = this._flexibleSpace();
        const weights = this._flexible.reduce((sum, column) => sum + this._width(column), 0);
        for (const column of this._columns) {
            const width = column.flexible ? Math.max(MIN_WIDTH, space * this._width(column) / weights) : this._width(column);
            this._container.style.setProperty(`--col-${column.id}`, `${width}px`);
        }
    }
}
