import { beforeEach, describe, expect, it, vi } from "vitest";
import { runUi } from "./runUi";

const mocks = vi.hoisted(() => {
    const identitySet = vi.fn();
    const disposeModel = vi.fn();
    const closeConnection = vi.fn();
    return {
        identitySet,
        disposeModel,
        closeConnection,
        connect: vi.fn(async () => ({
            channel: {},
            signing: {},
            close: closeConnection,
        })),
        setupSigning: vi.fn(async () => ({
            principalSource: { kind: "generated" },
            principal: {
                identity: {
                    publicSigningIdentity: {
                        principal: { type: "node", nodeId: "test" },
                    },
                },
            },
        })),
        render: vi.fn(() => ({
            waitUntilExit: async () => { },
        })),
        UiModel: class {
            public readonly identity = { set: identitySet };

            public dispose(): void {
                disposeModel();
            }
        },
    };
});

vi.mock("ink", () => ({ render: mocks.render }));
vi.mock("@hediet/linkrpc-client", () => ({
    connect: mocks.connect,
    setupSigning: mocks.setupSigning,
    formatPrincipalSource: vi.fn(() => "generated test"),
}));
vi.mock("./UiModel", () => ({ UiModel: mocks.UiModel }));
vi.mock("./App", () => ({ App: () => null }));

describe("runUi", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        {
            name: "a raw connection broker socket",
            endpoint: {
                kind: "socket" as const,
                path: "\\\\.\\pipe\\linkrpc-test",
                token: "test-token",
                brokerMode: "raw" as const,
            },
        },
        {
            name: "a ws-no-init endpoint",
            endpoint: {
                kind: "ws-no-init" as const,
                url: "ws://localhost:4123",
            },
        },
    ])("does not set up signing for $name", async ({ endpoint }) => {
        await runUi({ endpoint, principalSpec: { kind: "generated" } });

        expect(mocks.setupSigning).not.toHaveBeenCalled();
        expect(mocks.identitySet).toHaveBeenCalledWith("unsigned (raw endpoint)", undefined);
        expect(mocks.closeConnection).toHaveBeenCalledOnce();
    });

    it("retains signing for command endpoints", async () => {
        await runUi({
            endpoint: {
                kind: "cmd-stdio",
                command: { argv: ["node", "server.js"] },
            },
            principalSpec: { kind: "generated" },
        });

        expect(mocks.setupSigning).toHaveBeenCalledOnce();
        expect(mocks.identitySet).toHaveBeenCalledWith("generated test", undefined);
    });
});
