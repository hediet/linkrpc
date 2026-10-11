const DURATION_PATTERN = /^(\d+)(ms|s|m|min|h)$/;

export type ConnectionLimit = number | "inf";

export function parseConnectionLimit(value: string): ConnectionLimit {
    return validateConnectionLimit(value === "inf" ? value : parseDuration(value));
}

export function parseConnectionLimitMilliseconds(value: string): ConnectionLimit {
    if (value === "inf") return value;
    if (!/^\d+$/.test(value)) {
        throw new Error(`invalid connection limit '${value}' (expected milliseconds or inf)`);
    }
    return validateConnectionLimit(Number(value));
}

export function validateConnectionLimit(value: ConnectionLimit): ConnectionLimit {
    if (value !== "inf" && (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) {
        throw new Error("connection limit must be inf or between 1 and 2147483647 milliseconds");
    }
    return value;
}

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
