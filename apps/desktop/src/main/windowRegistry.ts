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
