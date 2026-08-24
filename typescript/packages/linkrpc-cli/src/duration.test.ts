import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration";

describe("parseDuration", () => {
    it.each([
        ["250ms", 250],
        ["30s", 30_000],
        ["5m", 300_000],
        ["5min", 300_000],
        ["2h", 7_200_000],
    ])("parses %s", (input, expected) => {
        expect(parseDuration(input)).toBe(expected);
    });

    it.each(["", "0s", "-1s", "five minutes", "1d"])("rejects %s", (input) => {
        expect(() => parseDuration(input)).toThrow(/duration/);
    });
});
