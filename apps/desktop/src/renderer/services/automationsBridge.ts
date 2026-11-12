import type { AuthoringRequest, AutomationsChange, AutomationsSnapshot, RunRecord } from '../../shared/automations';
import type { RunConversation } from '../../shared/conversation';
import type { Session } from '../../shared/workspace';

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

    /** One run's full record; null once history has dropped it. */
    getRun: async (runId: string): Promise<RunRecord | null> => (getAPI() ?? unavailable()).getRun(runId),

    /** A run's conversation from its transcript on disk: never starts or resumes a session. */
    readConversation: async (runId: string): Promise<RunConversation> =>
        (getAPI() ?? unavailable()).readConversation(runId),

    stop: async (runId: string): Promise<void> => (getAPI() ?? unavailable()).stop(runId),

    addTemplate: async (workspaceId: string, templateId: string): Promise<void> =>
        (getAPI() ?? unavailable()).addTemplate(workspaceId, templateId),

    /** Start the full-tools session that drafts an automation with the person. */
    startAuthoring: async (request: AuthoringRequest): Promise<Session> =>
        (getAPI() ?? unavailable()).startAuthoring(request),

    acknowledge: async (workspaceId: string, name: string): Promise<void> =>
        (getAPI() ?? unavailable()).acknowledge(workspaceId, name),

    onChanged: (callback: (change: AutomationsChange) => void): (() => void) =>
        getAPI()?.onChanged(callback) ?? (() => {}),
};
