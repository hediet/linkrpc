/**
 * Lists TCP ports listening on loopback-reachable addresses, using the platform's own tools.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ComputeNodeListeningPort } from './index';
import { readProcessDetails, type ProcessDetails } from './processDetails';

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;

export interface Listener {
    readonly address: string;
    readonly port: number;
    readonly pid?: number;
    readonly processName?: string;
}

export async function readListeningPorts(platform: NodeJS.Platform = process.platform): Promise<ComputeNodeListeningPort[]> {
    const ports = groupListeners((await readListeners(platform)).filter(listener => isLoopbackReachable(listener.address)));
    const details = await readProcessDetails(ports.flatMap(port => port.pid === undefined ? [] : [port.pid]), platform).catch(() => new Map<number, ProcessDetails>());
    return ports.map(port => ({ ...port, ...(port.pid === undefined ? undefined : details.get(port.pid)) }));
}

async function readListeners(platform: NodeJS.Platform): Promise<Listener[]> {
    if (platform === 'win32') {
        const [netstat, tasklist] = await Promise.all([run('netstat', ['-ano']), run('tasklist', ['/fo', 'csv', '/nh']).catch(() => '')]);
        const names = parseTasklistCsv(tasklist);
        return parseWindowsNetstat(netstat).map(listener => ({ ...listener, processName: listener.pid === undefined ? undefined : names.get(listener.pid) }));
    }
    if (platform === 'darwin') {
        return parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']));
    }
    try {
        return parseSs(await run('ss', ['-ltnpH']));
    } catch {
        const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(file => readFile(file, 'utf8').catch(() => '')));
        return tables.flatMap(parseProcNetTcp);
    }
}

/** Listening rows are recognized by their unspecified foreign address, since netstat localizes the state column. */
export function parseWindowsNetstat(output: string): Listener[] {
    const listeners: Listener[] = [];
    for (const line of output.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns[0] !== 'TCP' || columns.length < 5) {
            continue;
        }
        const local = splitEndpoint(columns[1]);
        const foreign = columns[2];
        if (!local || (foreign !== '0.0.0.0:0' && foreign !== '[::]:0')) {
            continue;
        }
        const pid = Number(columns[columns.length - 1]);
        listeners.push({ ...local, pid: Number.isInteger(pid) ? pid : undefined });
    }
    return listeners;
}

export function parseTasklistCsv(output: string): Map<number, string> {
    const names = new Map<number, string>();
    for (const line of output.split(/\r?\n/)) {
        const match = /^"(?<name>[^"]*)","(?<pid>\d+)"/.exec(line.trim());
        if (match?.groups) {
            names.set(Number(match.groups.pid), match.groups.name);
        }
    }
    return names;
}

export function parseSs(output: string): Listener[] {
    const listeners: Listener[] = [];
    for (const line of output.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        const localColumn = columns.findIndex(column => column.includes(':') && !column.startsWith('users:'));
        const local = localColumn >= 0 ? splitEndpoint(columns[localColumn]) : undefined;
        if (!local) {
            continue;
        }
        const process = /users:\(\("(?<name>[^"]+)",pid=(?<pid>\d+)/.exec(line);
        listeners.push({
            ...local,
            pid: process?.groups ? Number(process.groups.pid) : undefined,
            processName: process?.groups?.name,
        });
    }
    return listeners;
}

export function parseLsof(output: string): Listener[] {
    const listeners: Listener[] = [];
    let pid: number | undefined;
    let processName: string | undefined;
    for (const line of output.split(/\r?\n/)) {
        const value = line.slice(1);
        switch (line[0]) {
            case 'p':
                pid = Number(value);
                processName = undefined;
                break;
            case 'c':
                processName = value;
                break;
            case 'n': {
                const local = splitEndpoint(value.replace(/^\*:/, '0.0.0.0:'));
                if (local) {
                    listeners.push({ ...local, pid, processName });
                }
                break;
            }
        }
    }
    return listeners;
}

/** Parses `/proc/net/tcp{,6}`; state `0A` is LISTEN. Addresses are little-endian hex per 32-bit word. */
export function parseProcNetTcp(table: string): Listener[] {
    const listeners: Listener[] = [];
    for (const line of table.split(/\r?\n/).slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (columns[3] !== '0A') {
            continue;
        }
        const [addressHex, portHex] = columns[1]?.split(':') ?? [];
        if (!addressHex || !portHex) {
            continue;
        }
        const words = addressHex.match(/.{8}/g) ?? [];
        const bytes = words.flatMap(word => (word.match(/../g) ?? []).reverse().map(byte => parseInt(byte, 16)));
        const address = bytes.length === 4
            ? bytes.join('.')
            : formatIpv6(bytes);
        listeners.push({ address, port: parseInt(portHex, 16) });
    }
    return listeners;
}

function formatIpv6(bytes: readonly number[]): string {
    if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
        return `::ffff:${bytes.slice(12).join('.')}`;
    }
    const groups: string[] = [];
    for (let index = 0; index < bytes.length; index += 2) {
        groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
    }
    return groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::').replace(/:{3,}/, '::');
}

function splitEndpoint(value: string): { address: string; port: number } | undefined {
    const match = /^(?:\[(?<v6>[^\]]+)\]|(?<host>.*)):(?<port>\d+)$/.exec(value);
    if (!match?.groups) {
        return undefined;
    }
    const port = Number(match.groups.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return undefined;
    }
    const address = (match.groups.v6 ?? match.groups.host).replace(/%.*$/, '');
    return { address: address === '*' ? '0.0.0.0' : address, port };
}

export function isLoopbackReachable(address: string): boolean {
    const normalized = address.toLowerCase().replace(/^::ffff:/, '');
    return normalized === '0.0.0.0'
        || normalized === '::'
        || normalized === '0:0:0:0:0:0:0:0'
        || normalized === '::1'
        || normalized === '0:0:0:0:0:0:0:1'
        || /^127\.\d+\.\d+\.\d+$/.test(normalized);
}

function groupListeners(listeners: readonly Listener[]): ComputeNodeListeningPort[] {
    const byPort = new Map<number, { addresses: Set<string>; pid?: number; processName?: string }>();
    for (const listener of listeners) {
        const entry = byPort.get(listener.port) ?? { addresses: new Set<string>() };
        entry.addresses.add(listener.address);
        entry.pid ??= listener.pid;
        entry.processName ??= listener.processName;
        byPort.set(listener.port, entry);
    }
    return [...byPort].sort(([a], [b]) => a - b).map(([port, entry]) => ({
        port,
        addresses: [...entry.addresses].sort(),
        ...(entry.pid === undefined ? {} : { pid: entry.pid }),
        ...(entry.processName === undefined ? {} : { processName: entry.processName }),
    }));
}

function run(command: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}
