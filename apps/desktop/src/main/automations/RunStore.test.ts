import { describe, expect, it } from 'vitest';
import type { RunRecord } from '@consola/factory-spec';
import { MAX_RUNS_PER_WORKSPACE, RETENTION_DAYS, RunStore, type AutomationStateFile } from './RunStore';
import { memoryHistory } from './runHistory.test-helpers';

const NOW = '2026-11-12T10:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

function run(id: string, workspaceId: string, fields: Partial<RunRecord> = {}): RunRecord {
    return {
        id,
        status: 'completed',
        createdAt: daysAgo(1),
        updatedAt: daysAgo(1),
        finishedAt: daysAgo(1),
        attribution: { workspaceId },
        ...fields,
    } as unknown as RunRecord;
}

function memoryFile(initial: AutomationStateFile | null = null) {
    let stored = initial;
    return {
        read: () => stored,
        write: (value: AutomationStateFile) => {
            stored = JSON.parse(JSON.stringify(value));
        },
        get stored() {
            return stored;
        },
    };
}

function loaded(runs: Record<string, RunRecord[]> = {}, state: AutomationStateFile | null = null) {
    const history = memoryHistory(runs);
    const file = memoryFile(state);
    const store = new RunStore(file, history);
    store.load(NOW);
    return { store, history, file };
}

