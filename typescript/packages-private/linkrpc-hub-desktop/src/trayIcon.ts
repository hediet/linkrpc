import { deflateSync } from 'node:zlib';

export type TrayIconState = 'running' | 'warning' | 'stopped';

const COLORS: Record<TrayIconState, readonly [number, number, number]> = {
    running: [46, 160, 67],
    warning: [210, 153, 34],
    stopped: [128, 128, 128],
};

/**
 * The hub glyph (a ring around a dot) as a PNG. Colored by state, or black
 * for macOS template images, where a hollow center marks a stopped hub.
 */
export function trayIconPng(state: TrayIconState, size: number, template: boolean): Buffer {
    const [r, g, b] = template ? [0, 0, 0] : COLORS[state];
    const showDot = !(template && state === 'stopped');
    const pixels = Buffer.alloc(size * size * 4);
    const center = size / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x + 0.5 - center, y + 0.5 - center) / size;
            const ring = _coverage(Math.abs(d - 0.36) - 0.07, size);
            const dot = showDot ? _coverage(d - 0.17, size) : 0;
            const alpha = Math.max(ring, dot);
            const i = (y * size + x) * 4;
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
            pixels[i + 3] = Math.round(alpha * 255);
        }
    }
    return _encodePng(size, pixels);
}

/** Anti-aliased coverage for a signed distance (in units of the icon size). */
function _coverage(signedDistance: number, size: number): number {
    return Math.min(1, Math.max(0, 0.5 - signedDistance * size));
}

function _encodePng(size: number, rgba: Buffer): Buffer {
    const rows = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        _chunk('IHDR', header),
        _chunk('IDAT', deflateSync(rows)),
        _chunk('IEND', Buffer.alloc(0)),
    ]);
}

function _chunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(_crc32(typeAndData));
    return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function _crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
