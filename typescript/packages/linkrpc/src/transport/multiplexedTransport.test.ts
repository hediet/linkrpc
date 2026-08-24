import { describe, expect, it, vi } from "vitest";
import type { JsonRpcMessage } from "../protocol/jsonRpc";
import { TransportPair } from "./messageTransport";
import { MultiplexedTransport, type MuxEnvelope } from "./multiplexedTransport";

const message: JsonRpcMessage = {
    jsonrpc: "2.0",
    method: "test",
};

describe("MultiplexedTransport", () => {
    it("adds and removes dynamic channels without detaching the base transport", () => {
        const pair = new TransportPair<MuxEnvelope, MuxEnvelope>();
        const mux = new MultiplexedTransport(pair.a, { fixed: "fixed" });
        const dynamic = mux.addChannel("dynamic");
        const fixedListener = vi.fn();
        const dynamicListener = vi.fn();
        mux.transports.fixed.setListener(fixedListener);
        dynamic.setListener(dynamicListener);

        pair.b.send({ $mux: "v1", ch: "dynamic", m: message });
        expect(dynamicListener).toHaveBeenCalledWith(message);

        dynamic.dispose();
        pair.b.send({ $mux: "v1", ch: "dynamic", m: message });
        pair.b.send({ $mux: "v1", ch: "fixed", m: message });

        expect(dynamicListener).toHaveBeenCalledTimes(1);
        expect(fixedListener).toHaveBeenCalledWith(message);
        mux.dispose();
    });

    it("rejects duplicate and reused channel ids", () => {
        const pair = new TransportPair<MuxEnvelope, MuxEnvelope>();
        const mux = new MultiplexedTransport(pair.a, { fixed: "fixed" });

        expect(() => mux.addChannel("fixed")).toThrow(/already been used/);
        const dynamic = mux.addChannel("dynamic");
        expect(() => mux.addChannel("dynamic")).toThrow(/already been used/);
        dynamic.dispose();
        expect(() => mux.addChannel("dynamic")).toThrow(/already been used/);
        mux.dispose();
    });

    it("rejects duplicate constructor ids", () => {
        const pair = new TransportPair<MuxEnvelope, MuxEnvelope>();
        expect(() => new MultiplexedTransport(pair.a, { first: "same", second: "same" }))
            .toThrow(/already been used/);
    });

    it("drops unknown channel envelopes", () => {
        const pair = new TransportPair<MuxEnvelope, MuxEnvelope>();
        const mux = new MultiplexedTransport(pair.a, { fixed: "fixed" });
        const listener = vi.fn();
        mux.transports.fixed.setListener(listener);

        pair.b.send({ $mux: "v1", ch: "unknown", m: message });

        expect(listener).not.toHaveBeenCalled();
        mux.dispose();
    });

    it("rejects channels after disposal", () => {
        const pair = new TransportPair<MuxEnvelope, MuxEnvelope>();
        const mux = new MultiplexedTransport(pair.a, { fixed: "fixed" });
        mux.dispose();

        expect(() => mux.addChannel("dynamic")).toThrow(/disposed/);
    });
});
