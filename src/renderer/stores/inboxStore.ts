import { create } from 'zustand';
import type { InboxItem, InboxSnapshot, WorkItemLaunchAction } from '../../shared/workItems';
import { workItemActionKey, workItemKey } from '../../shared/workItems';
import { inboxBridge } from '../services/inboxBridge';
import { providerBridge } from '../services/providerBridge';
import { activateSession } from '../utils/sessionActions';
import { useTerminalStore } from './terminalStore';

/** Key for per-item state: one workspace's view of one work item. */
export function itemKey(workspaceId: string, item: InboxItem): string {
  return `${workspaceId}:${workItemKey(item.workItem)}`;
}

/**
 * Key for one action against one item — the same key main's coalescer uses,
 * so what the UI shows as in flight is exactly what main would collapse.
 */
export function launchKey(
  workspaceId: string,
  item: InboxItem,
  action: WorkItemLaunchAction
): string {
  return `${itemKey(workspaceId, item)}:${workItemActionKey(action)}`;
}

interface InboxState {
  /** Per-workspace snapshots, fed by main's inbox:changed pushes. */
  snapshots: Record<string, InboxSnapshot>;
  /** Per-workspace map of remote repo -> local clone path (null = not cloned). */
  resolvedRepos: Record<string, Record<string, string | null>>;
  /**
   * Failures surfaced in the pane — never a dialog. Keyed by launchKey for a
   * launch (one action's error sits under its own button) and by itemKey for
   * a clone (the item's only error at that point).
   */
  launchErrors: Record<string, string>;
  /** Same keying as launchErrors: which button, or which item, is busy. */
  launching: Record<string, boolean>;
  /** The item whose repo needs cloning; renders the clone dialog when set. */
  clonePrompt: { workspaceId: string; item: InboxItem } | null;
  load: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  adoptSnapshot: (snapshot: InboxSnapshot) => void;
  launch: (workspaceId: string, item: InboxItem, action: WorkItemLaunchAction) => Promise<void>;
  cloneRepo: (workspaceId: string, item: InboxItem, destinationDir: string) => Promise<void>;
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
      const snapshot = await inboxBridge.getInbox(workspaceId);
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
      await inboxBridge.refreshInbox(workspaceId);
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
    // Repo resolution rides along so the pane is honest about "Clone into
    // scope...". Fire-and-forget: until it lands, items assume "cloned" and
    // the launch path corrects them.
    const repos = [...new Set(snapshot.items.map((item) => item.workItem.repo))];
    if (repos.length === 0) return;
    void providerBridge.resolveRepos(snapshot.workspaceId, repos).then((resolved) => {
      set((state) => ({
        resolvedRepos: { ...state.resolvedRepos, [snapshot.workspaceId]: resolved },
      }));
    });
  },

  launch: async (workspaceId, item, action) => {
    const key = launchKey(workspaceId, item, action);
    set((state) => {
      const { [key]: _cleared, ...launchErrors } = state.launchErrors;
      return { launching: { ...state.launching, [key]: true }, launchErrors };
    });
    try {
      const result = await providerBridge.launchWorkItem(workspaceId, item.workItem, action);
      if (!result) {
        // Only reachable when window.providerAPI itself is missing (a broken
        // preload) — the bridge already null-guarded, so this is main being
        // unreachable rather than a provider-side failure.
        set((state) => ({
          launchErrors: {
            ...state.launchErrors,
            [key]: 'Could not reach the main process to launch this item.',
          },
        }));
        return;
      }
      if (result.ok) {
        // Always a fresh session, so the prompt is always seeded. It rides
        // the existing pending-prompt path: the terminal pane consumes it on
        // mount and sends it as initialPrompt, where the main-side guarded
        // queue delivers it — never into a menu.
        useTerminalStore.getState().setPendingPrompt(result.session.instanceId, result.seedPrompt);
        activateSession(workspaceId, result.session.id);
      } else if (result.reason === 'not-cloned') {
        get().openClonePrompt(workspaceId, item);
      } else {
        set((state) => ({ launchErrors: { ...state.launchErrors, [key]: result.message } }));
      }
    } catch (error) {
      // "Degrade, never dialog" applies to a thrown/rejected launch too —
      // an unhandled rejection would otherwise leave the button silent
      // instead of surfacing the error under it.
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ launchErrors: { ...state.launchErrors, [key]: message } }));
    } finally {
      set((state) => {
        const { [key]: _done, ...launching } = state.launching;
        return { launching };
      });
    }
  },

  cloneRepo: async (workspaceId, item, destinationDir) => {
    const key = itemKey(workspaceId, item);
    // Same shape as launch(): guard set before the first await, errors land
    // on the item (never a dialog), guard cleared on every path. The clone
    // does not continue into a launch: which action to start is the user's
    // choice, and the pane offers them all once the repo resolves.
    set((state) => {
      const { [key]: _cleared, ...launchErrors } = state.launchErrors;
      return { clonePrompt: null, launching: { ...state.launching, [key]: true }, launchErrors };
    });
    try {
      const result = await providerBridge.cloneRepo(workspaceId, item.workItem.repo, destinationDir);
      if (!result || !result.ok) {
        set((state) => ({
          launchErrors: { ...state.launchErrors, [key]: result?.error ?? 'Clone failed.' },
        }));
        return;
      }
      if (result.path) {
        // Record the resolved path immediately so the pane stops offering
        // "Clone into scope..." for a repo that now has one, without waiting
        // for the next snapshot's resolveRepos round trip.
        const path = result.path;
        set((state) => ({
          resolvedRepos: {
            ...state.resolvedRepos,
            [workspaceId]: { ...state.resolvedRepos[workspaceId], [item.workItem.repo]: path },
          },
        }));
      }
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

  subscribeToEvents: () => inboxBridge.onInboxChanged((snapshot) => get().adoptSnapshot(snapshot)),
}));
