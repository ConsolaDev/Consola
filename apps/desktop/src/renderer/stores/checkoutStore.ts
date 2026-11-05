import { useEffect } from 'react';
import { create } from 'zustand';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import { gitBridge } from '../services/gitBridge';

/** Focus can fire in bursts (dialogs, devtools); one re-read covers them all. */
const FOCUS_REFRESH_DEBOUNCE_MS = 2000;

interface CheckoutState {
  /** What each folder was last read as, keyed by the folder a session runs in. */
  byPath: Record<string, CheckoutInfo>;
  /** Read `path` again, whether or not it was read before. */
  load: (path: string) => Promise<void>;
  /** Read `path` only if nothing is known about it yet. */
  ensure: (path: string) => void;
}

const inFlight = new Map<string, Promise<void>>();

function sameCheckout(a: CheckoutInfo | undefined, b: CheckoutInfo): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'none' || b.kind === 'none') return true;
  return a.root === b.root && a.mainCheckout === b.mainCheckout && a.branch === b.branch && a.head === b.head;
}

/**
 * Which checkout every session's folder is, shared by the header and the
 * sidebar so the two can never name different branches for one session.
 *
 * Kept per folder rather than per session: every session in a repository's
 * own checkout shares one entry, so a sidebar of them costs one git call.
 */
export const useCheckoutStore = create<CheckoutState>((set, get) => ({
  byPath: {},

  load: (path) => {
    installFocusRefresh();
    const pending = inFlight.get(path);
    if (pending) return pending;
    const request = gitBridge
      .getCheckout(path)
      .then((info) => {
        if (!info || sameCheckout(get().byPath[path], info)) return;
        set((state) => ({ byPath: { ...state.byPath, [path]: info } }));
      })
      .catch(() => {
        // Keep what was last known; the next focus reads it again.
      })
      .finally(() => inFlight.delete(path));
    inFlight.set(path, request);
    return request;
  },

  ensure: (path) => {
    if (!(path in get().byPath)) void get().load(path);
  },
}));

let focusRefreshInstalled = false;

/**
 * Re-read every known folder when the window regains focus — the moment a
 * branch switched in another app could have made the sidebar stale. Installed
 * on first use so the store needs no component to remember to mount it.
 */
function installFocusRefresh(): void {
  if (focusRefreshInstalled || typeof window === 'undefined') return;
  focusRefreshInstalled = true;
  let last = 0;
  window.addEventListener('focus', () => {
    const now = Date.now();
    if (now - last < FOCUS_REFRESH_DEBOUNCE_MS) return;
    last = now;
    const { byPath, load } = useCheckoutStore.getState();
    for (const path of Object.keys(byPath)) void load(path);
  });
}

/**
 * The checkout `path` is, or undefined until it has been read.
 *
 * `fresh` re-reads on every change of path rather than trusting the cache —
 * for the header, where the session on screen is the one whose branch the
 * agent may just have switched.
 */
export function useCheckout(
  path: string | null | undefined,
  { fresh = false }: { fresh?: boolean } = {}
): CheckoutInfo | undefined {
  const info = useCheckoutStore((state) => (path ? state.byPath[path] : undefined));
  useEffect(() => {
    if (!path) return;
    const { load, ensure } = useCheckoutStore.getState();
    if (fresh) void load(path);
    else ensure(path);
  }, [path, fresh]);
  return info;
}
