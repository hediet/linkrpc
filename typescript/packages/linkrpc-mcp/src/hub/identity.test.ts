import { describe, expect, it } from "vitest";
import {
    type IRequestSender,
    KeypairSigningIdentity,
    type RawStreamingCall,
    type SendOpts,
    type SignedCapability,
    type SigningCallCtx,
} from "@hediet/linkrpc";
import { DelegatedHubSender, singleConnectionPool } from "./identity";

function fakeChannel(onSend: (method: string, params: unknown, opts?: SendOpts<SigningCallCtx>) => unknown = () => null) {
    const streamOps: string[] = [];
    const channel: IRequestSender<SigningCallCtx> = {
        sendRequest: async (method, params, opts) => onSend(method, params, opts) as never,
        sendNotification: async () => {},
        sendRequestWithStream: (method, params, opts): RawStreamingCall => {
            onSend(method, params, opts);
            return {
                result: Promise.resolve(null),
                send: (payload) => { streamOps.push(`send:${JSON.stringify(payload)}`); },
                cancel: (reason) => { streamOps.push(`cancel:${reason}`); },
                ping: async () => {},
            };
        },
        close: () => { throw new Error("must not close the shared channel"); },
    };
    return { channel, streamOps };
}

describe("DelegatedHubSender", () => {
    it("signs every call as the delegated identity with its fresh capabilities", async () => {
        const captured: Array<SendOpts<SigningCallCtx> | undefined> = [];
        const identity = await KeypairSigningIdentity.generateNew();
        const fresh = { permissions: [] } as unknown as SignedCapability;
        const expired = { expiresAtMs: 1, permissions: [] } as unknown as SignedCapability;
        const sender = await DelegatedHubSender.create({
            channel: fakeChannel((_m, _p, opts) => { captured.push(opts); }).channel,
            identity,
            capabilities: () => [fresh, expired],
        });

        await sender.sendRequest("svc::iface::member", { a: 1 });
        sender.close();

        expect(captured[0]?.ctx?.signerOverride).toBe(identity);
        expect(captured[0]?.ctx?.capsOverride).toEqual([fresh]);
        expect(sender.listGrants()).toEqual([fresh]);
        expect(sender.principal).toBe(identity.publicSigningIdentity.principal);
    });

    it("requests access as the delegated principal and persists only durable grants", async () => {
        const identity = await KeypairSigningIdentity.generateNew();
        const caps: SignedCapability[] = [];
        const granted: SignedCapability[][] = [];
        const durable = { permissions: [{ canInvoke: true }] } as unknown as SignedCapability;
        const oneShot = { permissions: [{ callBind: { alg: "sha256", payloadHash: "x" } }] } as unknown as SignedCapability;
        let sent: { method: string; params: unknown } | undefined;
        const sender = await DelegatedHubSender.create({
            channel: fakeChannel((method, params) => {
                sent = { method, params };
                return { status: "granted", capabilities: [durable, oneShot] };
            }).channel,
            identity,
            capabilities: () => caps,
            onGranted: async (c) => {
                granted.push([...c]);
                caps.push(...c);
            },
        });

        const result = await sender.requestAccess({ consumer: { name: "test" }, permissions: [] });

        expect(sent?.method).toBe("hubAccess::requestAccess");
        expect((sent?.params as { consumer: { principal: string } }).consumer.principal)
            .toBe(identity.publicSigningIdentity.principal);
        expect(result).toMatchObject({ status: "granted", addedDurable: 1 });
        expect(granted).toEqual([[durable]]);
        expect(sender.listGrants()).toEqual([durable]);
    });

    it("checks authorization before every call and keeps stream operations ordered", async () => {
        const identity = await KeypairSigningIdentity.generateNew();
        let authorized = true;
        const { channel, streamOps } = fakeChannel();
        const sender = await DelegatedHubSender.create({
            channel,
            identity,
            capabilities: async () => [],
            beforeSend: async () => { if (!authorized) throw new Error("revoked"); },
        });

        const call = sender.sendRequestWithStream("svc::iface::stream", {});
        void call.send({ n: 1 });
        void call.send({ n: 2 });
        await call.cancel("done");
        expect(streamOps).toEqual(["send:{\"n\":1}", "send:{\"n\":2}", "cancel:done"]);

        authorized = false;
        await expect(sender.sendRequest("svc::iface::member", {})).rejects.toThrow("revoked");
    });

    it("pins pooled connections to the sender", async () => {
        const identity = await KeypairSigningIdentity.generateNew();
        const sender = await DelegatedHubSender.create({ channel: fakeChannel().channel, identity, capabilities: () => [] });
        const pool = singleConnectionPool(sender, sender, "inproc:test");
        expect((await pool.resolve(undefined)).session).toBe(sender);
        await expect(pool.resolve("unix:/other")).rejects.toThrow("cannot connect to other hub endpoints");
    });
});
