import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type DragMoveEvent,
  useDndContext,
  useDndMonitor,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import * as Tabs from '@radix-ui/react-tabs';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Maximize2, Minimize2, Plus, X } from 'lucide-react';
import {
  type DraggedTab,
  type DropZone,
  draggedTabOf,
  insertionIndex,
} from '../../sidePanel/dropTarget';
import { NEW_TAB, type GroupPosition, type TabGroupNode, type TabId } from '../../sidePanel/layout';
import { tabKind, type TabFacts } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { dragPointer } from './dragPointer';
import {
  keyboardAfterClose,
  keyboardInTab,
  keyboardInTabPage,
  keyboardToConversation,
} from './keyboardAfterClose';
import { TabMenu } from './TabMenu';
import { useTabMark } from './tabMarks';

/** Each tab list is named by where its group sits, so two groups' lists can be told apart. */
const TAB_LIST_NAMES: Record<GroupPosition, string> = {
  only: 'Side panel tabs',
  top: 'Top group tabs',
  bottom: 'Bottom group tabs',
  left: 'Left group tabs',
  right: 'Right group tabs',
};

interface TabBarProps {
  group: TabGroupNode;
  position: GroupPosition;
  facts: TabFacts;
  /** There is another group, so this one can fill the panel. */
  canMaximize: boolean;
  /** This group fills the panel, hiding the other. */
  isMaximized: boolean;
}

/**
 * A group's tabs and its "+", then the controls for the group as a whole.
 * The whole bar is a place to drop a dragged tab, the free space after the
 * "+" included: a tab dropped past the last one goes at the end.
 */
