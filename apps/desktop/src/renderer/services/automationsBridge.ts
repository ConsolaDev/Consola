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
 * this bridge reads a workspace's snapshot and sends intents. "Open file"
 * hands the file to the person's editor, which is where the spec lives; the
 * only edit Consola makes is appending automatic reviews when asked.
 */
export const automationsBridge = {
    getSnapshot: async (workspaceId: string): Promise<AutomationsSnapshot | null> =>
        getAPI()?.getSnapshot(workspaceId) ?? null,

    /** Run now — or, for an event automation, check now (null: only what is new fires). */
    runNow: async (workspaceId: string, name: string): Promise<RunRecord | null> =>
        (getAPI() ?? unavailable()).runNow(workspaceId, name),

    approve: async (runId: string): Promise<RunRecord> => (getAPI() ?? unavailable()).approve(runId),

    dismiss: async (runId: string): Promise<RunRecord> => (getAPI() ?? unavailable()).dismiss(runId),

    openFile: async (workspaceId: string): Promise<void> => (getAPI() ?? unavailable()).openFile(workspaceId),

    /** Add review-assigned-prs to the workspace's factory.yml — the one edit Consola makes to it, on request. */
    addAssignedReviews: async (workspaceId: string): Promise<void> =>
        (getAPI() ?? unavailable()).addAssignedReviews(workspaceId),

    onChanged: (callback: (change: AutomationsChange) => void): (() => void) =>
        getAPI()?.onChanged(callback) ?? (() => {}),
};
