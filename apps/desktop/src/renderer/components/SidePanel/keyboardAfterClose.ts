const FRONT_TAB = '.side-panel-tab-trigger[data-state="active"]';
const CONVERSATION = '[data-conversation-terminal] .terminal-surface textarea';

/**
 * Where the keyboard goes when a tab or group that had it closes: from the
 * tab's menu, by Delete, by its ✕, by Close group, or the "+" list's Escape.
 * Give it an element of the tab, or of its group, before the close, since the
 * group may go with the tab. Call what it returns once the close has
 * rendered; it says whether it placed the keyboard.
 *
 * 1. The tab now in front of the tab's own group, while that group is on screen.
 * 2. Else, the group having gone with its only tab, the front tab of the first
 *    group still on screen.
 * 3. Else, the side panel having hidden with its last tab, the conversation's
 *    terminal: the one place left in the session's view that takes typing.
 *    The side panel's toggle stands in should the terminal not be there.
 *
 * Never the body, where the next key would land nowhere. A key held down to
 * close a tab closes that one: once the keyboard is placed, its repeats stop
 * at the window rather than act wherever the keyboard went. There they would
 * close the next tab, or, in the conversation, delete the person's text
 * (Backspace), interrupt Claude (Escape) or submit (Enter).
 */
export function keyboardAfterClose(closing: Element): () => boolean {
  const group = closing.closest('.side-panel-group');
  const view = closing.closest('.workspace-view');
  return () => {
    const target =
      (group?.isConnected ? group.querySelector<HTMLElement>(FRONT_TAB) : null) ??
      view?.querySelector<HTMLElement>(`.side-panel ${FRONT_TAB}`) ??
      view?.querySelector<HTMLElement>(CONVERSATION) ??
      view?.querySelector<HTMLElement>('.side-panel-toggle');
    if (!target?.isConnected) return false;
    target.focus();
    swallowHeldKeyRepeats();
    return true;
  };
}

/**
 * Whether the keyboard is in a tab: on its trigger or ✕, or in what the tab
 * shows, which goes with it when it closes or moves. Give it an element of
 * the tab in its bar.
 */
export function keyboardInTab(tab: Element): boolean {
  const entry = tab.closest('.side-panel-tab');
  const focused = document.activeElement;
  if (!entry || !focused) return false;
  if (entry.contains(focused)) return true;
  const contentId = entry.querySelector('[role="tab"]')?.getAttribute('aria-controls');
  return !!contentId && !!document.getElementById(contentId)?.contains(focused);
}

/**
 * Focuses a tab's trigger, in whichever group's bar it is now: where the
 * keyboard goes with a tab that moved. Only for a moved, split or dragged
 * tab: those are never the placeholder, so `tab` is a kind, open once.
 */
export function focusTrigger(tab: string): boolean {
  const trigger = document.querySelector<HTMLElement>(
    `.side-panel-tab-trigger[data-tab="${CSS.escape(tab)}"]`,
  );
  trigger?.focus();
  return trigger !== null;
}

/**
 * Stops the auto-repeat of whatever key is held, until it is let go or
 * another key is pressed: a key pressed now is the person's, and goes where
 * the keyboard is. Listened for on the window's capture, ahead of the
 * conversation's terminal, which takes its keys on its own capture. Also
 * for the Escape that cancels a tab drag.
 */
export function swallowHeldKeyRepeats(): void {
  const stop = () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', stop, true);
    window.removeEventListener('blur', stop);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.repeat) {
      stop();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', stop, true);
  window.addEventListener('blur', stop);
}