export function TabBar({ group, position, facts, canMaximize, isMaximized }: TabBarProps) {
  const toggleMaximize = useSidePanelStore((state) => state.toggleMaximize);
  const closeGroup = useSidePanelStore((state) => state.closeGroup);
  const addPlaceholder = useSidePanelStore((state) => state.addPlaceholder);
  const barRef = useRef<HTMLDivElement | null>(null);
  const zone: DropZone = {
    part: 'bar',
    groupId: group.id,
    // Counted among this group's tabs without the dragged one, as `moveTab` counts.
    placeAt: (tab, x) => {
      const place = barInsertion(barRef.current, tab, x);
      if (!place) return null;
      const rest = group.tabs.filter((each) => each !== tab);
      const index = place.before === null ? rest.length : rest.indexOf(place.before);
      return { index: index === -1 ? rest.length : index, caretLeft: place.caretLeft };
    },
  };
  const { setNodeRef } = useDroppable({ id: `bar:${group.id}`, data: zone });
  const setBar = useCallback(
    (node: HTMLDivElement | null) => {
      barRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  // The group goes with its tabs, and the keyboard with it should it be in
  // the group: it is handed on, as a closed tab hands it.
  const closeThisGroup = (event: MouseEvent<HTMLButtonElement>) => {
    const groupElement = event.currentTarget.closest('.side-panel-group');
    const handOn = groupElement?.contains(document.activeElement)
      ? keyboardAfterClose(event.currentTarget)
      : null;
    closeGroup(group.id);
    if (handOn) requestAnimationFrame(() => handOn());
  };

  // A fresh list takes the keyboard itself. One already in front does not
  // appear again, so it is handed the keyboard here.
  const openNewTab = (event: MouseEvent<HTMLButtonElement>) => {
    const groupElement = event.currentTarget.closest('.side-panel-group');
    addPlaceholder(group.id);
    requestAnimationFrame(() =>
      groupElement?.querySelector<HTMLElement>('[role="listbox"]')?.focus(),
    );
  };

  return (
    <Tooltip.Provider delayDuration={300}>
      <div ref={setBar} className="side-panel-tab-bar">
        <Tabs.List className="side-panel-tab-list" aria-label={TAB_LIST_NAMES[position]}>
          {group.tabs.map((tab) => (
            <TabBarTab
              key={tab}
              groupId={group.id}
              tab={tab}
              inFront={tab === group.active}
              facts={facts}
            />
          ))}
        </Tabs.List>
        <BarButton label="New tab" onClick={openNewTab}>
          <Plus size={14} />
        </BarButton>
        <div className="side-panel-group-controls">
          {canMaximize && (
            <BarButton
              label={isMaximized ? 'Restore group' : 'Maximize group'}
              onClick={() => toggleMaximize(group.id)}
            >
              {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </BarButton>
          )}
          <BarButton label="Close group" onClick={closeThisGroup} pressKeepsKeyboard>
            <X size={14} />
          </BarButton>
        </div>
        <DropCaret groupId={group.id} />
      </div>
    </Tooltip.Provider>
  );
}

/**
 * Where a tab dropped at `x` goes in this bar: before which of its other
 * tabs (`null` for the end), and the caret's place from the bar's left edge.
 * The caret stays inside the tab list, so past the last tab it is drawn
 * before the "+", never after it.
 */
function barInsertion(
  bar: HTMLElement | null,
  dragged: TabId,
  x: number,
): { before: TabId | null; caretLeft: number } | null {
  const list = bar?.querySelector('.side-panel-tab-list');
  if (!bar || !list) return null;
  const tabs = [...list.querySelectorAll<HTMLElement>('.side-panel-tab[data-tab]')]
    .filter((tab) => tab.dataset.tab !== dragged)
    .map((tab) => ({ tab: tab.dataset.tab as TabId, box: tab.getBoundingClientRect() }));
  const index = insertionIndex(
    tabs.map(({ box }) => box),
    x,
  );
  const bounds = list.getBoundingClientRect();
  const last = tabs[tabs.length - 1];
  // In the middle of the 2px gap before the tab it goes before, else after the last tab.
  const boundary =
    index < tabs.length ? tabs[index].box.left - 1 : last ? last.box.right + 1 : bounds.left;
  const caret = Math.min(Math.max(boundary, bounds.left), bounds.right);
  return {
    before: index < tabs.length ? tabs[index].tab : null,
    caretLeft: caret - bar.getBoundingClientRect().left,
  };
}

/**
 * The 2px caret where a tab dragged over this bar would go. Only this
 * re-renders as the pointer moves: nothing in the layout changes until the
 * drop, so the tabs and their views stay as they are.
 */
function DropCaret({ groupId }: { groupId: string }) {
  const [left, setLeft] = useState<number | null>(null);
  const follow = ({ active, over }: DragMoveEvent) => {
    const zone = over?.data.current as DropZone | undefined;
    const dragged = draggedTabOf(active);
    const pointer = dragPointer();
    const place =
      zone?.part === 'bar' && zone.groupId === groupId && dragged !== undefined && pointer
        ? zone.placeAt(dragged, pointer.x)
        : null;
    setLeft(place ? place.caretLeft : null);
  };
  useDndMonitor({
    onDragMove: follow,
    onDragOver: follow,
    onDragEnd: () => setLeft(null),
    onDragCancel: () => setLeft(null),
  });
  if (left === null) return null;
  return <span className="side-panel-drop-caret" style={{ left: left - 1 }} aria-hidden="true" />;
}

/** What follows the pointer while a tab is dragged: the tab's icon and label. */
export function DraggedTabPreview({ facts }: { facts: TabFacts }) {
  const { active } = useDndContext();
  const dragged = draggedTabOf(active);
  const kind = dragged !== undefined ? tabKind(dragged) : undefined;
  if (!kind) return null;
  const Icon = kind.icon;
  return (
    <div className="side-panel-tab-drag-preview" aria-hidden="true">
      <Icon size={14} aria-hidden="true" />
      <span className="side-panel-tab-label">{kind.tabTitle?.(facts) ?? kind.title(facts)}</span>
    </div>
  );
}

/**
 * One tab: its trigger, and a close button beside it rather than inside, so
 * the trigger stays a plain tab for the keyboard, all inside the tab's menu.
 * A tab id the registry does not list has nothing to show; the placeholder
 * still gets its name, so it can be closed. A kind's mark is drawn on its tab
 * while the tab is behind another: in front, its view is showing what the
 * mark is about. Every tab but the placeholder can be dragged by the pointer;
 * the menu is the keyboard's way to move one.
 */
function TabBarTab({
  groupId,
  tab,
  inFront,
  facts,
}: {
  groupId: string;
  tab: TabId;
  inFront: boolean;
  facts: TabFacts;
}) {
  const closeTab = useSidePanelStore((state) => state.closeTab);
  const mark = useTabMark(tab, facts);
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `tab:${groupId}:${tab}`,
    data: { groupId, tab } satisfies DraggedTab,
    disabled: tab === NEW_TAB,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  // A tab that comes in front is scrolled into its bar, which a narrow side
  // panel cannot show whole, and whose scrollbar is hidden: the person sees
  // which tab is in front, and can reach its ✕. Only the bar scrolls. A tab
  // pressed to drag it comes in front as the button goes down, so its bar
  // may scroll as the drag begins: the drag goes by the pointer itself
  // (`dragPointer`), never by how far it moved, so it still lands there.
  useEffect(() => {
    if (inFront) scrollIntoBar(triggerRef.current?.closest('.side-panel-tab'));
  }, [inFront]);
  const kind = tabKind(tab);
  if (!kind && tab !== NEW_TAB) return null;

  const title = kind ? kind.title(facts) : 'New tab';
  const marked = mark !== null && !inFront;
  const label = kind?.tabTitle?.(facts) ?? title;
  const Icon = kind?.icon;
  const close = () => closeTab(groupId, tab);

  // The ✕ never takes the keyboard. When it was in the tab, on it or in what
  // it shows, it is handed on as from a close by Delete; in the page the tab
  // shows, which goes with it, it goes to the conversation; elsewhere it
  // stays.
  const closeByPointer = (event: MouseEvent<HTMLButtonElement>) => {
    const handOn = keyboardInTab(event.currentTarget)
      ? keyboardAfterClose(event.currentTarget)
      : keyboardInTabPage(event.currentTarget)
        ? keyboardToConversation
        : null;
    close();
    if (handOn) requestAnimationFrame(() => handOn());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    const handOn = keyboardAfterClose(event.currentTarget);
    close();
    // The closed trigger took the keyboard with it: hand it on once the close has rendered.
    requestAnimationFrame(() => handOn());
  };

  return (
    <TabMenu groupId={groupId} tab={tab}>
      <div
        ref={setNodeRef}
        {...listeners}
        className={`side-panel-tab${inFront ? ' active' : ''}`}
        data-tab={tab}
        data-dragging={isDragging || undefined}
      >
        <Tabs.Trigger
          ref={triggerRef}
          value={tab}
          className="side-panel-tab-trigger"
          data-tab={tab}
          aria-label={marked ? `${title}, ${mark.onKind}` : title}
          data-agent-dot={marked ? true : undefined}
          onKeyDown={onKeyDown}
        >
          {Icon && <Icon size={14} aria-hidden="true" />}
          <span className="side-panel-tab-label">{label}</span>
        </Tabs.Trigger>
        <button
          type="button"
          className="side-panel-tab-close"
          tabIndex={-1}
          aria-label={`Close ${title} tab`}
          // No press focuses it: one that closes the tab would take the
          // keyboard away with it, and one that opens the tab's menu (the
          // right button, or Ctrl on macOS) leaves it where it was, as the
          // trigger's does. A press here still begins a drag of the tab: it
          // is handed to the drag first, since dnd-kit ignores a press
          // already prevented, and the tab's own listener then sees it taken.
          onMouseDown={(event) => {
            listeners?.onMouseDown?.(event);
            event.preventDefault();
          }}
          onClick={closeByPointer}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </TabMenu>
  );
}

/**
 * Scrolls the tab list just enough to show the whole of `entry`, a tab in
 * it. By hand rather than `scrollIntoView`, which would also scroll any box
 * around the bar that clips it.
 */
function scrollIntoBar(entry: Element | null | undefined): void {
  const list = entry?.closest('.side-panel-tab-list');
  if (!entry || !list) return;
  const tab = entry.getBoundingClientRect();
  const shown = list.getBoundingClientRect();
  if (tab.left < shown.left) list.scrollLeft -= shown.left - tab.left;
  else if (tab.right > shown.right) list.scrollLeft += tab.right - shown.right;
}

function BarButton({
  label,
  onClick,
  pressKeepsKeyboard = false,
  children,
}: {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** A press leaves the keyboard where it was: for a button that takes itself away. */
  pressKeepsKeyboard?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className="side-panel-bar-button"
          aria-label={label}
          onMouseDown={pressKeepsKeyboard ? (event) => event.preventDefault() : undefined}
          onClick={onClick}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={5}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
