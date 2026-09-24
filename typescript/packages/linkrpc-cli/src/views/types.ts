import type { CliChannel } from "@hediet/linkrpc-client";
import type { LinkRpcInterfaceSchema } from "@hediet/linkrpc";
import type { Command } from "commander";
import type React from "react";
import type { IObservable } from "@vscode/observables";

export type InterfaceCondition =
    | { readonly interfaceId: string }
    | { readonly tag: string };

export type ViewCondition =
    | { readonly kind: "interface"; readonly interface: InterfaceCondition }
    | { readonly kind: "service"; readonly implements: InterfaceCondition };

export interface ViewInterface {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash?: string;
    readonly tags?: readonly string[];
    readonly discoveredFrom: string;
    readonly isDefault?: boolean;
}

/** The schema hash is deliberately not part of identity: opening resolves it again. */
export interface ViewTarget {
    readonly id: string;
    readonly kind: "interface" | "service";
    readonly serviceId: string;
    readonly interfaceId?: string;
    readonly discoveredFrom: string;
    readonly interfaces: readonly ViewInterface[];
}

export interface ResolvedViewInterface extends ViewInterface {
    readonly schema: LinkRpcInterfaceSchema;
}

export interface ViewOpenContext {
    readonly channel: CliChannel;
    readonly target: ViewTarget;
    readonly interfaces: readonly ResolvedViewInterface[];
}

export interface ViewKeyEvent {
    readonly input: string;
    readonly name?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

/** Named terminal keys (up, return, pageup, …) or a literal character. */
export interface ViewKeybinding {
    readonly key: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export interface ViewCommand {
    readonly id: string;
    readonly title: string;
    readonly keybindings: readonly ViewKeybinding[];
    readonly enabled?: boolean;
    /** Human-readable context, e.g. "Graph" or "Editing parameters". */
    readonly context?: string;
    execute(): void;
}

export interface ViewSession {
    readonly element: React.ReactElement;
    /** Publish a new command list whenever availability, titles or context change. */
    readonly commands: IObservable<readonly ViewCommand[]>;
    /** Optional compact-legend limit; a view can expose full help as a command. */
    readonly maxLegendRows?: number;
    readonly capturesInput?: boolean;
    captureState?(): unknown;
    restoreState?(state: unknown): void;
    setViewport?(rows: number, columns?: number): void;
    /** Called only while capturesInput is true, after declarative commands. */
    handleTextInput?(event: ViewKeyEvent): boolean;
    dispose(): void;
    disposeAsync?(): Promise<void>;
}

/** Compiled-in contributions; matching is discovery, never authorization. */
export interface ViewContribution {
    readonly id: string;
    readonly title: string;
    readonly modes: readonly ("cli" | "tui")[];
    readonly conditions: readonly ViewCondition[];
    configureCommand(command: Command): void;
    open(context: ViewOpenContext, options: Readonly<Record<string, unknown>>): Promise<string>;
    createSession(context: ViewOpenContext): ViewSession;
}

export function formatCondition(condition: ViewCondition): string {
    const match = condition.kind === "interface" ? condition.interface : condition.implements;
    const predicate = "tag" in match ? `tag(${match.tag})` : `id(${match.interfaceId})`;
    return condition.kind === "interface" ? `interface:${predicate}` : `service:implements(${predicate})`;
}

export function matchesInterface(value: ViewInterface, condition: InterfaceCondition): boolean {
    return "tag" in condition
        ? value.tags?.includes(condition.tag) === true
        : value.interfaceId === condition.interfaceId;
}

export function matchesTarget(target: ViewTarget, view: Pick<ViewContribution, "conditions">): boolean {
    return view.conditions.some(condition => condition.kind === target.kind
        && target.interfaces.some(value => matchesInterface(value,
            condition.kind === "interface" ? condition.interface : condition.implements)));
}

export function targetId(kind: ViewTarget["kind"], listing: ViewInterface): string {
    return `${kind}:${encodeURIComponent(listing.serviceId)}:${encodeURIComponent(listing.discoveredFrom)}`
        + (kind === "interface" ? `:${encodeURIComponent(listing.interfaceId)}:${listing.isDefault ? "default" : "qualified"}` : "");
}

export function interfaceTarget(listing: ViewInterface): ViewTarget {
    return {
        id: targetId("interface", listing), kind: "interface", serviceId: listing.serviceId,
        interfaceId: listing.interfaceId, discoveredFrom: listing.discoveredFrom, interfaces: [listing],
    };
}
