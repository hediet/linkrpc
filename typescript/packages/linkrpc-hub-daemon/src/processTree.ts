import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

/**
 * Whether children get their own process group, so that the whole tree can be
 * signalled. Windows has no process groups; a Windows Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (plus `taskkill /T` fallback) tracks
 * each service's entire descendant tree and terminates it on stop or daemon exit.
 */
export const SPAWN_DETACHED = process.platform !== 'win32';

/** Ask a service's process tree to exit (POSIX only; Windows has no equivalent). */
export function terminateProcessTree(pid: number): void {
    if (process.platform === 'win32') return;
    _signalGroup(pid, 'SIGTERM');
}

/** Deliver a POSIX signal to a service's process group. */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
    _signalGroup(pid, signal);
}

/**
 * Attach a spawned service process (and any descendants it already spawned) to
 * a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so every
 * descendant is killed if the service is stopped, exits leaving orphans, or the
 * daemon itself dies.
 */
export function trackProcessTree(pid: number): Promise<boolean> {
    if (process.platform !== 'win32') return Promise.resolve(false);
    return _jobGuard().track(pid);
}

/**
 * Release the Windows Job Object for an exited service process. Because
 * `KILL_ON_JOB_CLOSE` is set, closing the job handle also terminates any
 * orphaned descendants left behind after the root process exited.
 */
export function releaseProcessTree(pid: number): Promise<boolean> {
    if (process.platform !== 'win32') return Promise.resolve(false);
    return _jobGuard().release(pid);
}

/** Forcefully end a process and all of its descendants. */
export async function killProcessTree(pid: number): Promise<void> {
    if (process.platform !== 'win32') {
        _signalGroup(pid, 'SIGKILL');
        return;
    }
    const killedByJob = await _jobGuard().kill(pid);
    if (killedByJob) return;
    await _taskkillTree(pid);
}

function _taskkillTree(pid: number): Promise<void> {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise(resolve => {
        const child = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        child.once('error', () => resolve());
        child.once('exit', () => resolve());
    });
}

function _signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch { /* already gone */ }
    }
}

// ---- Windows Job Object guardian --------------------------------------------
//
// A single hidden PowerShell helper holds one Win32 Job Object (with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) per tracked service PID. Its stdin pipe
// is owned by this daemon process: if the daemon crashes or is terminated with
// TerminateProcess, the pipe closes immediately, the helper exits, and the
// Windows kernel closes every Job handle — terminating every service tree.

