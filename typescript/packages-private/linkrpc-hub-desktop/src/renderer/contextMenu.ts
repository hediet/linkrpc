import { h } from './dom';

export interface ContextMenuItem {
    readonly label: string;
    /** Shown dimmed after the label, e.g. the term an action adds. */
    readonly detail?: string;
    readonly run: () => void;
}

export interface ContextMenuSection {
    readonly title: string;
    readonly items: readonly ContextMenuItem[];
}

let _open: { close(): void; } | undefined;

/** Show a menu at the pointer; it closes on a choice, Escape, scrolling, or a click elsewhere. */
export function showContextMenu(event: MouseEvent, sections: readonly ContextMenuSection[]): void {
    event.preventDefault();
    _open?.close();
    const menu = h('div', { class: 'context-menu', role: 'menu' }, ...sections.filter(section => section.items.length > 0).map(section =>
        h('div', { class: 'context-menu-section' },
            h('div', { class: 'context-menu-title' }, section.title),
            ...section.items.map(item => h('button', {
                class: 'context-menu-item',
                role: 'menuitem',
                onClick: () => {
                    close();
                    item.run();
                },
            }, h('span', {}, item.label), item.detail ? h('span', { class: 'context-menu-detail' }, item.detail) : undefined)))));
    const onPointer = (pointer: Event) => {
        if (!menu.contains(pointer.target as Node)) close();
    };
    const onKey = (key: KeyboardEvent) => {
        if (key.key === 'Escape') close();
    };
    const close = () => {
        menu.remove();
        window.removeEventListener('mousedown', onPointer, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', close, true);
        window.removeEventListener('blur', close);
        if (_open === handle) _open = undefined;
    };
    const handle = { close };
    _open = handle;
    document.body.append(menu);
    const { innerWidth, innerHeight } = window;
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - height - 4))}px`;
    window.addEventListener('mousedown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    menu.querySelector<HTMLButtonElement>('button')?.focus();
}
