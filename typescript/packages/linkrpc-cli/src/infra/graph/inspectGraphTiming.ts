export interface GraphTiming {
    readonly phase: string;
    readonly wallMs: number;
    readonly cpuUserMs: number;
    readonly cpuSystemMs: number;
    readonly ok: boolean;
    readonly detail: Readonly<Record<string, number>>;
}

export class GraphTimings {
    public constructor(private readonly _emit: (timing: GraphTiming) => void) {}

    public measureSync<T>(phase: string, operation: () => T, detail: GraphTiming["detail"] = {}): T {
        const finish = this._start(phase, detail);
        let ok = false;
        try {
            const result = operation();
            ok = true;
            return result;
        } finally {
            finish(ok);
        }
    }

    public async measureAsync<T>(phase: string, operation: () => Promise<T>, detail: GraphTiming["detail"] = {}): Promise<T> {
        const finish = this._start(phase, detail);
        let ok = false;
        try {
            const result = await operation();
            ok = true;
            return result;
        } finally {
            finish(ok);
        }
    }

    private _start(phase: string, detail: GraphTiming["detail"]): (ok: boolean) => void {
        const start = performance.now();
        const cpu = process.cpuUsage();
        return ok => {
            const elapsedCpu = process.cpuUsage(cpu);
            this._emit({
                phase,
                wallMs: performance.now() - start,
                cpuUserMs: elapsedCpu.user / 1000,
                cpuSystemMs: elapsedCpu.system / 1000,
                ok,
                detail,
            });
        };
    }
}
