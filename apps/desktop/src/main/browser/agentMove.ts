import type { WebContents } from 'electron';
import type { BrowserService } from './BrowserService';
import { CALL_DEADLINE_MS } from './PageDriver';
import type { PersonInput } from './PersonInput';

/** What an agent's move needs of `BrowserService`. */
export type AgentMoveBrowser = Pick<BrowserService, 'holdForToolCall' | 'guestFor'>;

export interface AgentMoveDeps {
  browser: AgentMoveBrowser;
  person: Pick<PersonInput, 'noteAgentMove'>;
}

/**
 * Runs an agent's move of one of its session's tabs (an address, back,
 * forward or reload) and returns what `move` gives.
 *
 * Moving a tab is using it (Ruling DD), even the person's own and even the
 * one they are looking at, so the move marks the tab as any call does
 * (`agentActive`): the strip shows the marker, and a window not showing the
 * session dots its globe. The mark mounts nothing. A tab with no page only
 * records its new address, so its move is over at once; a tab with a page
 * stays marked until that page has loaded what the move asked for (its
 * `did-stop-loading`), or goes, and at most `CALL_DEADLINE_MS`, like any
 * call. Nothing is focused.
 *
 * Before anything loads, the move is noted (Ruling II): the tab's next load
 * is the agent's, so a download it starts is cancelled like one an act
 * starts (`decideDownload`), whenever that load happens.
 */
export function moveAsAgent<T>(deps: AgentMoveDeps, tabId: string, move: () => T): T {
  deps.person.noteAgentMove(tabId);
  const release = deps.browser.holdForToolCall(tabId, { mount: false }) ?? (() => {});
  const guest = deps.browser.guestFor(tabId);
  let moved: T;
  try {
    moved = move();
  } catch (error) {
    release();
    throw error;
  }
  if (guest) untilLoaded(guest, release);
  else release();
  return moved;
}

/** Calls `done` once, when the page stops loading or goes, or after `CALL_DEADLINE_MS`. */
function untilLoaded(guest: WebContents, done: () => void): void {
  const finish = () => {
    clearTimeout(timer);
    guest.removeListener('did-stop-loading', finish);
    guest.removeListener('destroyed', finish);
    done();
  };
  guest.on('did-stop-loading', finish);
  guest.on('destroyed', finish);
  const timer = setTimeout(finish, CALL_DEADLINE_MS);
  timer.unref?.();
}
