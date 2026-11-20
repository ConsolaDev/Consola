import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Two walls the main process keeps by convention, checked against its
 * source so a later change (a merge of main, a new feature) cannot slip
 * past either unseen:
 *
 * - Every IPC handler registers through `guardedIpc`, which refuses anything
 *   but a Consola window's main frame (a page's popup is a `BrowserWindow`
 *   too). So no file but `guardedIpc.ts` takes Electron's own `ipcMain`.
 * - Every broadcast goes to `consolaWindows()`, never to
 *   `BrowserWindow.getAllWindows()`, which lists a page's popups as well:
 *   app data sent there would reach untrusted content. Only
 *   `window-manager.ts`, which filters it to the app's own, may call it.
 */

const MAIN = join(__dirname);

/** Every source file of the main process, tests left out (they may stand in for Electron). */
function sources(directory: string = MAIN): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sources(path);
    return /\.ts$/.test(entry.name) && !/\.test(-helpers|-support)?\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

const named = (path: string) => relative(MAIN, path).split(sep).join('/');

/** Code with its comments taken out, so a comment that names a thing is not a use of it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Takes `ipcMain` from Electron: imported by name, or read off the module. */
const TAKES_IPC_MAIN = [
  /import\s*\{[^}]*\bipcMain\b[^}]*\}\s*from\s*['"]electron['"]/,
  /require\(\s*['"]electron['"]\s*\)\s*\.\s*ipcMain\b/,
  /\belectron\s*\.\s*ipcMain\b/,
];

describe('the main process source', () => {
  it('is read whole: the check sees the files it guards', () => {
    const files = sources().map(named);
    expect(files).toContain('guardedIpc.ts');
    expect(files).toContain('window-manager.ts');
    expect(files).toContain('ipc-handlers.ts');
    expect(files).toContain('browser/browserIpc.ts');
  });

  it('takes Electron’s ipcMain only in guardedIpc.ts', () => {
    const takers = sources()
      .filter((path) => TAKES_IPC_MAIN.some((pattern) => pattern.test(code(path))))
      .map(named);
    expect(takers).toEqual(['guardedIpc.ts']);
  });

  it('lists every BrowserWindow, popups included, only in window-manager.ts', () => {
    const listers = sources()
      .filter((path) => /\bgetAllWindows\s*\(/.test(code(path)))
      .map(named);
    expect(listers).toEqual(['window-manager.ts']);
  });

  it('catches the shapes it looks for', () => {
    expect(TAKES_IPC_MAIN.some((p) => p.test("import { app, ipcMain } from 'electron';"))).toBe(
      true,
    );
    expect(TAKES_IPC_MAIN.some((p) => p.test("const x = require('electron').ipcMain;"))).toBe(true);
    expect(TAKES_IPC_MAIN.some((p) => p.test("import { guardedIpc as ipcMain } from './x';"))).toBe(
      false,
    );
  });
});
