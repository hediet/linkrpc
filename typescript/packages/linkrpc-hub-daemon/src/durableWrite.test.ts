import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileDurably } from './durableWrite';

describe('writeFileDurably', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrh-durable-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('replaces the file and leaves no temporary file behind', () => {
        const file = path.join(dir, 'state.json');
        writeFileDurably(file, 'old');
        writeFileDurably(file, 'new');
        expect({ content: fs.readFileSync(file, 'utf8'), files: fs.readdirSync(dir) })
            .toEqual({ content: 'new', files: ['state.json'] });
    });

    it('removes the temporary file when the replacement fails', () => {
        const target = path.join(dir, 'occupied');
        fs.mkdirSync(target);
        expect(() => writeFileDurably(target, 'data')).toThrow();
        expect(fs.readdirSync(dir)).toEqual(['occupied']);
    });
});
