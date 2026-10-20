import { defineInterface, defineInterfaceTemplate, requestType, type Schema } from '@hediet/linkrpc';
import {
    array,
    boolean,
    discriminatedUnion,
    enum as zEnum,
    extend,
    int,
    literal,
    nullable,
    number,
    object,
    optional,
    positive,
    string,
} from 'zod/mini';
import type { output as zInfer } from 'zod/v4/core';

export const consoleModeSchema = zEnum(['pipe', 'tty']);
export type ConsoleMode = zInfer<typeof consoleModeSchema>;

export const consoleSignalSchema = zEnum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGKILL']);
export type ConsoleSignal = zInfer<typeof consoleSignalSchema>;

export const consoleSizeSchema = object({
    cols: number().check(int(), positive()),
    rows: number().check(int(), positive()),
});
export type ConsoleSize = zInfer<typeof consoleSizeSchema>;

export const consoleExitSchema = object({ code: nullable(number()), signal: nullable(string()) });
export type ConsoleExit = zInfer<typeof consoleExitSchema>;

/** Base64-encoded raw bytes. */
const consoleDataSchema = string();

export const consoleAttachParamsSchema = object({
    /** Read-only attachments cannot send input, resize, or signal. Defaults to `true`. */
    interactive: optional(boolean()),
    /** TTY consoles adopt the size of the most recent interactive attachment. */
    size: optional(consoleSizeSchema),
    /** `all` (default) replays retained pipe output or the current TTY screen before live output. */
    replay: optional(zEnum(['all', 'none'])),
});
export type ConsoleAttachParams = zInfer<typeof consoleAttachParamsSchema>;

export const consoleClientMessageSchema = discriminatedUnion('t', [
    object({ t: literal('input'), data: consoleDataSchema }),
    object({ t: literal('resize'), cols: number().check(int(), positive()), rows: number().check(int(), positive()) }),
    object({ t: literal('signal'), signal: consoleSignalSchema }),
]);
export type ConsoleClientMessage = zInfer<typeof consoleClientMessageSchema>;

export const consoleServerMessageSchema = discriminatedUnion('t', [
    object({
        t: literal('console'),
        mode: consoleModeSchema,
        size: optional(consoleSizeSchema),
        signals: array(consoleSignalSchema),
        running: boolean(),
        pid: optional(number()),
    }),
    object({ t: literal('screen'), data: consoleDataSchema }),
    object({ t: literal('output'), stream: zEnum(['stdout', 'stderr', 'tty']), data: consoleDataSchema }),
    object({ t: literal('live') }),
    object({ t: literal('started'), pid: optional(number()) }),
    object({ t: literal('exit'), code: nullable(number()), signal: nullable(string()) }),
    object({ t: literal('resized'), cols: number(), rows: number() }),
    object({ t: literal('notice'), text: string() }),
]);
export type ConsoleServerMessage = zInfer<typeof consoleServerMessageSchema>;

export const consoleInfoSchema = object({
    mode: consoleModeSchema,
    size: optional(consoleSizeSchema),
    signals: array(consoleSignalSchema),
    running: boolean(),
    pid: optional(number()),
    exit: optional(consoleExitSchema),
});
export type ConsoleInfo = zInfer<typeof consoleInfoSchema>;

export const CONSOLE_INTERFACE_TAG = 'linkrpc.console';
export const CONSOLE_TEMPLATE_ID = 'linkrpc.console.v1';
export const consoleAttachResultSchema = object({ exit: nullable(consoleExitSchema) });

/**
 * The console protocol as an interface template. `params` selects a console of
 * the implementing service, like the parameters of a JSON-RPC connection: a
 * service with one console uses an empty object; a process manager can use an
 * address. Instantiating it tags the containing interface with
 * {@link CONSOLE_INTERFACE_TAG}, so clients find consoles through directory
 * tags and reflected template metadata.
 */
export const ConsoleTemplate = defineInterfaceTemplate(
    { id: CONSOLE_TEMPLATE_ID, parameters: ['params'], tags: [CONSOLE_INTERFACE_TAG] },
    <P>({ params }: { params: Schema<P> }) => ({
        info: requestType(object({ params }), consoleInfoSchema, {
            description: 'Describe the console selected by `params`.',
        }),
        attach: requestType(extend(consoleAttachParamsSchema, { params }), consoleAttachResultSchema, {
            description: 'Attach to the console selected by `params`. Pipe consoles separate stdout and stderr; '
                + 'TTY consoles provide a terminal with resize support. The stream sends `console` first, then '
                + 'replay (`output` chunks, or one `screen` for TTYs), then `live`, then live events. Data fields '
                + 'are base64-encoded bytes. Attachments share input and observe the same output. Cancelling '
                + 'detaches and never stops the process. Completes when the process ended without a pending restart.',
        }).withStream({
            client: consoleClientMessageSchema,
            server: consoleServerMessageSchema,
        }),
    }),
);

/** A standalone console for services with a single console, with wire methods `info` and `attach`. */
export const consoleInterface = defineInterface({
    id: 'linkrpc.console',
    description: 'A single process console; see the `linkrpc.console.v1` interface template.',
}, {
    console: ConsoleTemplate({ params: object({}) }).mapMembers({ info: 'info', attach: 'attach' }),
});

export function encodeConsoleData(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

export function decodeConsoleData(data: string): Uint8Array {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}
