import { graphView } from "../infra/graph/contribution";
import { loggingView } from "../infra/logging/contribution";
import type { ViewContribution } from "./types";

export const views: readonly ViewContribution[] = [graphView, loggingView];

export function getView(id: string): ViewContribution {
    const view = views.find(value => value.id === id);
    if (!view) throw new Error(`Unknown view "${id}". Run view list.`);
    return view;
}
