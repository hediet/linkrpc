import { describe, expect, it } from "vitest";
import { methodNameToTarget, parseMethodName } from "./methodName";

describe("method names", () => {
    it("parses an explicitly root-addressed call", () => {
        expect(parseMethodName("::fooInterface::barMethod")).toEqual({
            kind: "interface",
            interfaceId: "fooInterface",
            member: "barMethod",
        });
        expect(methodNameToTarget("::fooInterface::barMethod")).toEqual({
            serviceId: "",
            interfaceId: "fooInterface",
            member: "barMethod",
        });
    });
});