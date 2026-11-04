import type { AutomationsSnapshot, RunRecord } from '../../shared/automations';

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
 * Main parses factory.yml, schedules and runs; this bridge reads snapshots
 * and sends intents. Nothing here edits the file — "Open file" hands it to
 * the person's editor, which is where the spec lives.
 */
export const automationsBridge = {
    getSnapshot: async (): Promise<AutomationsSnapshot | null> => getAPI()?.getSnapshot() ?? null,

    runNow: async (name: string): Promise<RunRecord> => (getAPI() ?? unavailable()).runNow(name),

    approve: async (runId: string): Promise<RunRecord> => (getAPI() ?? unavailable()).approve(runId),

    dismiss: async (runId: string): Promise<RunRecord> => (getAPI() ?? unavailable()).dismiss(runId),

    openFile: async (): Promise<void> => (getAPI() ?? unavailable()).openFile(),

    onChanged: (callback: (snapshot: AutomationsSnapshot) => void): (() => void) =>
        getAPI()?.onChanged(callback) ?? (() => {}),
};
