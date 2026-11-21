/**
 * The browser menu's pure rules: zoom steps, the find bar's count, and which
 * visited pages the address bar suggests. No IO, no DOM, no Electron, so main,
 * the renderer and tests all read it.
 */

import type { BrowserHistoryEntry } from './browser';

// --- Zoom ---

export type ZoomStep = 'in' | 'out' | 'reset';

/** Half a level is about 10%: fine enough to land on a size, coarse enough to notice. */
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -4;
const ZOOM_MAX = 4;

/** The level a step leads to, from Electron's zoom level (0 is 100%). */
export function stepZoom(level: number, step: ZoomStep): number {
  if (step === 'reset') return 0;
  const from = Number.isFinite(level) ? level : 0;
  const next = from + (step === 'in' ? ZOOM_STEP : -ZOOM_STEP);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
}

/** What a level means to the person: Chromium scales by 1.2 to the power of it. */
export function zoomPercent(level: number): number {
  return Math.round(1.2 ** level * 100);
}

// --- Find on page ---

/** What `found-in-page` last said for the current search. */
export interface FindResult {
  /** The match shown, counting from 1; 0 when there is none. */
  active: number;
  total: number;
}

/** The find bar's "n of m". Nothing until the page has answered. */
export function findResultText(query: string, result: FindResult | null): string {
  if (!query || !result) return '';
  return result.total === 0 ? 'No matches' : `${result.active} of ${result.total}`;
}

// --- Address suggestions ---

export const MAX_SUGGESTIONS = 8;

/**
 * Visited pages whose address or title contains what was typed, newest first.
 * `exclude` is the address already showing, which suggesting back would only
 * repeat.
 */
export function suggestFromHistory(
  history: readonly BrowserHistoryEntry[],
  query: string,
  options: { exclude?: string } = {},
): BrowserHistoryEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return history
    .filter(
      (entry) =>
        entry.url !== options.exclude &&
        (entry.url.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle)),
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SUGGESTIONS);
}
