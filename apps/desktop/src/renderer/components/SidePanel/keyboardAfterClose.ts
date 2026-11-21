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
  return () =>
    placeKeyboard(
      (group?.isConnected ? group.querySelector<HTMLElement>(FRONT_TAB) : null) ??
        view?.querySelector<HTMLElement>(`.side-panel ${FRONT_TAB}`) ??
        conversationTerminal() ??
        view?.querySelector<HTMLElement>('.side-panel-toggle'),
    );
}

/**
 * Where the keyboard goes when the person's own action, taken from inside
 * the side panel or from a page, takes away the place it was in, and the
 * tab bar did not take the action: Escape in Changes, or a view's own close
 * button, closing the view's tab; the Browser tab's ✕ or menu Close with
 * the keyboard in its page; a chord that hides the side panel with the
 * keyboard in it. The conversation's terminal, never the body, where the
 * next key would land nowhere; a held key's repeats stop at the window (see
 * `keyboardAfterClose`). Call it once the change has rendered. Says whether
 * it placed the keyboard.
 *
 * Only after such an action. One taken from the conversation, the header or
 * the palette leaves the keyboard where it is, and so does a close from the
 * bar with the keyboard in the tab, which `keyboardAfterClose` hands on.
 */
export function keyboardToConversation(): boolean {
  return placeKeyboard(conversationTerminal());
}

/** Whether the keyboard is in a page: its `<webview>`, or the host that draws the pages. */
export function keyboardInPage(): boolean {
  const focused = document.activeElement;
  return focused?.tagName === 'WEBVIEW' || !!focused?.closest('.browser-host');
}

/**
 * Whether the keyboard is in the page a tab shows: in a page, while what the
 * tab shows holds the slot a page is drawn over. A page lives outside its
 * tab (see "Pages Live in One Place"), so `keyboardInTab` never sees it
 * there. Give it an element of the tab in its bar.
 */
export function keyboardInTabPage(tab: Element): boolean {
  if (!keyboardInPage()) return false;
  const contentId = tab
    .closest('.side-panel-tab')
    ?.querySelector('[role="tab"]')
    ?.getAttribute('aria-controls');
  return !!contentId && !!document.getElementById(contentId)?.querySelector('.browser-slot');
}

/** Whether the keyboard is in the side panel, or in a page, which is only ever drawn over it. */
export function keyboardInSidePanel(): boolean {
  return keyboardInPage() || !!document.activeElement?.closest('.side-panel');
}

/**
 * The conversation's terminal, looked up from the document: a page is not
 * inside the session's view, and the window shows one conversation.
 */
function conversationTerminal(): HTMLElement | null {
  return document.querySelector<HTMLElement>(CONVERSATION);
}

/** Gives `target` the keyboard, and stops a held key's repeats there. */
function placeKeyboard(target: HTMLElement | null | undefined): boolean {
  if (!target?.isConnected) return false;
  target.focus();
  swallowHeldKeyRepeats();
  return true;
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
