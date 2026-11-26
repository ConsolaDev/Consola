import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { otherGroup, tabMenuItems } from '../../sidePanel/layout';
import type { GroupId, TabId, TabMenuItem } from '../../sidePanel/layout';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import {
  focusTrigger,
  keyboardAfterClose,
  keyboardInTab,
  keyboardInTabPage,
  keyboardToConversation,
} from './keyboardAfterClose';

const ITEM_LABELS: Record<TabMenuItem, string> = {
  close: 'Close',
  move: 'Move to other group',
  'split-down': 'Split down',
  'split-right': 'Split right',
};

/**
 * A tab's menu: what `tabMenuItems` offers, from a right-click on the tab, or
 * from Shift+F10 or the menu key while its trigger has the keyboard. Those
 * keys send the tab a `contextmenu` at the trigger's bottom-left, so the menu
 * opens under the tab rather than at the pointer.
 *
 * Every item takes the tab out of its bar, and this menu with it. When the
 * keyboard was in the tab, on it or in what it shows (the Files tree, the
 * shell), it follows the tab to its trigger in the bar it moved to, or, once
 * the tab closed, goes where `keyboardAfterClose` sends it: what the tab
 * shows goes with it, and is never given the keyboard itself. Otherwise it
 * goes back to where it was, as the menu always does: a right-click from the
 * conversation leaves the keyboard there.
 *
 * The content draws over a page (`dropdown-content`): a page sits above the
 * layout, over its slot, and a menu beside the Browser tab would otherwise be
 * drawn beneath it.
 */
export function TabMenu({
  groupId,
  tab,
  children,
}: {
  groupId: GroupId;
  tab: TabId;
  children: ReactNode;
}) {
  const layout = useSidePanelStore((state) => state.layout);
  const tabRef = useRef<HTMLElement>(null);
  // Set when the menu opens with the keyboard in the tab: where it goes should the tab close.
  const keyboardOnTab = useRef<(() => boolean) | null>(null);
  // Set when the menu opens with the keyboard in the page the tab shows.
  const keyboardInItsPage = useRef(false);
  const chosen = useRef<TabMenuItem | null>(null);

  const act: Record<TabMenuItem, () => void> = {
    close: () => useSidePanelStore.getState().closeTab(groupId, tab),
    move: () => {
      const { layout: current, moveTab } = useSidePanelStore.getState();
      const other = otherGroup(current, groupId);
      if (other) moveTab(tab, other.id, other.tabs.length);
    },
    'split-down': () => useSidePanelStore.getState().splitWithTab(groupId, tab, 'bottom'),
    'split-right': () => useSidePanelStore.getState().splitWithTab(groupId, tab, 'right'),
  };

  const onOpenChange = (open: boolean) => {
    const wrapper = tabRef.current;
    if (!open || !wrapper) return;
    chosen.current = null;
    keyboardOnTab.current = keyboardInTab(wrapper) ? keyboardAfterClose(wrapper) : null;
    keyboardInItsPage.current = keyboardInTabPage(wrapper);
  };

  // Once an item has taken the tab out of its bar. Dismissed, or opened with
  // the keyboard elsewhere, the menu hands it back to where it was itself, as
  // it also does should no place be found here. With the keyboard in the
  // page the tab shows, only Close places it here, in the conversation: the
  // page goes with the tab. Moved, the page stays drawn, and the menu hands
  // the keyboard back as it does from anywhere else.
  const placeKeyboard = (event: Event) => {
    const afterClose = keyboardOnTab.current;
    const inItsPage = keyboardInItsPage.current;
    const item = chosen.current;
    keyboardOnTab.current = null;
    keyboardInItsPage.current = false;
    chosen.current = null;
    if (!item) return;
    if (afterClose) {
      if (item === 'close' ? afterClose() : focusTrigger(tab)) event.preventDefault();
    } else if (inItsPage && item === 'close' && keyboardToConversation()) {
      event.preventDefault();
    }
  };

  // macOS sends no `contextmenu` for these keys, so the tab is sent one.
  const openFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    if (!(event.target instanceof HTMLElement)) return;
    event.preventDefault();
    const box = event.target.getBoundingClientRect();
    event.currentTarget.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.left,
        clientY: box.bottom,
      }),
    );
  };

  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu.Trigger asChild ref={tabRef} onKeyDown={openFromKeyboard}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="dropdown-content dropdown-content-compact"
          onCloseAutoFocus={placeKeyboard}
        >
          {tabMenuItems(layout, groupId, tab).map((item) => (
            <ContextMenu.Item
              key={item}
              className="dropdown-item"
              onSelect={() => {
                chosen.current = item;
                act[item]();
              }}
            >
              {ITEM_LABELS[item]}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
