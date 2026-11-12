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

    it('applies retention when a run is added, using its createdAt as now', () => {
        const { store, history } = loaded({ 'ws-1': [run('old', 'ws-1', { createdAt: daysAgo(10), finishedAt: daysAgo(10) })] });
        store.add(run('new', 'ws-1', { createdAt: new Date(Date.parse(NOW) + 25 * DAY).toISOString(), status: 'queued' }));
        expect(store.runs().map((r) => r.id)).toEqual(['new']);
        expect(history.logs.get('ws-1')?.map((r) => r.id)).toEqual(['new']);
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
