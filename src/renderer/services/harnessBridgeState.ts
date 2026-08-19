import type { Harness, HarnessUpdates, NewHarnessFields } from '../../shared/harness';

/**
 * Bridge to the harness records owned by the main process.
 *
 * Separate from `harnessBridge`, which probes health: a probe result is a live
 * fact about the machine and is deliberately never persisted, so it has no
 * business travelling with the records.
 */
export const harnessBridgeState = {
    getSnapshot(): Promise<{ harnesses: Harness[]; needsImport: boolean }> {
        return window.harnessStateAPI.getSnapshot();
    },
    importState(harnesses: Harness[]): Promise<boolean> {
        return window.harnessStateAPI.importState(harnesses);
    },
    addHarness(input: NewHarnessFields): Promise<Harness> {
        return window.harnessStateAPI.addHarness(input);
    },
    updateHarness(id: string, updates: HarnessUpdates): Promise<void> {
        return window.harnessStateAPI.updateHarness(id, updates);
    },
    archiveHarness(id: string): Promise<void> {
        return window.harnessStateAPI.archiveHarness(id);
    },
    restoreHarness(id: string): Promise<void> {
        return window.harnessStateAPI.restoreHarness(id);
    },
    onChanged(callback: (harnesses: Harness[]) => void): () => void {
        return window.harnessStateAPI.onChanged(callback);
    },
};
