import { create } from 'zustand';
import type { SessionUsageLimit, UsageLimitsState } from '../../shared/usageLimits';
import { usageLimitsBridge } from '../services/usageLimitsBridge';

/**
 * Which sessions stopped on a usage limit, as main learned it from each
 * harness's own CLI. Mirrored, never computed: every window shows main's one
 * answer, pushed whole on each change.
 */
export const useUsageLimitsStore = create<UsageLimitsState>(() => ({
  sessions: {},
  harnesses: {},
}));

/** One session's limit, if it has one. Selects a single value, so a row re-renders only for its own. */
export function useSessionUsageLimit(sessionId: string | undefined): SessionUsageLimit | undefined {
  return useUsageLimitsStore((state) => (sessionId ? state.sessions[sessionId] : undefined));
}

export async function hydrateUsageLimits(): Promise<void> {
  useUsageLimitsStore.setState(await usageLimitsBridge.getSnapshot());
}

/** Apply main's pushes. Returns the unsubscribe. */
export function subscribeToUsageLimits(): () => void {
  return usageLimitsBridge.onChanged((state) => useUsageLimitsStore.setState(state, true));
}
