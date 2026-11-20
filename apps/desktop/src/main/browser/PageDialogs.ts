import type { WebContents } from 'electron';

/** A dialog held for the agent is dismissed on its own after this long (Ruling Z). */
export const DIALOG_HOLD_MS = 60_000;

/** How much of what a page writes in a dialog is kept; the rest is counted. */
export const MAX_DIALOG_MESSAGE_CHARS = 2_000;

/** What `consola_browser_dialog` answers when nothing is held on the tab. */
export const NO_DIALOG_MESSAGE = 'There is no dialog open on this tab.';

export type DialogType = 'alert' | 'confirm' | 'prompt';

/** A page's dialog as an agent is told of it. The message is the page's own text. */
export interface HeldDialog {
  type: DialogType;
  message: string;
}

/**
 * Electron 43's own event for a page's `alert`, `confirm` or `prompt`
 * (`api::WebContents::RunJavaScriptDialog`), emitted on the page's web
 * contents with the details and the callback that answers the page. Its one
 * listener, installed as each web contents is created, shows a message box
 * for an alert or a confirm (and cancels a prompt at once). There is no
 * public API for this: `disableDialogs` is fixed when the page attaches, and
 * would take dialogs from the person as well.
 */
const RUN_DIALOG = '-run-dialog';
/** Chromium has cancelled the page's dialogs (it navigated, or is closing). */
const CANCEL_DIALOGS = '-cancel-dialogs';

interface RunDialogDetails {
  dialogType?: unknown;
  messageText?: unknown;
}
type DialogCallback = (success: boolean, userInput: string) => void;
type RunDialogListener = (details: RunDialogDetails, callback: DialogCallback) => void;

export interface PageDialogsDeps {
  /** The tab a page is bound to, or null while it is not. */
  tabIdFor(guestId: number): string | null;
  /** Whether an agent's connection is open on the page (`PageDriver.isConnected`). */
  isAgentConnected(guest: WebContents): boolean;
  /** Whether the person used the tab just now (`PersonInput`). */
  personIsUsing(tabId: string): boolean;
  /** Tests replace it: calls `fire` after `ms` unless the stop it answers is called first. */
  startTimer?(ms: number, fire: () => void): () => void;
}

interface Hold {
  guest: WebContents;
  dialog: HeldDialog;
  answer: DialogCallback;
  /** Shows it to the person, as Electron would have. */
  showToPerson(): void;
  stopTimer(): void;
}

function startTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function dialogTypeOf(value: unknown): DialogType | null {
  return value === 'alert' || value === 'confirm' || value === 'prompt' ? value : null;
}

function boundedMessage(value: unknown): string {
  const message = typeof value === 'string' ? value : '';
  if (message.length <= MAX_DIALOG_MESSAGE_CHARS) return message;
  const more = message.length - MAX_DIALOG_MESSAGE_CHARS;
  return `${message.slice(0, MAX_DIALOG_MESSAGE_CHARS)}… (${more} more characters)`;
}

/**
 * A page's alerts and confirms while an agent drives it.
 *
 * Electron shows each as a native message box over the window, and with an
 * agent's Playwright connected the box would still open (Playwright, given no
 * listener, dismisses the page's dialog at once, and Electron's box stays on
 * screen over a page that has moved on). So while an agent's connection is
 * open on a page, a dialog that is not the person's is held for the agent
 * instead: no box, the page waits, `consola_browser_status` lists it, and
 * `consola_browser_dialog` answers it through Electron's own callback. The
 * relay keeps the dialog from Playwright (`cdpRelayProtocol`).
 *
 * The person comes first. A dialog raised within 3 s of their input on the
 * tab is theirs, shown as ever; and pressing in a tab whose dialog is held
 * hands it to them, since a page that waits on an answer it never shows
 * looks frozen. A held dialog is dismissed when the agent's connection to
 * the page ends, and on its own after `DIALOG_HOLD_MS`. With no agent
 * connected, nothing changes.
 *
 * Electron runs `prompt()` in the page itself (it throws "prompt() is not
 * supported."), so only alerts and confirms ever reach main.
 */
export class PageDialogs {
  /** Held dialogs, by tab: a page shows at most one at a time. */
  private readonly held = new Map<string, Hold>();
  private readonly waiters = new Map<string, Set<(dialog: HeldDialog) => void>>();
  private readonly startTimer: (ms: number, fire: () => void) => () => void;

  constructor(private readonly deps: PageDialogsDeps) {
    this.startTimer = deps.startTimer ?? startTimer;
  }

