/**
 * Who may call the app's IPC handlers.
 *
 * Only the main frame of a Consola window. Pages the browser panel loads live
 * in `<webview>` guests and may one day hold an `ipcRenderer` of their own;
 * the preload bridge already keeps them off the app, and this refuses them at
 * the receiving end as well, so neither layer has to be right alone.
 *
 * The event is described by the minimal shape this reads, so the decision can
 * be exercised without Electron.
 */
export interface IpcSenderEvent {
  sender: { getType(): string; mainFrame: unknown };
  senderFrame: unknown;
}

/**
 * `belongsToWindow` is whether main knows the sender as a `BrowserWindow`'s
 * own contents. It is a separate input because answering it needs Electron.
 */
export function isTrustedSender(event: IpcSenderEvent, belongsToWindow: boolean): boolean {
  if (!belongsToWindow) return false;
  if (event.sender.getType() !== 'window') return false;
  // A subframe, or a frame that has already gone (null), is not the window.
  return event.senderFrame != null && event.senderFrame === event.sender.mainFrame;
}
