import type { WebContents } from 'electron';
import type { BrowserService } from './BrowserService';
import { CALL_DEADLINE_MS } from './PageDriver';
import type { PersonInput } from './PersonInput';

/** What an agent's move needs of `BrowserService`. */
export type AgentMoveBrowser = Pick<BrowserService, 'holdForToolCall' | 'guestFor'>;

export interface AgentMoveDeps {
  browser: AgentMoveBrowser;
  person: Pick<PersonInput, 'noteAgentUse'>;
}

/**
 * Runs an agent's move of one of its session's tabs (an address, back,
 * forward or reload) and returns what `move` gives.
 *
 * Moving a tab is using it, even the person's own and even the
 * one they are looking at, so the move marks the tab as any call does
 * (`agentActive`): the strip shows the marker, and a window not showing the
 * session dots its globe. The mark mounts nothing. A tab with no page only
 * records its new address, so its move is over at once; a tab with a page
 * stays marked until that page has loaded what the move asked for (its
 * `did-stop-loading`), or goes, and at most `CALL_DEADLINE_MS`, like any
 * call. Nothing is focused.
 *
 * Before anything loads, the move takes the tab into the agent's hands: a
 * download its page starts, whenever it loads and however
 * long after, is cancelled until the person next presses in the tab
 * (`decideDownload`).
 */
export function moveAsAgent<T>(deps: AgentMoveDeps, tabId: string, move: () => T): T {
  deps.person.noteAgentUse(tabId);
  // A page that never stops loading would otherwise keep every earlier
  // move's listeners on it until each one's deadline.
  waits.get(tabId)?.();
  const release = deps.browser.holdForToolCall(tabId, { mount: false }) ?? (() => {});
  const guest = deps.browser.guestFor(tabId);
  let moved: T;
  try {
    moved = move();
  } catch (error) {
    release();
    throw error;
  }
  if (guest) untilLoaded(tabId, guest, release);
  else release();
  return moved;
}

/** Each tab's move still waiting on its page, by what ends that wait. */
const waits = new Map<string, () => void>();

/**
 * Calls `done` once, when the page stops loading or goes, after
 * `CALL_DEADLINE_MS`, or when the next move on the tab begins.
 */
function untilLoaded(tabId: string, guest: WebContents, done: () => void): void {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    guest.removeListener('did-stop-loading', finish);
    guest.removeListener('destroyed', finish);
    if (waits.get(tabId) === finish) waits.delete(tabId);
    done();
  };
  waits.set(tabId, finish);
  guest.on('did-stop-loading', finish);
  guest.on('destroyed', finish);
  const timer = setTimeout(finish, CALL_DEADLINE_MS);
  timer.unref?.();
}
