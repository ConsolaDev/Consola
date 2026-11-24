import { ipcMain } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { isTrustedSender } from './ipcSenderGuard';
import { isConsolaContents } from './windowRegistry';

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  // The registry, not `BrowserWindow.fromWebContents`: a page's popup is a
  // window to Electron, and its main frame would pass every other check.
  return isTrustedSender(event, isConsolaContents(event.sender.id));
}

/**
 * `ipcMain`, with every handler refused to anything but a Consola window's
 * main frame. Register through this rather than `ipcMain` itself, so a handler
 * added later cannot forget the check. A refused `handle` throws, which makes
 * the caller's `invoke` reject; a refused `on` is dropped, since nobody waits
 * on it.
 */
// Handlers declare their own argument types, as they do on `ipcMain`, so the
// rest parameters cannot be narrower than `any`.
export const guardedIpc = {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error(`Refused ${channel}: caller is not a Consola window`);
      return listener(event, ...args);
    });
  },
  // biome-ignore lint/suspicious/noExplicitAny: see above
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
    ipcMain.on(channel, (event, ...args) => {
      if (!trusted(event)) return;
      listener(event, ...args);
    });
  },
  removeHandler: (channel: string) => ipcMain.removeHandler(channel),
  removeAllListeners: (channel?: string) => ipcMain.removeAllListeners(channel),
};
