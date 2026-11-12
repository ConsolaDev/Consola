import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationsChange, AutomationsSnapshot } from '../../shared/automations';

const { getSnapshot, onChanged, storage } = vi.hoisted(() => {
    const data = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
    };
    return { getSnapshot: vi.fn(), onChanged: vi.fn(), storage: data };
});
vi.mock('../services/automationsBridge', () => ({ automationsBridge: { getSnapshot, onChanged } }));
import { useAutomationsStore } from './automationsStore';

function snap(filePath: string): AutomationsSnapshot {
    return {
        filePath,
        fileExists: true,
        automations: [],
        issues: [],
        runs: [],
        queue: {},
        suggestAssignedReviews: null,
        templates: [],
    };
}

beforeEach(() => {
    storage.clear();
    getSnapshot.mockReset();
    onChanged.mockReset().mockReturnValue(() => {});
    useAutomationsStore.setState({ snapshots: {}, tab: 'activity', panel: null, lastSeen: {} });
});

describe('automationsStore', () => {
    it('openPanel replaces the panel and closePanel clears it', () => {
        const { openPanel, closePanel } = useAutomationsStore.getState();
        openPanel({ kind: 'run', runId: 'r1' });
        openPanel({ kind: 'automation', name: 'digest' });
        expect(useAutomationsStore.getState().panel).toEqual({ kind: 'automation', name: 'digest' });
        closePanel();
        expect(useAutomationsStore.getState().panel).toBeNull();
    });

    it('markActivitySeen persists per workspace', () => {
        useAutomationsStore.getState().markActivitySeen('w1', '2026-11-12T10:00:00.000Z');
        expect(useAutomationsStore.getState().lastSeen).toEqual({ w1: '2026-11-12T10:00:00.000Z' });
        expect(JSON.parse(storage.get('consola-automations-seen') ?? '{}')).toEqual({
            w1: '2026-11-12T10:00:00.000Z',
        });
    });

    it('survives storage that throws', () => {
        const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        useAutomationsStore.getState().markActivitySeen('w1', 'x');
        expect(useAutomationsStore.getState().lastSeen.w1).toBe('x');
        blocked.mockRestore();
    });

    it('load stores the workspace snapshot', async () => {
        getSnapshot.mockResolvedValue(snap('/a'));
        await useAutomationsStore.getState().load('w1');
        expect(useAutomationsStore.getState().snapshots.w1.filePath).toBe('/a');
    });

    it('a broadcast for another workspace leaves this one alone', () => {
        let push: (change: AutomationsChange) => void = () => {};
        onChanged.mockImplementation((cb: (change: AutomationsChange) => void) => {
            push = cb;
            return () => {};
        });
        useAutomationsStore.setState({ snapshots: { w1: snap('/one') } });
        useAutomationsStore.getState().subscribe();
        push({ workspaceId: 'w2', snapshot: snap('/two') });
        const { snapshots } = useAutomationsStore.getState();
        expect(snapshots.w1.filePath).toBe('/one');
        expect(snapshots.w2.filePath).toBe('/two');
    });
});
