import type { HubDesktopBridge } from '../protocol';

export const bridge = (window as unknown as { hubDesktop: HubDesktopBridge; }).hubDesktop;

export type Child = Node | string | undefined | false;
export type Props = Record<string, unknown> & { class?: string; };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined) continue;
        if (key === 'class') element.className = value as string;
        else if (key.startsWith('on') && typeof value === 'function') {
            element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (key in element) (element as unknown as Record<string, unknown>)[key] = value;
        else element.setAttribute(key, String(value));
    }
    for (const child of children) {
        if (child !== undefined && child !== false) element.append(child);
    }
    return element;
}

export function errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
