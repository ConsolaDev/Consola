import { type ElectronApplication, expect } from '@playwright/test';

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
    /** How many `-run-dialog` listeners each web contents had as it was created, by id. */
    dialogListenersFound: Record<number, number>;
    /** The recorder that took the place of Electron's listener, by web contents. */
    recorders: WeakMap<object, unknown>;
    /** Pages whose partition has the download canceller. */
    downloadsGuarded: number[];
  };
}

/** What the guard check says when Electron is not as the app's dialog takeover expects. */
const UNEXPECTED_ELECTRON = "Electron's page dialog event is not what the app expects";

export interface ScreenGuard {
  record(): Promise<ScreenRecord>;
  /**
   * Dialogs the test's own Playwright saw, as `page confirm: …` when the
   * page's own listener heard it and `context confirm: …` for the context's.
   * It never answers them.
   */
  testSideDialogs: string[];
}

/**
 * Keeps whatever the app does off the person's screen, from before any page
 * exists:
 * - each web contents' Electron `-run-dialog` listener (the one that shows a
 *   native box) is swapped for a recorder as it is created; the app then
 *   takes the recorder over (`PageDialogs.takeOver`), so a dialog it hands
 *   "to Electron" is recorded and dismissed, never shown. Only when Electron's
 *   is the one listener there, which is also what the app's takeover checks:
 *   any other count is an Electron the app was not written for, left exactly
 *   as it is (the takeover then sees what it would in production), and the
 *   page counts as unguarded, so no test raises a dialog on it
 *   (`expectOffScreen`);
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
      dialogListenersFound: {},
      recorders: new WeakMap(),
      downloadsGuarded: [],
    };
    main.__screenGuard = guard;
    const guardedPartitions = new WeakSet<Electron.Session>();
    electronApp.on('web-contents-created', (_event, contents) => {
      const events = contents as unknown as NodeJS.EventEmitter;
      const electrons = events.listeners('-run-dialog');
      guard.dialogListenersFound[contents.id] = electrons.length;
      if (electrons.length === 1) {
        events.removeListener('-run-dialog', electrons[0] as (...args: unknown[]) => void);
        const recorder = (
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
        };
        events.on('-run-dialog', recorder);
        guard.recorders.set(contents, recorder);
      }
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
  const hear = (where: 'page' | 'context') => (dialog: { type(): string; message(): string }) => {
    testSideDialogs.push(`${where} ${dialog.type()}: ${dialog.message()}`);
  };
  const context = app.context();
  context.on('dialog', hear('context'));
  context.on('page', (page) => page.on('dialog', hear('page')));
  for (const page of context.pages()) page.on('dialog', hear('page'));

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
 * Why the page at `urlPrefix` is not kept from showing a dialog box or a save
 * dialog, or null when it is: Electron's one dialog listener was swapped for
 * the recorder as the page was created, the app has since taken the recorder
 * over (one listener, and not the recorder itself), and its partition has the
 * download canceller.
 */
export function offScreenProblem(
  app: ElectronApplication,
  urlPrefix: string,
): Promise<string | null> {
  return app.evaluate(
    ({ webContents }, args) => {
      const guard = (globalThis as unknown as GuardGlobals).__screenGuard;
      if (!guard) return 'The screen guard was never installed.';
      const guest = webContents
        .getAllWebContents()
        .find(
          (contents) =>
            contents.getType() === 'webview' && contents.getURL().startsWith(args.prefix),
        );
      if (!guest) return `There is no page at ${args.prefix}.`;
      const found = guard.dialogListenersFound[guest.id];
      const recorder = guard.recorders.get(guest);
      if (found !== 1 || !recorder) {
        return `${args.unexpected}: the page had ${found ?? 'an unknown number of'} "-run-dialog" listeners as it was created, not Electron's one, so nothing was swapped and no dialog may be raised on it.`;
      }
      const now = (guest as unknown as NodeJS.EventEmitter).listeners('-run-dialog');
      if (now.length !== 1) {
        return `${args.unexpected}: the page has ${now.length} "-run-dialog" listeners now, not the app's one.`;
      }
      if (now[0] === recorder) {
        return 'The app did not take the page\'s dialogs over (PageDialogs.takeOver): its one "-run-dialog" listener is still the recorder.';
      }
      if (!guard.downloadsGuarded.includes(guest.id)) {
        return "The page's partition has no download canceller.";
      }
      return null;
    },
    { prefix: urlPrefix, unexpected: UNEXPECTED_ELECTRON },
  );
}

/**
 * Stops the test unless the page at `urlPrefix` is kept off the screen
 * (`offScreenProblem`). Called before a test raises a dialog or a download.
 */
export async function expectOffScreen(app: ElectronApplication, urlPrefix: string): Promise<void> {
  const problem = await offScreenProblem(app, urlPrefix);
  expect(problem, 'the page must be kept off the screen before anything is raised').toBeNull();
}
