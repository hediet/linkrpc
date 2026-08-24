import { describe, expect, it } from "vitest";
import { computeWindow } from "./scroll";

describe("computeWindow", () => {
    it("shows everything when the list fits", () => {
        const w = computeWindow(5, 2, 0, 10);
        expect(w).toEqual({ offset: 0, window: { start: 0, end: 5, above: 0, below: 0 } });
    });

    it("returns an empty window for empty or zero-height inputs", () => {
        expect(computeWindow(0, 0, 0, 10).window).toEqual({ start: 0, end: 0, above: 0, below: 0 });
        expect(computeWindow(5, 0, 0, 0).window).toEqual({ start: 0, end: 0, above: 0, below: 0 });
    });

    it("reserves indicator rows so visible = height - 2 when scrolling", () => {
        const { window } = computeWindow(20, 0, 0, 6);
        expect(window.end - window.start).toBe(4);
    });

    it("keeps the cursor stationary until it reaches an edge", () => {
        // height 6 => visible 4. Cursor at 2 with offset 0 stays put.
        const a = computeWindow(20, 2, 0, 6);
        expect(a.offset).toBe(0);
        expect(a.window).toEqual({ start: 0, end: 4, above: 0, below: 16 });
    });

    it("scrolls down once the cursor passes the bottom of the window", () => {
        // visible 4 => cursor must be < offset+4. Cursor 4 forces offset 1.
        const { offset, window } = computeWindow(20, 4, 0, 6);
        expect(offset).toBe(1);
        expect(window).toEqual({ start: 1, end: 5, above: 1, below: 15 });
    });

    it("scrolls up when the cursor moves above the window", () => {
        const { offset, window } = computeWindow(20, 3, 8, 6);
        expect(offset).toBe(3);
        expect(window).toEqual({ start: 3, end: 7, above: 3, below: 13 });
    });

    it("clamps the offset at the bottom of the list", () => {
        const { offset, window } = computeWindow(20, 19, 0, 6);
        // visible 4 => max offset is 16.
        expect(offset).toBe(16);
        expect(window).toEqual({ start: 16, end: 20, above: 16, below: 0 });
    });

    it("clamps an out-of-range cursor", () => {
        const { window } = computeWindow(20, 999, 0, 6);
        expect(window.end).toBe(20);
        expect(window.below).toBe(0);
    });
});
