import * as fs from 'node:fs';
import { z } from 'zod';

/** How the window's Calls table is filtered. */
export const CallsViewSettingsSchema = z.object({
    /** The call-log query, e.g. `-method:hediet/devbox::*`. */
    query: z.string().max(10_000).default(''),
    errorsOnly: z.boolean().default(false),
    live: z.boolean().default(true),
});
export type CallsViewSettings = z.output<typeof CallsViewSettingsSchema>;

const SettingsSchema = z.object({
    callsView: CallsViewSettingsSchema.catch(CallsViewSettingsSchema.parse({})),
});
type SettingsData = z.output<typeof SettingsSchema>;

/**
 * The tray app's own preferences: a JSON file in Electron's userData
 * directory, independent of the daemon's config. Unknown or invalid content
 * falls back to the defaults.
 */
export class DesktopSettings {
    public static load(file: string): DesktopSettings {
        let raw: unknown = {};
        try {
            raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch { /* missing or unreadable: defaults */ }
        const parsed = SettingsSchema.safeParse(raw);
        return new DesktopSettings(file, parsed.success ? parsed.data : SettingsSchema.parse({}));
    }

    private constructor(
        public readonly file: string,
        private _data: SettingsData,
    ) { }

    public get callsView(): CallsViewSettings {
        return this._data.callsView;
    }

    public setCallsView(callsView: CallsViewSettings): void {
        this._data = { ...this._data, callsView };
        const temp = `${this.file}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(this._data, null, 4)}\n`);
        fs.renameSync(temp, this.file);
    }
}
