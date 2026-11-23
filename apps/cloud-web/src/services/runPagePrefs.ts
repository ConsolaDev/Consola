/*
 * How the person left a run's page: whether its info panel shows, and which of its sections are
 * folded. Kept in this browser (`localStorage`), as the desktop keeps them, and read once per
 * page. A browser that keeps nothing (a private window, storage refused) shows the panel open,
 * every section unfolded.
 */

const KEY = 'consola-cloud:run-page';

export type RunPagePrefs = {
  /** Whether the info panel shows beside the run. */
  infoPanel: boolean;
  /** The info panel's sections folded, by id. */
  folded: string[];
};

const DEFAULTS: RunPagePrefs = { infoPanel: true, folded: [] };

export function readRunPagePrefs(): RunPagePrefs {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return DEFAULTS;
    const { infoPanel, folded } = stored as Record<string, unknown>;
    return {
      infoPanel: typeof infoPanel === 'boolean' ? infoPanel : DEFAULTS.infoPanel,
      folded: Array.isArray(folded)
        ? folded.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    return DEFAULTS;
  }
}

export function writeRunPagePrefs(prefs: RunPagePrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Kept for this page only: the browser keeps nothing.
  }
}
