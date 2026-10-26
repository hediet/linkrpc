/**
 * Reads the command line and working directory of processes, using the platform's own facilities.
 * Processes the caller may not inspect (other users, elevated, exited) are omitted.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;

export interface ProcessDetails {
    readonly commandLine?: string;
    readonly cwd?: string;
}

export async function readProcessDetails(pids: readonly number[], platform: NodeJS.Platform = process.platform): Promise<Map<number, ProcessDetails>> {
    const unique = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0);
    if (unique.length === 0) {
        return new Map();
    }
    if (platform === 'win32') {
        return parseWindowsProcessDetails(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(windowsScript(unique))]));
    }
    if (platform === 'darwin') {
        const list = unique.join(',');
        const [commands, cwds] = await Promise.all([
            run('ps', ['-o', 'pid=,command=', '-p', list]).catch(() => ''),
            run('lsof', ['-a', '-d', 'cwd', '-p', list, '-Fpn']).catch(() => ''),
        ]);
        return mergeDetails(parsePsCommands(commands), parseLsofCwds(cwds));
    }
    const entries = await Promise.all(unique.map(async pid => {
        const [cmdline, cwd] = await Promise.all([
            readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => undefined),
            readlink(`/proc/${pid}/cwd`).catch(() => undefined),
        ]);
        const argv = cmdline?.split('\0');
        if (argv?.at(-1) === '') {
            argv.pop();
        }
        return [pid, compact({ commandLine: argv?.length ? formatArgv(argv) : undefined, cwd })] as const;
    }));
    return new Map(entries.filter(([, details]) => details.commandLine !== undefined || details.cwd !== undefined));
}

/** Parses the helper's JSON: one object, or an array of `{ pid, commandLine, cwd }`. */
export function parseWindowsProcessDetails(output: string): Map<number, ProcessDetails> {
    const details = new Map<number, ProcessDetails>();
    const trimmed = output.trim();
    if (!trimmed) {
        return details;
    }
    const parsed: unknown = JSON.parse(trimmed);
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        if (typeof entry !== 'object' || entry === null || typeof entry.pid !== 'number') {
            continue;
        }
        const cwd = typeof entry.cwd === 'string' && entry.cwd ? entry.cwd.replace(/(?<!^[A-Za-z]:)\\$/, '') : undefined;
        details.set(entry.pid, compact({ commandLine: typeof entry.commandLine === 'string' && entry.commandLine ? entry.commandLine : undefined, cwd }));
    }
    return details;
}

/** Parses `ps -o pid=,command=`. */
export function parsePsCommands(output: string): Map<number, ProcessDetails> {
    const details = new Map<number, ProcessDetails>();
    for (const line of output.split(/\r?\n/)) {
        const match = /^\s*(?<pid>\d+)\s+(?<command>.+)$/.exec(line);
        if (match?.groups) {
            details.set(Number(match.groups.pid), { commandLine: match.groups.command.trim() });
        }
    }
    return details;
}

/** Parses `lsof -a -d cwd -Fpn`. */
export function parseLsofCwds(output: string): Map<number, ProcessDetails> {
    const details = new Map<number, ProcessDetails>();
    let pid: number | undefined;
    for (const line of output.split(/\r?\n/)) {
        if (line.startsWith('p')) {
            pid = Number(line.slice(1));
        } else if (line.startsWith('n') && pid !== undefined) {
            details.set(pid, { cwd: line.slice(1) });
        }
    }
    return details;
}

/** Joins an argument vector for display, quoting arguments the way a POSIX shell would need them. */
export function formatArgv(argv: readonly string[]): string {
    return argv.map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

function mergeDetails(...maps: readonly Map<number, ProcessDetails>[]): Map<number, ProcessDetails> {
    const merged = new Map<number, ProcessDetails>();
    for (const map of maps) {
        for (const [pid, details] of map) {
            merged.set(pid, { ...merged.get(pid), ...details });
        }
    }
    return merged;
}

function compact(details: { commandLine?: string; cwd?: string }): ProcessDetails {
    return {
        ...(details.commandLine === undefined ? {} : { commandLine: details.commandLine }),
        ...(details.cwd === undefined ? {} : { cwd: details.cwd }),
    };
}

/**
 * Reads the 64-bit `RTL_USER_PROCESS_PARAMETERS` of each process (Windows offers no tool that
 * reports another process's working directory). The compiled helper is cached per user.
 */
const WINDOWS_HELPER_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class LinkRpcProcessDetails {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref BasicInformation info, int size, out int returned);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicInformation { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }

    static byte[] Read(IntPtr handle, IntPtr address, int size) {
        var buffer = new byte[size];
        IntPtr read;
        return ReadProcessMemory(handle, address, buffer, (IntPtr)size, out read) && (long)read == size ? buffer : null;
    }

    static string ReadUnicodeString(IntPtr handle, IntPtr address) {
        var header = Read(handle, address, 16);
        if (header == null) return null;
        int length = BitConverter.ToUInt16(header, 0);
        var buffer = (IntPtr)BitConverter.ToInt64(header, 8);
        if (length == 0 || buffer == IntPtr.Zero) return "";
        var data = Read(handle, buffer, length);
        return data == null ? null : Encoding.Unicode.GetString(data);
    }

    public static string[] Get(int pid) {
        if (IntPtr.Size != 8) return null;
        IntPtr handle = OpenProcess(0x0410, false, pid);
        if (handle == IntPtr.Zero) return null;
        try {
            var info = new BasicInformation();
            int returned;
            if (NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(info), out returned) != 0) return null;
            var parameters = Read(handle, info.PebBaseAddress + 0x20, 8);
            if (parameters == null) return null;
            var address = (IntPtr)BitConverter.ToInt64(parameters, 0);
            return new[] { ReadUnicodeString(handle, address + 0x70), ReadUnicodeString(handle, address + 0x38) };
        } finally {
            CloseHandle(handle);
        }
    }
}
`;

function windowsScript(pids: readonly number[]): string {
    const hash = createHash('sha256').update(WINDOWS_HELPER_SOURCE).digest('hex').slice(0, 16);
    const assembly = join(tmpdir(), `linkrpc-process-details-${hash}.dll`);
    return [
        `$ErrorActionPreference = 'Stop'`,
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8`,
        `$assembly = ${powerShellString(assembly)}`,
        `if (-not (Test-Path -LiteralPath $assembly)) {`,
        `    $temporary = "$assembly.$PID.tmp"`,
        `    Add-Type -TypeDefinition ${powerShellString(WINDOWS_HELPER_SOURCE)} -OutputAssembly $temporary`,
        `    Move-Item -LiteralPath $temporary -Destination $assembly -Force -ErrorAction SilentlyContinue`,
        `    if (-not (Test-Path -LiteralPath $assembly)) { $assembly = $temporary }`,
        `}`,
        `Add-Type -LiteralPath $assembly`,
        `$results = foreach ($id in @(${pids.join(',')})) {`,
        `    $details = [LinkRpcProcessDetails]::Get($id)`,
        `    if ($details) { [pscustomobject]@{ pid = $id; commandLine = $details[0]; cwd = $details[1] } }`,
        `}`,
        `ConvertTo-Json -Compress -InputObject @($results)`,
    ].join('\n');
}

function powerShellString(value: string): string {
    return `'${value.replace(/'/g, `''`)}'`;
}

function encodePowerShell(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
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
