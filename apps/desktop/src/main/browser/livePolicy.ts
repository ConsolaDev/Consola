/**
 * Which in-app browser pages stay alive. Pure: main gathers the facts and
 * applies the answer, so the rule itself is tested on its own.
 *
 * A page costs a renderer process, so a hidden one is let go after a while and
 * only so many may run at once. The tab and its address always stay; an
 * unloaded page reloads from that address when it is shown again.
 */

/** A hidden page is unloaded once it has been out of sight this long. */
export const HIDDEN_UNLOAD_MS = 15 * 60_000;

/** At most this many pages are live at once. */
export const MAX_LIVE_PAGES = 8;

/** A live page, and what decides whether it may stay. */
export interface LiveCandidate {
  id: string;
  /** When the person last saw it. */
  lastShownAt: number;
  /** The tab the person is looking at. */
  visible: boolean;
  /** An agent is in the middle of a call on it. */
  toolCallInFlight: boolean;
}

/**
 * The ids that stay live. A visible page and one with a tool call in flight
 * are never unloaded, not even for the cap, which is then exceeded rather
 * than breaking a page in use. Among the rest, a page hidden for
 * `HIDDEN_UNLOAD_MS` goes, then the least recently shown until the cap holds;
 * equal times go in input order, earlier first, so the answer is stable.
 */
export function decideLive(candidates: readonly LiveCandidate[], now: number): Set<string> {
  const keep = new Set<string>();
  const removable: Array<{ page: LiveCandidate; order: number }> = [];

  candidates.forEach((page, order) => {
    if (page.visible || page.toolCallInFlight) keep.add(page.id);
    else if (now - page.lastShownAt < HIDDEN_UNLOAD_MS) removable.push({ page, order });
  });

  // Newest first, so the ones past the room left are the least recently shown.
  removable.sort((a, b) => b.page.lastShownAt - a.page.lastShownAt || b.order - a.order);
  const room = Math.max(0, MAX_LIVE_PAGES - keep.size);
  for (const { page } of removable.slice(0, room)) keep.add(page.id);
  return keep;
}
