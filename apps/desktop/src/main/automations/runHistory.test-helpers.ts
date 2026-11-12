import type { RunRecord } from '@consola/factory-spec';
import type { RunHistory } from './RunStore';

/** A `RunHistory` held in memory, recording what the store asked of it. */
export function memoryHistory(initial: Record<string, RunRecord[]> = {}) {
    const logs = new Map<string, RunRecord[]>(Object.entries(initial));
    const appends: Array<{ workspaceId: string; run: RunRecord }> = [];
    const removed: string[] = [];
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    const history: RunHistory & { logs: typeof logs; appends: typeof appends; removed: typeof removed } = {
        logs,
        appends,
        removed,
        load: () => new Map([...logs].map(([workspaceId, runs]) => [workspaceId, clone(runs)])),
        append: (workspaceId, run) => {
            appends.push({ workspaceId, run: clone(run) });
            const runs = logs.get(workspaceId) ?? [];
            const at = runs.findIndex((existing) => existing.id === run.id);
            if (at >= 0) runs[at] = clone(run);
            else runs.push(clone(run));
            logs.set(workspaceId, runs);
        },
        rewrite: (workspaceId, runs) => {
            logs.set(workspaceId, clone(runs));
        },
        remove: (workspaceId) => {
            removed.push(workspaceId);
            logs.delete(workspaceId);
        },
    };
    return history;
}
