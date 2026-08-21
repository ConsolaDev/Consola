import type { GhProbeResult, InboxSnapshot, WorkItemRef } from '../../shared/github';
import type { CloneRepoResult, WorkItemLaunchResult } from '../../shared/types';

function getAPI() {
    if (typeof window !== 'undefined' && window.githubAPI) {
        return window.githubAPI;
    }
    return null;
}

/**
 * Bridge to GitHub probing and the Inbox in the main process.
 *
 * Consola stores no GitHub credentials: the `gh` CLI owns the keyring, and
 * this bridge only ever learns which accounts exist — never their tokens.
 * Read-only against GitHub by construction: nothing here writes to GitHub.
 * Main owns the Inbox cache; this bridge sends intents and listens for pushes.
 */
export const githubBridge = {
    /** Whether `gh` is installed, its version, and the keyring accounts. */
    probe: async (): Promise<GhProbeResult> => {
        const api = getAPI();
        if (!api) return { available: false, accounts: [] };
        return api.probe();
    },

    /** Cached snapshot, or null. A null result also kicks a background refresh. */
    getInbox: async (workspaceId: string): Promise<InboxSnapshot | null> => {
        const api = getAPI();
        if (!api) return null;
        return api.getInbox(workspaceId);
    },

    /** Manual refresh; the result arrives on `onInboxChanged`. */
    refreshInbox: async (workspaceId: string): Promise<void> => {
        const api = getAPI();
        if (!api) return;
        await api.refreshInbox(workspaceId);
    },

    /** Which of these remote repos have a local clone in this workspace. */
    resolveRepos: async (
        workspaceId: string,
        repos: string[]
    ): Promise<Record<string, string | null>> => {
        const api = getAPI();
        if (!api) return {};
        return api.resolveRepos(workspaceId, repos);
    },

    /** One click on an Inbox item: resolve -> worktree -> session record. */
    launchWorkItem: async (
        workspaceId: string,
        workItem: WorkItemRef
    ): Promise<WorkItemLaunchResult | null> => {
        const api = getAPI();
        if (!api) return null;
        return api.launchWorkItem(workspaceId, workItem);
    },

    /** Clone an un-cloned inbox repo into a chosen directory. */
    cloneRepo: async (
        workspaceId: string,
        repo: string,
        destinationDir: string
    ): Promise<CloneRepoResult | null> => {
        const api = getAPI();
        if (!api) return null;
        return api.cloneRepo(workspaceId, repo, destinationDir);
    },

    onInboxChanged: (callback: (snapshot: InboxSnapshot) => void): (() => void) => {
        const api = getAPI();
        if (!api) return () => {};
        return api.onInboxChanged(callback);
    },
};
