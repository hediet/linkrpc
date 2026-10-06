import { describe, expect, it } from "vitest";
import { parseDuration, parseConnectionLimit, parseConnectionLimitMilliseconds } from "./duration";

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

    describe("connection limits", () => {
        it("keeps unlimited values JSON-safe", () => {
            expect(JSON.stringify({
                duration: parseConnectionLimit("inf"),
                milliseconds: parseConnectionLimitMilliseconds("inf"),
            })).toBe('{"duration":"inf","milliseconds":"inf"}');
        });

        it("parses finite limits", () => {
            expect(parseConnectionLimit("30s")).toBe(30_000);
            expect(parseConnectionLimitMilliseconds("30000")).toBe(30_000);
        });

        it.each(["Infinity", "NaN", "0", "-1", "1ms", "30junk", "2147483648"])(
            "rejects invalid internal limit %s", value => {
                expect(() => parseConnectionLimitMilliseconds(value)).toThrow();
            },
        );

        it.each(["Infinity", "0s", "2147483648ms"])("rejects invalid duration %s", value => {
            expect(() => parseConnectionLimit(value)).toThrow();
        });
    });

    it.each(["", "0s", "-1s", "five minutes", "1d"])("rejects %s", (input) => {
        expect(() => parseDuration(input)).toThrow(/duration/);
    });
});