describe('RunStore history', () => {
    it("moves a version-1 file's runs into each workspace's history", () => {
        const runs = [run('c', 'ws-2', { createdAt: daysAgo(1) }), run('b', 'ws-1', { createdAt: daysAgo(2) }), run('a', 'ws-1', { createdAt: daysAgo(3) })];
        const { store, history, file } = loaded({}, { version: 1, lastFired: { k: 'v' }, runs });
        expect(store.runs().map((r) => r.id)).toEqual(['c', 'b', 'a']);
        expect(history.logs.get('ws-1')?.map((r) => r.id).sort()).toEqual(['a', 'b']);
        expect(history.logs.get('ws-2')?.map((r) => r.id)).toEqual(['c']);
        expect(file.stored).toMatchObject({ version: 2, lastFired: { k: 'v' } });
        expect(file.stored).not.toHaveProperty('runs');
    });

    it('keeps 30 days, and never drops a run waiting or running', () => {
        expect(RETENTION_DAYS).toBe(30);
        const old = daysAgo(90);
        const { store } = loaded({
            'ws-1': [
                run('stale', 'ws-1', { createdAt: daysAgo(40), finishedAt: daysAgo(31) }),
                run('fresh', 'ws-1', { createdAt: daysAgo(40), finishedAt: daysAgo(29) }),
                run('approval', 'ws-1', { status: 'needs-approval', createdAt: old, finishedAt: undefined, updatedAt: old }),
                run('line', 'ws-1', { status: 'queued', createdAt: old, finishedAt: undefined, updatedAt: old }),
            ],
        });
        expect(store.runs().map((r) => r.id).sort()).toEqual(['approval', 'fresh', 'line']);
    });

    it('rewrites a workspace that retention shortened, and leaves the others alone', () => {
        const { history } = loaded({
            'ws-1': [run('stale', 'ws-1', { finishedAt: daysAgo(31), createdAt: daysAgo(40) }), run('fresh', 'ws-1')],
            'ws-2': [run('other', 'ws-2')],
        });
        expect(history.logs.get('ws-1')?.map((r) => r.id)).toEqual(['fresh']);
        expect(history.appends).toEqual([]);
    });

    it("caps each workspace at MAX_RUNS_PER_WORKSPACE without touching another's", () => {
        const many = Array.from({ length: MAX_RUNS_PER_WORKSPACE + 1 }, (_, index) =>
            run(`r${index}`, 'ws-1', { createdAt: new Date(Date.parse(NOW) - (index + 1) * 1000).toISOString() })
        );
        const { store } = loaded({ 'ws-1': many, 'ws-2': [run('x', 'ws-2'), run('y', 'ws-2'), run('z', 'ws-2')] });
        const inWorkspace = (id: string) => store.runs().filter((r) => r.attribution.workspaceId === id);
        expect(inWorkspace('ws-1')).toHaveLength(MAX_RUNS_PER_WORKSPACE);
        expect(inWorkspace('ws-2')).toHaveLength(3);
        // `r1000` is the oldest.
        expect(store.get(`r${MAX_RUNS_PER_WORKSPACE}`)).toBeUndefined();
        expect(store.get('r0')).toBeDefined();
    });

    it('never drops a run waiting or running to make room under the ceiling', () => {
        const { store } = loaded();
        store.add(run('waiting', 'ws-1', { status: 'needs-approval', createdAt: daysAgo(0.5) }));
        for (let index = 0; index < MAX_RUNS_PER_WORKSPACE + 20; index++) {
            store.add(run(`done-${index}`, 'ws-1', { createdAt: daysAgo(0.4) }));
        }
        expect(store.runs()).toHaveLength(MAX_RUNS_PER_WORKSPACE);
        expect(store.get('waiting')).toBeDefined();
    });

    it('drops expired runs from memory when a run is added, and appends rather than rewrites', () => {
        const { store, history } = loaded({ 'ws-1': [run('old', 'ws-1', { createdAt: daysAgo(10), finishedAt: daysAgo(10) })] });
        store.add(run('new', 'ws-1', { createdAt: new Date(Date.parse(NOW) + 25 * DAY).toISOString(), status: 'queued' }));
        expect(store.runs().map((r) => r.id)).toEqual(['new']);
        expect(history.rewrites).toEqual([]);
        expect(history.appends.map((call) => call.run.id)).toEqual(['new']);
    });

    it('keeps the order of runs created in the same instant across a migration and a compaction', async () => {
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const { RunHistoryFiles } = await import('./RunHistoryFiles');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-ties-'));
        try {
            const at = daysAgo(1);
            const ids = ['a', 'b', 'c'];
            const tied = ids.map((id) => run(id, 'ws-1', { status: 'queued', createdAt: at, finishedAt: undefined }));
            // Version 1 lists newest first.
            const first = new RunStore(memoryFile({ version: 1, lastFired: {}, runs: [...tied].reverse() }), new RunHistoryFiles(dir));
            first.load(NOW);
            expect(first.runs().map((r) => r.id)).toEqual(['c', 'b', 'a']);
            const reloaded = () => {
                const store = new RunStore(memoryFile({ version: 2, lastFired: {} }), new RunHistoryFiles(dir));
                store.load(NOW);
                return store.runs().map((r) => r.id);
            };
            expect(reloaded()).toEqual(['c', 'b', 'a']);

            // Enough updates to cross 2 x live + 50 lines and compact.
            for (let index = 0; index < 60; index++) first.update('b', { updatedAt: `2026-11-12T10:00:${String(index).padStart(2, '0')}.000Z` });
            expect(fs.readFileSync(path.join(dir, 'ws-1.jsonl'), 'utf8').split('\n').filter(Boolean).length).toBeLessThan(60);
            expect(reloaded()).toEqual(['c', 'b', 'a']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps logs a version-1 file does not name, and lets its own record win a clash', () => {
        const { store, history } = loaded(
            { 'ws-9': [run('other', 'ws-9')], 'ws-1': [run('same', 'ws-1', { summary: 'from the log' })] },
            { version: 1, lastFired: {}, runs: [run('same', 'ws-1', { summary: 'from v1' })] }
        );
        expect(store.get('other')).toBeDefined();
        expect(store.get('same')?.summary).toBe('from v1');
        expect(store.runs().filter((r) => r.id === 'same')).toHaveLength(1);
        expect(history.logs.get('ws-9')?.map((r) => r.id)).toEqual(['other']);
    });

    it('strips approval from runs that are already over, or that load ends as interrupted', () => {
        const approval = { args: { x: 1 } };
        const migrated = loaded(
            {},
            {
                version: 1,
                lastFired: {},
                runs: [run('done', 'ws-1', { approval }), run('cut', 'ws-1', { status: 'running', approval, finishedAt: undefined })],
            }
        );
        expect(migrated.store.get('done')?.approval).toBeUndefined();
        expect(migrated.store.get('cut')).toMatchObject({ status: 'failed' });
        expect(migrated.store.get('cut')?.approval).toBeUndefined();
        expect(migrated.history.logs.get('ws-1')?.find((r) => r.id === 'cut')?.approval).toBeUndefined();
    });

    it('drops approval once a run ends', () => {
        const { store } = loaded();
        store.add(run('a', 'ws-1', { status: 'needs-approval', approval: { args: { x: 1 } } }));
        store.update('a', { status: 'queued' });
        expect(store.get('a')?.approval).toEqual({ args: { x: 1 } });
        store.update('a', { status: 'completed' });
        expect(store.get('a')?.approval).toBeUndefined();
    });

    it("appends to its own workspace's history", () => {
        const { store, history } = loaded({ 'ws-2': [run('other', 'ws-2')] });
        store.add(run('a', 'ws-1', { status: 'running' }));
        store.update('a', { status: 'completed' });
        expect(history.appends.map((call) => [call.workspaceId, call.run.id, call.run.status])).toEqual([
            ['ws-1', 'a', 'running'],
            ['ws-1', 'a', 'completed'],
        ]);
    });

    it('does not persist a run that belongs to no workspace', () => {
        const { store, history } = loaded();
        store.add({ id: 'loose', status: 'completed', attribution: {} } as never);
        expect(store.get('loose')).toBeDefined();
        expect(history.appends).toEqual([]);
    });

    it('forgets a deleted workspace', () => {
        const { store, history } = loaded({ 'ws-1': [run('a', 'ws-1')], 'ws-2': [run('b', 'ws-2')] });
        store.forgetWorkspace('ws-1');
        expect(store.runs().map((r) => r.id)).toEqual(['b']);
        expect(history.removed).toEqual(['ws-1']);
    });

    it('revokes an acceptance and records who added an entry', () => {
        const { store, file } = loaded({}, { version: 2, lastFired: {}, accepted: { 'ws-1 a': 'v1' } });
        store.revokeAcceptance('ws-1 a');
        expect(store.acceptedVersion('ws-1 a')).toBeUndefined();

        store.markAdded('ws-1 b', { sessionId: 's-1', sessionName: 'Planner', at: NOW });
        expect(store.addedBy('ws-1 b')).toEqual({ sessionId: 's-1', sessionName: 'Planner', at: NOW, seen: false });
        store.acknowledgeAdded('ws-1 b');
        expect(store.addedBy('ws-1 b')?.seen).toBe(true);
        expect(file.stored?.added?.['ws-1 b']?.seen).toBe(true);
        store.keepAdded(new Set());
        expect(store.addedBy('ws-1 b')).toBeUndefined();
    });

    it('loads version 2 state with history from the logs', () => {
        const { store } = loaded({ 'ws-1': [run('a', 'ws-1')] }, { version: 2, lastFired: { k: 'v' } });
        expect(store.lastFired('k')).toBe('v');
        expect(store.get('a')).toBeDefined();
    });
});
