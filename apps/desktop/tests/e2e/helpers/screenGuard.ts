import type { ElectronApplication } from '@playwright/test';

/**
 * What keeps an end-to-end run's dialogs and downloads off the person's
 * screen. The windows are hidden, but a native message box or a save dialog
 * Electron opens for a hidden window still lands on the person's screen.
 */

/** What the screen guard saw in main: what it kept off the screen. */
export interface ScreenRecord {
  /** Dialogs handed to Electron's own listener, which would have been native boxes. */
  boxes: Array<{ contents: number; type: unknown; message: unknown }>;
  /** Downloads of the browser partitions, and whether the app had cancelled each. */
  downloads: Array<{ url: string; cancelledByApp: boolean }>;
}

interface GuardGlobals {
  __screenGuard?: ScreenRecord & {
    /** Web contents whose Electron dialog listener was swapped for the recorder. */
    dialogsGuarded: number[];
    /** Pages whose partition has the download canceller. */
    downloadsGuarded: number[];
  };
}

export interface ScreenGuard {
  record(): Promise<ScreenRecord>;
  /** Dialogs the test's own Playwright saw on the app's pages. It never answers them. */
  testSideDialogs: string[];
}

/**
 * Keeps whatever the app does off the person's screen, from before any page
 * exists:
 * - each web contents' Electron `-run-dialog` listener (the one that shows a
 *   native box) is swapped for a recorder as it is created; the app then
 *   takes the recorder over (`PageDialogs.takeOver`), so a dialog it hands
 *   "to Electron" is recorded and dismissed, never shown;
 * - a `will-download` listener after the app's records what the app decided
 *   and cancels the download whatever that was, so no save dialog opens;
 * - every page of the test's own Playwright gets a `dialog` listener that
 *   only records: with none, Playwright would dismiss each dialog at once,
 *   and nothing the app holds could be seen held.
 */
export async function keepOffScreen(app: ElectronApplication): Promise<ScreenGuard> {
  await app.evaluate(({ app: electronApp }) => {
    const main = globalThis as unknown as GuardGlobals;
    if (main.__screenGuard) return;
    const guard: NonNullable<GuardGlobals['__screenGuard']> = {
      boxes: [],
      downloads: [],
      dialogsGuarded: [],
      downloadsGuarded: [],
    };
    main.__screenGuard = guard;
    const guardedPartitions = new WeakSet<Electron.Session>();
    electronApp.on('web-contents-created', (_event, contents) => {
      const events = contents as unknown as NodeJS.EventEmitter;
      for (const listener of events.listeners('-run-dialog')) {
        events.removeListener('-run-dialog', listener as (...args: unknown[]) => void);
      }
      events.on(
        '-run-dialog',
        (
          details: { dialogType?: unknown; messageText?: unknown } | undefined,
          callback: (success: boolean, input: string) => void,
        ) => {
          guard.boxes.push({
            contents: contents.id,
            type: details?.dialogType,
            message: details?.messageText,
          });
          // Nobody sees it to answer it: dismissed, so the page does not wait on it.
          callback(false, '');
        },
      );
      guard.dialogsGuarded.push(contents.id);
      if (contents.getType() !== 'webview') return;
      const partition = contents.session;
      if (!guardedPartitions.has(partition)) {
        guardedPartitions.add(partition);
        partition.on('will-download', (event, item) => {
          guard.downloads.push({
            url: item.getURL(),
            cancelledByApp: (event as unknown as { defaultPrevented: boolean }).defaultPrevented,
          });
          event.preventDefault();
        });
      }
      guard.downloadsGuarded.push(contents.id);
    });
  });

  const testSideDialogs: string[] = [];
  const hear = (dialog: { type(): string; message(): string }) => {
    testSideDialogs.push(`${dialog.type()}: ${dialog.message()}`);
  };
  const context = app.context();
  context.on('dialog', hear);
  context.on('page', (page) => page.on('dialog', hear));
  for (const page of context.pages()) page.on('dialog', hear);

  return {
    record: () =>
      app.evaluate(() => {
        const guard = (globalThis as unknown as GuardGlobals).__screenGuard;
        return { boxes: guard?.boxes ?? [], downloads: guard?.downloads ?? [] };
      }),
    testSideDialogs,
  };
}

/**
 * Whether the page at `urlPrefix` is kept from showing a dialog box and a
 * save dialog: its Electron dialog listener was swapped as it was created,
 * one listener answers its dialogs (the app's, over the recorder), and its
 * partition has the download canceller. Checked before a test raises either.
 */
export function guestGuarded(app: ElectronApplication, urlPrefix: string): Promise<boolean> {
  return app.evaluate(({ webContents }, prefix) => {
    const guard = (globalThis as unknown as GuardGlobals).__screenGuard;
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview' && contents.getURL().startsWith(prefix));
    if (!guard || !guest) return false;
    const events = guest as unknown as NodeJS.EventEmitter;
    return (
      guard.dialogsGuarded.includes(guest.id) &&
      events.listenerCount('-run-dialog') === 1 &&
      guard.downloadsGuarded.includes(guest.id)
    );
  }, urlPrefix);
}
