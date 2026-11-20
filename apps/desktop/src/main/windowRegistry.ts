import type { BrowserWindow } from 'electron';
import { isolated } from './browser/isolated';

/**
 * Which web contents are the app's own windows.
 *
 * Electron windows are not all Consola's: a page's popup is a `BrowserWindow`
 * too, holding untrusted content. "Is this a window" must therefore mean "did
 * `createWindow` make it", never "does Electron know it". This list is what the
 * IPC sender guard and every broadcast to windows consult.
 *
 * Kept by web contents id, read once as the window is created: a destroyed
 * contents throws on `.id`.
 */
const consolaContentsIds = new Set<number>();

export function registerConsolaContents(id: number): void {
  consolaContentsIds.add(id);
}

export function forgetConsolaContents(id: number): void {
  consolaContentsIds.delete(id);
}

export function isConsolaContents(id: number): boolean {
  return consolaContentsIds.has(id);
}

const closedListeners = new Set<(window: BrowserWindow) => void>();

/**
 * Calls `listener` as each Consola window closes, whatever it showed: one
 * that never bound a page still left what it reported behind (which tab it
 * was showing, the pages it was to mount). Returns the unsubscribe.
 */
export function onConsolaWindowClosed(listener: (window: BrowserWindow) => void): () => void {
  closedListeners.add(listener);
  return () => closedListeners.delete(listener);
}

/** A Consola window closed (`createWindow`'s `closed`): each listener hears, on its own. */
export function consolaWindowClosed(window: BrowserWindow): void {
  for (const listener of closedListeners) {
    isolated('A listener of a window closing', () => listener(window));
  }
}
