import type { GitProviderId, ProviderProbeResult } from '../../shared/providers';
import type { CloneRepoResult, WorkItemLaunchResult } from '../../shared/types';
import type { WorkItemLaunchAction, WorkItemRef } from '../../shared/workItems';

function getAPI() {
    if (typeof window !== 'undefined' && window.providerAPI) {
        return window.providerAPI;
    }
    return null;
}

/**
 * Bridge to provider operations in the main process.
 *
 * Consola stores no provider credentials: the provider's CLI owns the
 * keyring, and this bridge only ever learns which accounts exist — never
 * their tokens. Launch and clone are intents; main does the work.
 */
export const providerBridge = {
    /** Whether the provider's CLI is installed, its version, and the keyring accounts. */
    probe: async (id: GitProviderId): Promise<ProviderProbeResult> => {
        const api = getAPI();
        if (!api) return { available: false, accounts: [] };
        return api.probe(id);
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

    /** Start a session from an action: validate -> render -> worktree -> record. */
    launchWorkItem: async (
        workspaceId: string,
        ref: WorkItemRef,
        action: WorkItemLaunchAction
    ): Promise<WorkItemLaunchResult | null> => {
        const api = getAPI();
        if (!api) return null;
        return api.launchWorkItem(workspaceId, ref, action);
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
};
