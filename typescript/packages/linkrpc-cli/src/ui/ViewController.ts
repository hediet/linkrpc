import { Disposable, autorun, derived, observableValue, type IObservable } from "@vscode/observables";
import type { CliChannel } from "@hediet/linkrpc-client";
import { views } from "../views/registry";
import { resolveViewTarget } from "../views/discovery";
import { formatCondition, interfaceTarget, matchesTarget, targetId, type ViewInterface, type ViewSession, type ViewTarget } from "../views/types";
import type { MethodKey, SchemaState, UiServiceListing } from "./UiModel";
import { SchemaSession } from "./SchemaSession";

export class ViewController extends Disposable {
    readonly tab = observableValue<string>(this, "methods");
    readonly kind = observableValue<"interface" | "service">(this, "interface");
    readonly session = observableValue<ViewSession | undefined>(this, undefined);
    readonly error = observableValue<string | undefined>(this, undefined);
    readonly connectionGeneration = observableValue(this, 0);
    readonly connected = observableValue(this, true);
    private generation = 0;
    private savedState: { readonly key: string; readonly state: unknown } | undefined;
    private sessionKey: string | undefined;
    private readonly pendingCleanup = new Set<Promise<void>>();

    constructor(
        private readonly channel: CliChannel,
        private readonly selection: IObservable<MethodKey | undefined>,
        private readonly schema: IObservable<SchemaState>,
        private readonly listings: () => readonly UiServiceListing[],
    ) {
        super();
        this._register(autorun(reader => {
            const tab = this.tab.read(reader);
            const target = this.target.read(reader);
            this.connectionGeneration.read(reader);
            const connected = this.connected.read(reader);
            const generation = ++this.generation;
            const previous = this.session.get();
            if (previous && this.sessionKey) this.savedState = { key: this.sessionKey, state: previous.captureState?.() };
            this.stopSession(previous);
            this.session.set(undefined, undefined);
            this.error.set(undefined, undefined);
            if (tab === "schema") {
                const key = `schema:${target?.id ?? ""}`;
                const session = new SchemaSession(this.schema);
                if (this.savedState?.key === key) session.restoreState(this.savedState.state);
                this.sessionKey = key;
                this.session.set(session, undefined);
                return;
            }
            const view = views.find(value => value.id === tab);
            if (!view || !target || !matchesTarget(target, view) || !connected) return;
            const key = `${tab}:${target.id}`;
            void resolveViewTarget(channel, view, target.id).then(context => {
                if (generation !== this.generation) return;
                const session = view.createSession(context);
                if (this.savedState?.key === key) session.restoreState?.(this.savedState.state);
                this.sessionKey = key;
                this.session.set(session, undefined);
            }).catch(error => {
                if (generation === this.generation) this.error.set(String(error), undefined);
            });
        }));
    }

    readonly target = derived(this, (reader): ViewTarget | undefined => {
        const selection = this.selection.read(reader);
        if (!selection) return undefined;
        const state = this.schema.read(reader);
        const all = this.listings();
        const listing = all.find(value => value.serviceId === selection.serviceId
            && value.interfaceId === selection.interfaceId
            && !!value.isDefault === !!selection.isDefault);
        const selected: ViewInterface = {
            ...selection, discoveredFrom: listing?.discoveredFrom ?? selection.serviceId,
            hash: listing?.hash, tags: state.kind === "loaded" ? state.schema.tags : listing?.tags,
        };
        if (this.kind.read(reader) === "interface") return interfaceTarget(selected);
        const interfaces: ViewInterface[] = [];
        for (const value of [selected, ...all.filter(value => value.serviceId === selected.serviceId
            && value.discoveredFrom === selected.discoveredFrom)]) {
            if (!interfaces.some(item => item.interfaceId === value.interfaceId)) interfaces.push(value);
        }
        return {
            id: targetId("service", selected), kind: "service", serviceId: selected.serviceId,
            discoveredFrom: selected.discoveredFrom, interfaces,
        };
    });

    readonly tabs = derived(this, reader => {
        const target = this.target.read(reader);
        return [
            { id: "methods", title: "Methods", condition: "interface:any | service:any" },
            { id: "schema", title: "Schema", condition: "interface:any | service:any" },
            ...views.filter(view => target && matchesTarget(target, view)).map(view => ({
                id: view.id, title: view.title, condition: view.conditions.map(formatCondition).join(" | "),
            })),
        ];
    });

    cycleTab(): void {
        const tabs = this.tabs.get();
        const index = tabs.findIndex(tab => tab.id === this.tab.get());
        this.tab.set(tabs[(index + 1) % tabs.length]!.id, undefined);
    }
    toggleKind(): void { this.kind.set(this.kind.get() === "interface" ? "service" : "interface", undefined); }
    disconnect(): void { this.connected.set(false, undefined); }
    reconnect(): void {
        if (!this.connected.get()) this.connected.set(true, undefined);
        else this.connectionGeneration.set(this.connectionGeneration.get() + 1, undefined);
    }
    private stopSession(session: ViewSession | undefined): void {
        session?.dispose();
        const cleanup = session?.disposeAsync?.();
        if (!cleanup) return;
        this.pendingCleanup.add(cleanup);
        void cleanup.then(() => this.pendingCleanup.delete(cleanup), () => this.pendingCleanup.delete(cleanup));
    }
    async waitForIdle(): Promise<void> {
        await Promise.allSettled([...this.pendingCleanup]);
    }
    override dispose(): void {
        ++this.generation;
        this.stopSession(this.session.get());
        super.dispose();
    }
}
