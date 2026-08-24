import React from "react";

export interface ScrollWindow {
    /** First visible item index (inclusive). */
    readonly start: number;
    /** One past the last visible item index (exclusive). */
    readonly end: number;
    /** How many items are hidden above the window. */
    readonly above: number;
    /** How many items are hidden below the window. */
    readonly below: number;
}

/**
 * Pure scroll math for a vertical list rendered into a fixed-height viewport.
 *
 * The cursor stays stationary until it reaches a viewport edge, then the window
 * scrolls (classic list behaviour) rather than re-centering on every move.
 * `prevOffset` is the offset from the previous render; the returned `offset`
 * should be fed back in next time.
 *
 * One row on each overflowing side is reserved for a "▲/▼ more" indicator, so an
 * indicator never hides a real item; this makes the visible item count
 * `height - 2` while scrolling. When the list fits, the full range is returned
 * with no indicators.
 */
export function computeWindow(
    count: number,
    cursor: number,
    prevOffset: number,
    height: number,
): { offset: number; window: ScrollWindow } {
    if (height <= 0 || count <= 0) {
        return { offset: 0, window: { start: 0, end: 0, above: 0, below: 0 } };
    }
    if (count <= height) {
        return { offset: 0, window: { start: 0, end: count, above: 0, below: 0 } };
    }

    // Reserve a row top and bottom for indicators so layout stays stable while
    // scrolling. At the very edges one reserved row goes unused (rendered blank).
    const visible = Math.max(1, height - 2);
    const c = Math.max(0, Math.min(count - 1, cursor));

    let offset = prevOffset;
    offset = Math.min(offset, c); // cursor scrolled above the window
    offset = Math.max(offset, c - visible + 1); // cursor scrolled below the window
    offset = Math.max(0, Math.min(offset, count - visible));

    const end = offset + visible;
    return { offset, window: { start: offset, end, above: offset, below: count - end } };
}

/**
 * Stateful wrapper around {@link computeWindow}. Ink has no scroll container, so
 * any list longer than the available rows must be sliced by hand; without this
 * the overflow corrupts sibling panes and the terminal frame. The scroll offset
 * is kept in a ref so it survives re-renders without involving the view model.
 */
export function useScroll(count: number, cursor: number, height: number): ScrollWindow {
    const offsetRef = React.useRef(0);
    const { offset, window } = computeWindow(count, cursor, offsetRef.current, height);
    offsetRef.current = offset;
    return window;
}
