import type { WebContents } from 'electron';
import type { BrowserService, PageAvailability } from './BrowserService';
import { DEVTOOLS_OPEN_MESSAGE } from './CdpRelay';

/** How long a call waits for the window to mount a tab's page and bind it. */
export const ENSURE_LIVE_TIMEOUT_MS = 15_000;

export const NO_WINDOW_MESSAGE = 'Open this workspace in a window to use its browser.';
export const BLANK_TAB_MESSAGE = 'This tab has no page yet; navigate it to an address first.';
export const NO_TAB_MESSAGE = 'There is no such tab.';
export const NOT_IN_TIME_MESSAGE = `The tab's page did not start within ${ENSURE_LIVE_TIMEOUT_MS / 1000} seconds.`;

/** Why an agent cannot have a page, in the words its tool answers with; null when it can. */
function refusalFor(availability: PageAvailability): string | null {
  switch (availability) {
    case 'missing':
      return NO_TAB_MESSAGE;
    case 'blank':
      return BLANK_TAB_MESSAGE;
    case 'no-window':
      return NO_WINDOW_MESSAGE;
    case 'ready':
      return null;
  }
}

/** What a call needs of `BrowserService`. */
export type AgentPagesBrowser = Pick<
  BrowserService,
  'pageAvailability' | 'holdForToolCall' | 'guestFor' | 'onGuestBound'
>;

/** One agent tool call on one tab: its live page, held until `end`. */
export interface AgentCall {
  guest: WebContents;
  /** Ends the call. The tab then counts as just used. Idempotent. */
  end(): void;
}

/**
 * An agent's tool calls on the in-app browser's tabs: `beginToolCall` is the
 * call starting and `end` its finish, and in between the tab has a live page
 * (`ensureLive`).
 *
 * A page needs a window: it is a `<webview>` element, and only the window
 * holding the workspace can draw it (Invariant 4). So a tab with no page is
 * held, which makes it live in main's reckoning; the snapshot that says so
 * has that window mount it, painting but unseen, and the call goes on once
 * the element's guest binds. Nothing here opens the panel or focuses
 * anything (Invariant 6): the page appears only where the person already
 * looks, if they look.
 */
export class AgentPages {
  constructor(private readonly browser: AgentPagesBrowser) {}

  /**
   * Starts a call on a tab and resolves once its page is bound. Refuses a
   * tab with no page to have, or one whose page has DevTools open, and gives
   * up after `ENSURE_LIVE_TIMEOUT_MS`. Refusals come before anything is held.
   * From then on the tab is held, so it is exempt from unloading and marked
   * as the agent's; a timeout lets go of it again.
   */
  public async beginToolCall(tabId: string): Promise<AgentCall> {
    const refusal =
      refusalFor(this.browser.pageAvailability(tabId)) ??
      // The person has the page (the relay would refuse too, but only once
      // the hold had marked the tab as the agent's). A tab with no page has
      // no DevTools.
      (this.browser.guestFor(tabId)?.isDevToolsOpened() ? DEVTOOLS_OPEN_MESSAGE : null);
    if (refusal) throw new Error(refusal);
    const end = this.browser.holdForToolCall(tabId);
    if (!end) throw new Error(NO_TAB_MESSAGE);
    try {
      return { guest: await this.ensureLive(tabId), end };
    } catch (error) {
      end();
      throw error;
    }
  }

  /** The tab's bound page, waiting for the window to mount and bind it if it has none yet. */
  private ensureLive(tabId: string): Promise<WebContents> {
    const bound = this.browser.guestFor(tabId);
    if (bound) return Promise.resolve(bound);
    return new Promise((resolve, reject) => {
      const stopWatching = this.browser.onGuestBound((boundTab, guest) => {
        if (boundTab !== tabId) return;
        finish();
        resolve(guest);
      });
      const timer = setTimeout(() => {
        finish();
        // The window may have let go of the workspace, or the tab closed,
        // while the call waited: that says more than the wait running out.
        reject(new Error(refusalFor(this.browser.pageAvailability(tabId)) ?? NOT_IN_TIME_MESSAGE));
      }, ENSURE_LIVE_TIMEOUT_MS);
      const finish = () => {
        clearTimeout(timer);
        stopWatching();
      };
    });
  }
}
