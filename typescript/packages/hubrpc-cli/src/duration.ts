const DURATION_PATTERN = /^(\d+)(ms|s|m|min|h)$/;

const UNIT_MS: Readonly<Record<string, number>> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    min: 60_000,
    h: 3_600_000,
};

export function parseDuration(value: string): number {
    const match = DURATION_PATTERN.exec(value.trim());
    if (match === null) {
        throw new Error(`invalid duration '${value}' (expected e.g. 250ms, 30s, 5min, or 2h)`);
    }
    const amount = Number.parseInt(match[1], 10);
    const durationMs = amount * UNIT_MS[match[2]];
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
        throw new Error(`invalid duration '${value}' (must be greater than zero)`);
    }
    return durationMs;
}
