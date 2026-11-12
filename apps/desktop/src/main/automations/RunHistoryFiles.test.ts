import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '@consola/factory-spec';
import { RunHistoryFiles } from './RunHistoryFiles';

const run = (id: string, fields: Partial<RunRecord> = {}) =>
    ({
        id,
        status: 'completed',
        createdAt: '2026-11-04T10:00:00.000Z',
        attribution: { workspaceId: 'ws-1' },
        ...fields,
    }) as unknown as RunRecord;

describe('RunHistoryFiles', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('last line per id wins, and a torn last line is skipped', () => {
        const first = JSON.stringify(run('r1', { status: 'running' }));
        const second = JSON.stringify(run('r1', { status: 'completed' }));
        fs.writeFileSync(path.join(dir, 'ws-1.jsonl'), `${first}\n${second}\n{"id":"r2","stat`);
        const loaded = new RunHistoryFiles(dir).load();
        expect(loaded.get('ws-1')).toEqual([run('r1', { status: 'completed' })]);
        // The torn line is gone from disk too, so the next append starts a fresh line.
        expect(fs.readFileSync(path.join(dir, 'ws-1.jsonl'), 'utf8')).toBe(`${second}\n`);
    });

    it('compacts once the log holds more than twice its live runs plus 50 lines', () => {
        const history = new RunHistoryFiles(dir);
        const file = path.join(dir, 'ws-1.jsonl');
        const lines = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        const live = [run('r1')];
        for (let index = 1; index <= 52; index++) history.append('ws-1', run('r1'), () => live);
        expect(lines()).toBe(52);
        history.append('ws-1', run('r1'), () => live);
        expect(lines()).toBe(1);
    });

    it('appends after a torn line without gluing onto it', () => {
        const file = path.join(dir, 'ws-1.jsonl');
        fs.writeFileSync(file, `${JSON.stringify(run('r1'))}\n{"id":"r2"`);
        const history = new RunHistoryFiles(dir);
        history.append('ws-1', run('r3'), () => []);
        expect(new RunHistoryFiles(dir).load().get('ws-1')?.map((r) => r.id)).toEqual(['r1', 'r3']);
    });

    it('refuses a workspace id that is not a token', () => {
        const history = new RunHistoryFiles(dir);
        expect(() => history.append('../x', run('r1'), () => [])).toThrow(/Not a workspace id/);
        expect(() => history.rewrite('../x', [])).toThrow(/Not a workspace id/);
        expect(() => history.remove('../x')).toThrow(/Not a workspace id/);
    });

    it('does not persist a run that has no workspace', () => {
        const history = new RunHistoryFiles(dir);
        history.append('ws-1', run('r1', { attribution: {} as never }), () => []);
        expect(fs.existsSync(path.join(dir, 'ws-1.jsonl'))).toBe(false);
    });

    it('rewrites a log whole, and removes it without complaint when it is already gone', () => {
        const history = new RunHistoryFiles(dir);
        history.append('ws-1', run('r1'), () => [run('r1')]);
        history.rewrite('ws-1', [run('r2')]);
        expect(new RunHistoryFiles(dir).load().get('ws-1')?.map((r) => r.id)).toEqual(['r2']);
        expect(fs.readdirSync(dir)).toEqual(['ws-1.jsonl']);
        history.remove('ws-1');
        expect(() => history.remove('ws-1')).not.toThrow();
        expect(new RunHistoryFiles(dir).load().size).toBe(0);
    });

    it('loads from a folder that does not exist yet', () => {
        expect(new RunHistoryFiles(path.join(dir, 'missing')).load().size).toBe(0);
    });
});
