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
} from "@vscode/hubrpc";
import { isHubEndpoint, openHubChannel } from "@vscode/hubrpc/node";
import { type CliSigning, connect } from "@vscode/hubrpc-client";
import type { ResolvedEndpoint } from "@vscode/hubrpc-client";
import { setupSigning } from "@vscode/hubrpc-client";
import type { SigningSession } from "@vscode/hubrpc-client";
import { formatPrincipalSource, type PrincipalSpec } from "@vscode/hubrpc-client";
import { UiModel } from "./UiModel";
import { App } from "./App";

export interface RunUiOptions {
    readonly endpoint: ResolvedEndpoint;
    readonly principalSpec: PrincipalSpec;
}

export async function runUi(opts: RunUiOptions): Promise<void> {
    if (isHubEndpoint(opts.endpoint)) {
        await _runUiReconnecting(opts.endpoint, opts.principalSpec);
    } else {
        await _runUiOnce(opts.endpoint, opts.principalSpec);
    }
}

/** Non-Hub endpoints: a single connection, no redial. */
async function _runUiOnce(endpoint: ResolvedEndpoint, principalSpec: PrincipalSpec): Promise<void> {
    const conn = await connect(endpoint);
    const identity = _isRawEndpoint(endpoint)
        ? "unsigned (raw endpoint)"
        : _formatIdentity(
            await setupSigning(conn.channel, conn.signing, principalSpec, {
                negotiateHubCaps: false,
            }),
        );
    const model = new UiModel(conn.channel);
    model.identity.set(identity, undefined);
    const instance = render(<App model={model} />);
    try {
        await instance.waitUntilExit();
    } finally {
        model.dispose();
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

        if (!model) {
            model = new UiModel(swappable);
            model.identity.set(_formatIdentity(session), undefined);
            const instance = render(<App model={model} />);
            // When the user quits the TUI, stop redialing and tear down.
            void instance.waitUntilExit().finally(() => handle.stop());
        } else {
            // Reconnected: update header identity label. Pending/next calls
            // use the swapped target; signing hooks live on that sender.
            model.identity.set(_formatIdentity(session), undefined);
        }
    });

    try {
        await handle.done;
    } finally {
        model?.dispose();
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
