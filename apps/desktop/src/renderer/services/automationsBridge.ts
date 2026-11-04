import type { AutomationsChange, AutomationsSnapshot, RunRecord } from '../../shared/automations';

function getAPI() {
    if (typeof window !== 'undefined' && window.automationsAPI) {
        return window.automationsAPI;
    }
    return null;
}

function unavailable(): never {
    throw new Error('Automations are not available in this window.');
}

/**
 * Bridge to the automation runner in the main process.
 *
 * Each workspace has its own factory.yml. Main parses, schedules and runs;
 * this bridge reads a workspace's snapshot and sends intents. Nothing here
 * edits the file — "Open file" hands it to the person's editor, which is
 * where the spec lives.
 */
export const automationsBridge = {
    getSnapshot: async (workspaceId: string): Promise<AutomationsSnapshot | null> =>
        getAPI()?.getSnapshot(workspaceId) ?? null,

    runNow: async (workspaceId: string, name: string): Promise<RunRecord> =>
        (getAPI() ?? unavailable()).runNow(workspaceId, name),

    approve: async (runId: string): Promise<RunRecord> => (getAPI() ?? unavailable()).approve(runId),

    dismiss: async (runId: string): Promise<RunRecord> => (getAPI() ?? unavailable()).dismiss(runId),

    openFile: async (workspaceId: string): Promise<void> => (getAPI() ?? unavailable()).openFile(workspaceId),

    onChanged: (callback: (change: AutomationsChange) => void): (() => void) =>
        getAPI()?.onChanged(callback) ?? (() => {}),
};
