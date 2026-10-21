import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceConsoleInput } from './serviceConsoleInput';

class TerminalInput extends PassThrough {
    readonly isTTY = true;
    isRaw = false;
    setRawMode(value: boolean): this { this.isRaw = value; return this; }
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

function fixture(terminal = true, initiallyRaw = false) {
    const input = terminal ? new TerminalInput() : new PassThrough();
    if (input instanceof TerminalInput) input.isRaw = initiallyRaw;
    const output = new PassThrough();
    const send = vi.fn<(data: string) => void>();
    const interrupt = vi.fn();
    const close = vi.fn();
    const consoleInput = new ServiceConsoleInput(input, output, send, interrupt, close);
    cleanup.push(() => { consoleInput.dispose(); input.destroy(); output.destroy(); });
    return { input, send, interrupt, close, consoleInput };
}

it('forwards edited lines, handles Ctrl+C, and closes on Ctrl+D without Enter', () => {
    const f = fixture();
    f.input.write('hello\r');
    expect(f.send.mock.calls).toEqual([['hello\n']]);
    f.input.write('\x03');
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.close).not.toHaveBeenCalled();
    f.input.write('\x04');
    expect(f.close).toHaveBeenCalledOnce();
});

it('keeps unfinished input on Ctrl+D and uses normal delete-under-cursor behavior', () => {
    const f = fixture();
    f.input.write('abc\x04');
    expect(f.close).not.toHaveBeenCalled();
    f.input.write('\x1b[D\x04\r');
    expect(f.send.mock.calls).toEqual([['ab\n']]);
    f.input.write('\x04');
    expect(f.close).toHaveBeenCalledOnce();
});

it.each([false, true])('restores terminal raw mode (%s) without treating disposal as user cancellation', raw => {
    const f = fixture(true, raw);
    expect(f.input).toMatchObject({ isRaw: true });
    f.consoleInput.dispose();
    expect(f.input).toMatchObject({ isRaw: raw });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.input.listenerCount('keypress')).toBe(0);
});

it('retains the legacy Ctrl+] escape', () => {
    const f = fixture();
    f.input.write('\x1d');
    expect(f.close).toHaveBeenCalledOnce();
});

it('keeps piped input verbatim and does not cancel on EOF', async () => {
    const f = fixture(false);
    f.input.end('count\n');
    await new Promise<void>(resolve => f.input.once('end', resolve));
    expect(f.send.mock.calls).toEqual([['count\n']]);
    expect(f.close).not.toHaveBeenCalled();
});
