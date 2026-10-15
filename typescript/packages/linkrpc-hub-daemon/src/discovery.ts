import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

/**
 * How to reach one daemon endpoint. The daemon writes one file for
 * applications ({@link HubHome.discoveryFile}) and one for management
 * ({@link HubHome.managementFile}); both are private to the user.
 */
export const EndpointDiscoverySchema = z.object({
    version: z.literal(1),
    pid: z.number().int(),
    /** Named pipe (Windows) or Unix socket path. */
    endpoint: z.string().min(1),
    token: z.string().min(1),
});
export type EndpointDiscovery = z.infer<typeof EndpointDiscoverySchema>;

/** The published endpoint, or `undefined` when absent or unreadable. */
export function readEndpointDiscovery(file: string): EndpointDiscovery | undefined {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
    try {
        const parsed = EndpointDiscoverySchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

/** Atomically write a JSON file readable only by the current user. */
export function writePrivateJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
}