const WIN_JOB_GUARD_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class LinkRpcJobGuard {
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private static readonly Dictionary<int, IntPtr> Jobs = new Dictionary<int, IntPtr>();

    private static void AssignPid(IntPtr job, uint pid) {
        IntPtr proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
        if (proc == IntPtr.Zero) return;
        AssignProcessToJobObject(job, proc);
        CloseHandle(proc);
    }

    private static List<uint> DescendantsOf(uint rootPid) {
        var children = new Dictionary<uint, List<uint>>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return new List<uint>();
        try {
            var entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snap, ref entry)) {
                do {
                    List<uint> list;
                    if (!children.TryGetValue(entry.th32ParentProcessID, out list)) {
                        list = new List<uint>();
                        children[entry.th32ParentProcessID] = list;
                    }
                    list.Add(entry.th32ProcessID);
                } while (Process32NextW(snap, ref entry));
            }
        } finally {
            CloseHandle(snap);
        }
        var result = new List<uint>();
        var queue = new Queue<uint>();
        queue.Enqueue(rootPid);
        while (queue.Count > 0) {
            uint current = queue.Dequeue();
            List<uint> next;
            if (!children.TryGetValue(current, out next)) continue;
            foreach (uint child in next) {
                result.Add(child);
                queue.Enqueue(child);
            }
        }
        return result;
    }

    public static bool Add(int pid) {
        if (Jobs.ContainsKey(pid)) return true;
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return false;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, size)) {
            CloseHandle(job);
            return false;
        }
        IntPtr proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, (uint)pid);
        if (proc == IntPtr.Zero) {
            CloseHandle(job);
            return false;
        }
        bool ok = AssignProcessToJobObject(job, proc);
        CloseHandle(proc);
        if (!ok) {
            CloseHandle(job);
            return false;
        }
        // Assign any descendants spawned in the brief window before Add ran.
        foreach (uint desc in DescendantsOf((uint)pid)) {
            AssignPid(job, desc);
        }
        Jobs[pid] = job;
        return true;
    }

    public static bool Kill(int pid) {
        IntPtr job;
        if (!Jobs.TryGetValue(pid, out job)) return false;
        Jobs.Remove(pid);
        bool ok = TerminateJobObject(job, 1);
        CloseHandle(job);
        return ok;
    }

    public static bool Release(int pid) {
        IntPtr job;
        if (!Jobs.TryGetValue(pid, out job)) return false;
        Jobs.Remove(pid);
        CloseHandle(job);
        return true;
    }
}
"@
while ($null -ne ($line = [Console]::In.ReadLine())) {
    $parts = $line.Split(' ')
    if ($parts.Length -lt 3) { continue }
    $op = $parts[0]
    $seq = $parts[1]
    $pidVal = [int]$parts[2]
    $res = $false
    if ($op -eq 'ADD') { $res = [LinkRpcJobGuard]::Add($pidVal) }
    elseif ($op -eq 'KILL') { $res = [LinkRpcJobGuard]::Kill($pidVal) }
    elseif ($op -eq 'RELEASE') { $res = [LinkRpcJobGuard]::Release($pidVal) }
    [Console]::Out.WriteLine("OK $seq $(if ($res) { 1 } else { 0 })")
    [Console]::Out.Flush()
}
`;

const JOB_OP_TIMEOUT_MS = 5_000;

class WindowsJobGuard {
    private _child: ChildProcess | undefined;
    private _buffer = '';
    private _nextSeq = 1;
    private readonly _pending = new Map<number, (ok: boolean) => void>();

    track(pid: number): Promise<boolean> {
        return this._send('ADD', pid);
    }

    release(pid: number): Promise<boolean> {
        if (!this._child) return Promise.resolve(false);
        return this._send('RELEASE', pid);
    }

    kill(pid: number): Promise<boolean> {
        if (!this._child) return Promise.resolve(false);
        return this._send('KILL', pid);
    }

    private _ensureChild(): ChildProcess | undefined {
        if (this._child && !this._child.killed && this._child.exitCode === null && this._child.stdin?.writable) {
            return this._child;
        }
        const powershell = path.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
        );
        const encoded = Buffer.from(WIN_JOB_GUARD_SCRIPT, 'utf16le').toString('base64');
        const child = spawn(
            powershell,
            ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
            { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
        );
        // Never keep the Node event loop alive solely for the job guardian.
        child.unref();
        child.stdin?.on('error', () => { /* handled by exit */ });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => this._onStdout(chunk));
        child.once('error', () => this._reset(child));
        child.once('exit', () => this._reset(child));
        this._child = child;
        return child;
    }

    private _send(op: 'ADD' | 'KILL' | 'RELEASE', pid: number): Promise<boolean> {
        const child = this._ensureChild();
        if (!child?.stdin?.writable) return Promise.resolve(false);
        const seq = this._nextSeq++;
        return new Promise<boolean>(resolve => {
            const timer = setTimeout(() => {
                if (this._pending.delete(seq)) resolve(false);
            }, JOB_OP_TIMEOUT_MS);
            timer.unref();
            this._pending.set(seq, ok => {
                clearTimeout(timer);
                resolve(ok);
            });
            try {
                child.stdin!.write(`${op} ${seq} ${pid}\n`);
            } catch {
                if (this._pending.delete(seq)) {
                    clearTimeout(timer);
                    resolve(false);
                }
            }
        });
    }

    private _onStdout(chunk: string): void {
        this._buffer += chunk;
        let newline: number;
        while ((newline = this._buffer.indexOf('\n')) !== -1) {
            const line = this._buffer.slice(0, newline).trim();
            this._buffer = this._buffer.slice(newline + 1);
            if (!line.startsWith('OK ')) continue;
            const [, seqText, okText] = line.split(' ');
            const seq = Number(seqText);
            const done = this._pending.get(seq);
            if (done) {
                this._pending.delete(seq);
                done(okText === '1');
            }
        }
    }

    private _reset(child: ChildProcess): void {
        if (this._child === child) {
            this._child = undefined;
            this._buffer = '';
        }
        for (const resolve of this._pending.values()) resolve(false);
        this._pending.clear();
    }
}

let _sharedJobGuard: WindowsJobGuard | undefined;
function _jobGuard(): WindowsJobGuard {
    return _sharedJobGuard ??= new WindowsJobGuard();
}
