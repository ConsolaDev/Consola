import type { UsageLimitsState } from '../../shared/usageLimits';

/**
 * Usage Limits Bridge - Isolates all window.usageLimitsAPI access to this single file.
 */

function getAPI() {
  if (typeof window !== 'undefined' && window.usageLimitsAPI) {
    return window.usageLimitsAPI;
  }
  return null;
}

const EMPTY: UsageLimitsState = { sessions: {}, harnesses: {} };

export const usageLimitsBridge = {
  /** Which sessions stopped on a usage limit, and which harnesses are limited for every model. */
  getSnapshot: async (): Promise<UsageLimitsState> => (await getAPI()?.getSnapshot()) ?? EMPTY,

  /** Hear the whole state after each change. Returns the unsubscribe. */
  onChanged: (callback: (state: UsageLimitsState) => void): (() => void) =>
    getAPI()?.onChanged(callback) ?? (() => {}),
};
