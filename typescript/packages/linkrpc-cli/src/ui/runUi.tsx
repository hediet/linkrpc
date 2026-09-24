import { render } from "ink";
import {
    ChannelConnector,
    type IRequestSender,
    type JsonValue,
    type RawStreamingCall,
    RpcError,
    type SendOpts,
    type SigningCallCtx,
    SigningSender,
    type StreamSendOpts,
} from "@hediet/linkrpc";
import { isHubEndpoint, openHubChannel } from "@hediet/linkrpc/node";
import { type CliSigning, connect } from "@hediet/linkrpc-client";
import type { ResolvedEndpoint } from "@hediet/linkrpc-client";
import { setupSigning } from "@hediet/linkrpc-client";
import type { SigningSession } from "@hediet/linkrpc-client";
import { formatPrincipalSource, type PrincipalSpec } from "@hediet/linkrpc-client";
import { UiModel } from "./UiModel";
import { App } from "./App";
import { withStaticHubReflection } from "../commands/staticHubReflection";
import type { StaticHubSchema } from "../staticHubSchema";

export interface RunUiOptions {
    readonly endpoint: ResolvedEndpoint;
    readonly principalSpec: PrincipalSpec;
    readonly schema?: StaticHubSchema;
    readonly profile?: "rpc" | "hub";
}

export async function runUi(opts: RunUiOptions): Promise<void> {
    if (isHubEndpoint(opts.endpoint) && opts.profile !== "rpc") {
        await _runUiReconnecting(opts.endpoint, opts.principalSpec, opts.schema);
    } else {
        await _runUiOnce(opts.endpoint, opts.principalSpec, opts.schema, opts.profile);
    }
}

/** Non-Hub endpoints: a single connection, no redial. */
async function _runUiOnce(endpoint: ResolvedEndpoint, principalSpec: PrincipalSpec, schema?: StaticHubSchema, profile?: "rpc" | "hub"): Promise<void> {
    const conn = await connect(endpoint);
    const identity = _isRawEndpoint(endpoint) || profile === "rpc"
        ? "unsigned (raw endpoint)"
        : _formatIdentity(
            await setupSigning(conn.channel, conn.signing, principalSpec, {
                negotiateHubCaps: false,
            }),
        );
    const model = new UiModel(schema ? withStaticHubReflection(conn.channel, schema) : conn.channel);
    model.identity.set(identity, undefined);
    const instance = render(<App model={model} />, { exitOnCtrlC: false });
    try {
        await instance.waitUntilExit();
    } finally {
        model.dispose();
        await model.views.waitForIdle();
        conn.close();
    }
}

function _isRawEndpoint(endpoint: ResolvedEndpoint): boolean {
    return endpoint.kind === "ws-no-init"
        || (endpoint.kind === "socket" && endpoint.brokerMode === "raw");
}

/**
 * Hub / env connection: keep the UI alive across socket drops. A stable
 * {@link SwappableSender} backs the {@link UiModel}; on every (re)connect we
 * open a fresh hub channel, install signing, and point the swappable sender at
 * the new signed channel. The TUI is rendered once, after the first connect.
 */
async function _runUiReconnecting(
    endpoint: Extract<ResolvedEndpoint, { kind: "ws"; } | { kind: "socket"; }>,
    principalSpec: PrincipalSpec,
    schema?: StaticHubSchema,
): Promise<void> {
    const swappable = new SwappableSender();
    let model: UiModel | undefined;

    const hubEndpoint = endpoint.kind === "ws" ? endpoint.url : endpoint.path;
    const connector = ChannelConnector.expBackoff(() =>
        openHubChannel({ endpoint: hubEndpoint, token: endpoint.token ?? "" })
    );

    const handle = connector.keepConnected(async ({ channel }) => {
        const signing: CliSigning = {};
        const signed = SigningSender.wrapChannel(channel, signing).sender;
        const session = await setupSigning(signed, signing, principalSpec, {
            negotiateHubCaps: true,
        });
        swappable.setTarget(signed);
        channel.onClose(() => {
            swappable.setTarget(undefined);
            model?.views.disconnect();
            model?.identity.set("disconnected; reconnecting…", undefined);
        });

        if (!model) {
            model = new UiModel(schema ? withStaticHubReflection(swappable, schema) : swappable);
            model.identity.set(_formatIdentity(session), undefined);
            const instance = render(<App model={model} />, { exitOnCtrlC: false });
            // When the user quits the TUI, stop redialing and tear down.
            void instance.waitUntilExit().then(async () => {
                model?.dispose();
                await model?.views.waitForIdle();
                handle.stop();
            }, () => handle.stop());
        } else {
            // Reconnected: update header identity label. Pending/next calls
            // use the swapped target; signing hooks live on that sender.
            model.identity.set(_formatIdentity(session), undefined);
            model.views.reconnect();
        }
    });

    try {
        await handle.done;
    } finally {
        model?.dispose();
        await model?.views.waitForIdle();
    }
}

/** One-line identity label for the TUI header (source + truncated nodeId). */
function _formatIdentity(session: SigningSession): string {
    return formatPrincipalSource(session.principalSource, session.principal.identity.publicSigningIdentity.principal);
}

/**
 * An {@link IRequestSender} whose delegate can be swapped at runtime. Lets the
 * {@link UiModel} hold one stable channel reference while the underlying signed
 * channel is replaced on each reconnect. Calls issued while disconnected reject.
 */
class SwappableSender implements IRequestSender<SigningCallCtx> {
    private _target: IRequestSender<SigningCallCtx> | undefined;

    public setTarget(target: IRequestSender<SigningCallCtx> | undefined): void {
        this._target = target;
    }

    private _require(): IRequestSender<SigningCallCtx> {
        if (!this._target) {
            throw new RpcError("not connected", -32000);
        }
        return this._target;
    }

    public sendRequest(
        method: string,
        params: JsonValue | undefined,
        opts?: SendOpts<SigningCallCtx>,
    ): Promise<JsonValue> {
        return this._require().sendRequest(method, params, opts);
    }

    public sendNotification(
        method: string,
        params: JsonValue | undefined,
        opts?: SendOpts<SigningCallCtx>,
    ): Promise<void> {
        return this._require().sendNotification(method, params, opts);
    }

    public sendRequestWithStream(
        method: string,
        params: JsonValue | undefined,
        opts?: StreamSendOpts<SigningCallCtx>,
    ): RawStreamingCall {
        return this._require().sendRequestWithStream(method, params, opts);
    }

    public close(): void {
        this._target?.close();
    }
}
