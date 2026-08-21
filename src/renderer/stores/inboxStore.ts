import { create } from 'zustand';
import type { InboxItem, InboxSnapshot } from '../../shared/github';
import { workItemKey } from '../../shared/github';
import { githubBridge } from '../services/githubBridge';
import { activateSession } from '../utils/sessionActions';
import { useTerminalStore } from './terminalStore';

/** Key for per-item launch state: one workspace's view of one work item. */
export function launchKey(workspaceId: string, item: InboxItem): string {
  return `${workspaceId}:${workItemKey(item.workItem)}`;
}

interface InboxState {
  /** Per-workspace snapshots, fed by main's github:inbox-changed pushes. */
  snapshots: Record<string, InboxSnapshot>;
  /** Per-workspace map of remote repo -> local clone path (null = not cloned). */
  resolvedRepos: Record<string, Record<string, string | null>>;
  /** Launch failures surfaced on their Inbox item — never a dialog. */
  launchErrors: Record<string, string>;
  launching: Record<string, boolean>;
  /** The item whose repo needs cloning; renders the clone dialog when set. */
  clonePrompt: { workspaceId: string; item: InboxItem } | null;
  load: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  adoptSnapshot: (snapshot: InboxSnapshot) => void;
  launch: (workspaceId: string, item: InboxItem) => Promise<void>;
  cloneAndLaunch: (workspaceId: string, item: InboxItem, destinationDir: string) => Promise<void>;
  openClonePrompt: (workspaceId: string, item: InboxItem) => void;
  dismissClonePrompt: () => void;
  /** Subscribe to main's pushes. Call once near the app root. */
  subscribeToEvents: () => () => void;
}

export const useInboxStore = create<InboxState>((set, get) => ({
  snapshots: {},
  resolvedRepos: {},
  launchErrors: {},
  launching: {},
  clonePrompt: null,

  load: async (workspaceId) => {
    try {
      const snapshot = await githubBridge.getInbox(workspaceId);
      // null means main has no cache yet; it has kicked off a refresh and the
      // result will arrive on the push channel.
      if (snapshot) get().adoptSnapshot(snapshot);
    } catch (error) {
      // Same "degrade, never dialog" reasoning as launch(): this is called
      // fire-and-forget (`void load(...)`) from the Sidebar, and there is no
      // per-item error key to write into — so log rather than let the
      // rejection escape as unhandled.
      console.error('inboxStore.load failed:', error);
    }
  },

  refresh: async (workspaceId) => {
    try {
      await githubBridge.refreshInbox(workspaceId);
    } catch (error) {
      // Same reasoning as load(): `void refresh(...)` from the refresh
      // button has no per-item error key either.
      console.error('inboxStore.refresh failed:', error);
    }
  },

  adoptSnapshot: (snapshot) => {
    set((state) => ({
      snapshots: { ...state.snapshots, [snapshot.workspaceId]: snapshot },
    }));
    // Repo resolution rides along so button labels are honest. Fire-and-forget:
    // until it lands, items assume "cloned" and the launch path corrects them.
    const repos = [...new Set(snapshot.items.map((item) => item.workItem.repo))];
    if (repos.length === 0) return;
    void githubBridge.resolveRepos(snapshot.workspaceId, repos).then((resolved) => {
      set((state) => ({
        resolvedRepos: { ...state.resolvedRepos, [snapshot.workspaceId]: resolved },
      }));
    });
  },

  launch: async (workspaceId, item) => {
    const key = launchKey(workspaceId, item);
    set((state) => {
      const { [key]: _cleared, ...launchErrors } = state.launchErrors;
      return { launching: { ...state.launching, [key]: true }, launchErrors };
    });
    try {
      const result = await githubBridge.launchWorkItem(workspaceId, item.workItem);
      if (!result) {
        // Only reachable when window.githubAPI itself is missing (a broken
        // preload) — the bridge already null-guarded, so this is main
        // being unreachable rather than a GitHub-side failure.
        set((state) => ({
          launchErrors: {
            ...state.launchErrors,
            [key]: 'Could not reach the main process to launch this item.',
          },
        }));
        return;
      }
      if (result.ok) {
        if (!result.reattached && result.seedPrompt) {
          // The prompt rides the existing pending-prompt path: the terminal
          // pane consumes it on mount and sends it as initialPrompt, where the
          // main-side guarded queue delivers it — never into a menu.
          useTerminalStore.getState().setPendingPrompt(result.session.instanceId, result.seedPrompt);
        }
        activateSession(workspaceId, result.session.id);
      } else if (result.reason === 'not-cloned') {
        get().openClonePrompt(workspaceId, item);
      } else {
        set((state) => ({ launchErrors: { ...state.launchErrors, [key]: result.message } }));
      }
    } catch (error) {
      // "Degrade, never dialog" applies to a thrown/rejected launch too —
      // an unhandled rejection would otherwise leave the item silent instead
      // of surfacing the error on its row.
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ launchErrors: { ...state.launchErrors, [key]: message } }));
    } finally {
      set((state) => {
        const { [key]: _done, ...launching } = state.launching;
        return { launching };
      });
    }
  },

  cloneAndLaunch: async (workspaceId, item, destinationDir) => {
    const key = launchKey(workspaceId, item);
    // Same shape as launch(): guard set before the first await, errors land
    // on the item (never a dialog), guard cleared on every path.
    set((state) => {
      const { [key]: _cleared, ...launchErrors } = state.launchErrors;
      return { clonePrompt: null, launching: { ...state.launching, [key]: true }, launchErrors };
    });
    try {
      const result = await githubBridge.cloneRepo(workspaceId, item.workItem.repo, destinationDir);
      if (!result || !result.ok) {
        set((state) => ({
          launchErrors: { ...state.launchErrors, [key]: result?.error ?? 'Clone failed.' },
        }));
        return;
      }
      if (result.path) {
        // Record the resolved path immediately: if the launch below fails
        // (e.g. `gh pr checkout` because the branch is already checked out
        // elsewhere), the item's button must read "Review" from the clone
        // that did succeed, not keep offering "Clone into scope..." for a
        // repo that already has one.
        const path = result.path;
        set((state) => ({
          resolvedRepos: {
            ...state.resolvedRepos,
            [workspaceId]: { ...state.resolvedRepos[workspaceId], [item.workItem.repo]: path },
          },
        }));
      }
      // The clone landed and (if needed) became a scope; the normal launch
      // path now resolves it and continues: worktree, record, spawn.
      await get().launch(workspaceId, item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ launchErrors: { ...state.launchErrors, [key]: message } }));
    } finally {
      set((state) => {
        const { [key]: _done, ...launching } = state.launching;
        return { launching };
      });
    }
  },

  openClonePrompt: (workspaceId, item) => set({ clonePrompt: { workspaceId, item } }),

  dismissClonePrompt: () => set({ clonePrompt: null }),

  subscribeToEvents: () =>
    githubBridge.onInboxChanged((snapshot) => get().adoptSnapshot(snapshot)),
}));
