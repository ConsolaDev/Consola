import { DEFAULT_PREFERENCES, type Preferences } from '../../shared/preferences';
import type { WorktreeCleanupRules } from '../../shared/worktreeCleanup';

/**
 * Preferences Bridge - Isolates all window.preferencesAPI access to this single file.
 */

function getAPI() {
  if (typeof window !== 'undefined' && window.preferencesAPI) {
    return window.preferencesAPI;
  }
  return null;
}

export const preferencesBridge = {
  get: async (): Promise<Preferences> => (await getAPI()?.get()) ?? DEFAULT_PREFERENCES,

  /** Days idle before a session settles itself; 0 turns it off. */
  setAutoSettleDays: async (days: number): Promise<void> => {
    await getAPI()?.setAutoSettleDays(days);
  },

  /** The global worktree cleanup rules. */
  setWorktreeCleanup: async (rules: WorktreeCleanupRules): Promise<void> => {
    await getAPI()?.setWorktreeCleanup(rules);
  },

  /** The person has read the one-time explanation, in whichever window. */
  acknowledgeAutoSettle: async (): Promise<void> => {
    await getAPI()?.acknowledgeAutoSettle();
  },

  /** Hear a change from any window. Returns the unsubscribe. */
  onChanged: (callback: (preferences: Preferences) => void): (() => void) =>
    getAPI()?.onChanged(callback) ?? (() => {}),
};
