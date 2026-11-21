import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import {
  type GroupId,
  otherGroup,
  type TabId,
  type TabMenuItem,
  tabMenuItems,
} from '../../sidePanel/layout';
import { useSidePanelStore } from '../../stores/sidePanelStore';

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
 * keyboard was on the tab, it follows the tab into the bar it moved to, or
 * goes to the tab now in front of its bar once it closed. Otherwise it goes
 * back to where it was, as the menu always does: a right-click from the
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
  // The tab's bar, kept when the menu opens with the keyboard on the tab.
  const keyboardFrom = useRef<Element | null>(null);
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
    keyboardFrom.current = wrapper.contains(document.activeElement)
      ? wrapper.closest('[role="tablist"]')
      : null;
  };

  // Once an item has taken the tab out of its bar. Dismissed, or opened with
  // the keyboard elsewhere, the menu hands it back to where it was itself.
  const placeKeyboard = (event: Event) => {
    const bar = keyboardFrom.current;
    const item = chosen.current;
    keyboardFrom.current = null;
    chosen.current = null;
    if (!bar || !item) return;
    event.preventDefault();
    // Move and Split are never offered for the placeholder: `tab` is a kind, open once.
    const target = item === 'close' ? bar.querySelector<HTMLElement>(FRONT_TAB) : triggerOf(tab);
    target?.focus();
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

const FRONT_TAB = '[role="tab"][data-state="active"]';

/** A tab's trigger, in whichever group's bar it is now. */
function triggerOf(tab: TabId): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.side-panel-tab-trigger[data-tab="${CSS.escape(tab)}"]`,
  );
}