  /**
   * Takes a page's dialogs over from Electron, as the page attaches. If
   * Electron's are not as this expects (one listener of its own), the page
   * is left as it is, and the change is reported, rather than guessed at.
   */
  public takeOver(guest: WebContents, guestId: number): void {
    const events = guest as unknown as NodeJS.EventEmitter;
    const electrons = events.listeners(RUN_DIALOG) as RunDialogListener[];
    if (electrons.length !== 1) {
      console.warn(
        `A page's JavaScript dialogs could not be taken over (Electron has ${electrons.length} listeners for them, not 1); an agent's page may show dialog boxes.`,
      );
      return;
    }
    const [electron] = electrons;
    events.removeListener(RUN_DIALOG, electron);
    events.on(RUN_DIALOG, (details: RunDialogDetails, callback: DialogCallback) => {
      const showToPerson = () => electron.call(guest, details, callback);
      const tabId = this.deps.tabIdFor(guestId);
      const type = dialogTypeOf(details?.dialogType);
      if (!tabId || !type || !this.deps.isAgentConnected(guest) || this.deps.personIsUsing(tabId)) {
        showToPerson();
        return;
      }
      this.hold(tabId, {
        guest,
        dialog: { type, message: boundedMessage(details.messageText) },
        answer: callback,
        showToPerson,
        stopTimer: () => {},
      });
    });
    events.on(CANCEL_DIALOGS, () => this.forgetGuest(guest));
    guest.once('destroyed', () => this.forgetGuest(guest));
  }

  /** The dialog held on a tab, if any. */
  public pendingFor(tabId: string): HeldDialog | undefined {
    return this.held.get(tabId)?.dialog;
  }

  /** Answers a tab's held dialog; what it answered, or undefined when none was held. */
  public answer(tabId: string, accept: boolean, text?: string): HeldDialog | undefined {
    const hold = this.release(tabId);
    if (!hold) return undefined;
    this.reply(hold, accept, accept ? (text ?? '') : '');
    return hold.dialog;
  }

  /**
   * Resolves with the tab's dialog once one is held (at once if one is), for
   * a call that must stop waiting on the page when it opens one. Stops
   * listening when `signal` aborts.
   */
  public opened(tabId: string, signal: AbortSignal): Promise<HeldDialog> {
    const pending = this.pendingFor(tabId);
    if (pending) return Promise.resolve(pending);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(tabId) ?? new Set();
      const stop = () => {
        waiters.delete(heard);
        if (waiters.size === 0 && this.waiters.get(tabId) === waiters) this.waiters.delete(tabId);
      };
      const heard = (dialog: HeldDialog) => {
        stop();
        resolve(dialog);
      };
      if (signal.aborted) return;
      waiters.add(heard);
      this.waiters.set(tabId, waiters);
      signal.addEventListener('abort', stop, { once: true });
    });
  }

  /** The person pressed in the tab: a dialog held there is theirs now, shown as Electron would. */
  public handToPerson(tabId: string): void {
    this.release(tabId)?.showToPerson();
  }

  /** The agent's connection to this page ended: what was held for it is dismissed. */
  public letGo(guest: WebContents): void {
    for (const [tabId, hold] of [...this.held]) {
      if (hold.guest !== guest) continue;
      this.release(tabId);
      this.reply(hold, false, '');
    }
  }

  private hold(tabId: string, hold: Hold): void {
    // A page shows one dialog at a time; an older one still held has gone.
    this.release(tabId);
    hold.stopTimer = this.startTimer(DIALOG_HOLD_MS, () => {
      if (this.held.get(tabId) !== hold) return;
      this.release(tabId);
      this.reply(hold, false, '');
    });
    this.held.set(tabId, hold);
    for (const heard of [...(this.waiters.get(tabId) ?? [])]) heard(hold.dialog);
  }

  private release(tabId: string): Hold | undefined {
    const hold = this.held.get(tabId);
    if (!hold) return undefined;
    this.held.delete(tabId);
    hold.stopTimer();
    return hold;
  }

  private forgetGuest(guest: WebContents): void {
    for (const [tabId, hold] of [...this.held]) if (hold.guest === guest) this.release(tabId);
  }

  private reply(hold: Hold, accept: boolean, text: string): void {
    try {
      hold.answer(accept, text);
    } catch (error) {
      // The page went in between: nobody is left to answer.
      console.warn(
        'Could not answer a page’s dialog:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
