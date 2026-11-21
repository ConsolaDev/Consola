const FRONT_TAB = '.side-panel-tab-trigger[data-state="active"]';
const CONVERSATION = '[data-conversation-terminal] .terminal-surface textarea';

/**
 * Where the keyboard goes when a tab that had it closes: from its menu, by
 * Delete, or the "+" list's Escape. Give it an element of the tab, or of its
 * group, before the close, since the group may go with the tab. Call what it
 * returns once the close has rendered; it says whether it placed the keyboard.
 *
 * 1. The tab now in front of the tab's own group, while that group is on screen.
 * 2. Else, the group having gone with its only tab, the front tab of the first
 *    group still on screen.
 * 3. Else, the side panel having hidden with its last tab, the conversation's
 *    terminal: the one place left in the session's view that takes typing,
 *    and where the keyboard was before the panel took it. The side panel's
 *    toggle stands in should the terminal not be there.
 *
 * Never the body, where the next key would land nowhere.
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
    return true;
  };
}
