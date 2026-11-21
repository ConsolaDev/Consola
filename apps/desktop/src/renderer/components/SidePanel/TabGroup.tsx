import { useCallback, useRef, useState } from 'react';
import { type DragMoveEvent, useDndMonitor, useDroppable } from '@dnd-kit/core';
import * as Tabs from '@radix-ui/react-tabs';
import { type DropZone, draggedTabOf, splitEdge } from '../../sidePanel/dropTarget';
import {
  type Edge,
  type GroupId,
  type GroupPosition,
  NEW_TAB,
  type TabGroupNode,
  type TabId,
} from '../../sidePanel/layout';
import { bodyFor, tabKind, type TabFacts } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { dragPointer } from './dragPointer';
import { keyboardToConversation } from './keyboardAfterClose';
import { NewTabList } from './NewTabList';
import { TabBar } from './TabBar';
import { TAB_VIEWS } from './tabViews';

interface TabGroupProps {
  group: TabGroupNode;
  position: GroupPosition;
  facts: TabFacts;
  canMaximize: boolean;
  isMaximized: boolean;
}

/**
 * One group on screen: its tab bar, and under it a slot for every tab it
 * holds. Only a group on screen is rendered at all, so a tab in front here is
 * a tab in front on screen. Activation is manual: arrow keys move the focus
 * along the bar, and Enter, Space or a click brings a tab to the front.
 */
export function TabGroup({ group, position, facts, canMaximize, isMaximized }: TabGroupProps) {
  const bringToFront = useSidePanelStore((state) => state.bringToFront);

  return (
    <Tabs.Root
      className="side-panel-group"
      value={group.active ?? ''}
      onValueChange={(tab) => bringToFront(group.id, tab)}
      activationMode="manual"
    >
      <TabBar
        group={group}
        position={position}
        facts={facts}
        canMaximize={canMaximize}
        isMaximized={isMaximized}
      />
      <div className="side-panel-group-body">
        {group.tabs.map((tab) => (
          <TabSlot
            key={tab}
            groupId={group.id}
            tab={tab}
            inFront={tab === group.active}
            facts={facts}
          />
        ))}
        <ContentDropZone groupId={group.id} />
      </div>
    </Tabs.Root>
  );
}

/**
 * The group's content as a place to drop a tab. Near an edge, while the tab
 * can split from this group, it shows the half the new group would take.
 * Laid over the content without taking the pointer, and alone in
 * re-rendering as the pointer moves, so the views under it never do. The
 * target draws over a page, which sits above the layout over its slot.
 */
function ContentDropZone({ groupId }: { groupId: GroupId }) {
  const zone: DropZone = { part: 'content', groupId };
  const { setNodeRef } = useDroppable({ id: `content:${groupId}`, data: zone });
  const [edge, setEdge] = useState<Edge | null>(null);
  const follow = ({ active, over }: DragMoveEvent) => {
    const target = over?.data.current as DropZone | undefined;
    const dragged = draggedTabOf(active);
    const pointer = dragPointer();
    const layout = useSidePanelStore.getState().layout;
    setEdge(
      over &&
        target?.part === 'content' &&
        target.groupId === groupId &&
        dragged !== undefined &&
        pointer
        ? splitEdge(layout, groupId, dragged, over.rect, pointer)
        : null,
    );
  };
  useDndMonitor({
    onDragMove: follow,
    onDragOver: follow,
    onDragEnd: () => setEdge(null),
    onDragCancel: () => setEdge(null),
  });
  return (
    <div ref={setNodeRef} className="side-panel-drop-zone">
      {edge && <div className="side-panel-drop-target" data-edge={edge} />}
    </div>
  );
}

/**
 * What one tab renders, as `bodyFor` decides. A view behind another tab stays
 * mounted but hidden, and is keyed by the session, so it follows the session
 * on screen rather than carrying one session's state into the next. A tab id
 * the registry does not list renders nothing. The placeholder is not a kind:
 * it shows the "+" list while it is in front, and nothing behind.
 */
function TabSlot({
  groupId,
  tab,
  inFront,
  facts,
}: {
  groupId: GroupId;
  tab: TabId;
  inFront: boolean;
  facts: TabFacts;
}) {
  const closeTab = useSidePanelStore((state) => state.closeTab);
  const content = useRef<HTMLDivElement>(null);
  // What a view calls to close its own tab: Changes' Escape, or a view's own
  // close button. The keyboard was in the view, which goes with the tab, so
  // it goes to the conversation once the close has rendered.
  const close = useCallback(() => {
    const fromInside = !!content.current?.contains(document.activeElement);
    closeTab(groupId, tab);
    if (fromInside) requestAnimationFrame(() => keyboardToConversation());
  }, [closeTab, groupId, tab]);

  if (tab === NEW_TAB) {
    if (!inFront) return null;
    // The list inside is the one stop for the keyboard, not this panel too.
    return (
      <Tabs.Content value={tab} tabIndex={-1} className="side-panel-tab-content">
        <NewTabList groupId={groupId} facts={facts} />
      </Tabs.Content>
    );
  }

  const kind = tabKind(tab);
  if (!kind) return null;

  const body = bodyFor(kind, facts, inFront);
  if (body === 'none') return null;

  if (body === 'unavailable') {
    const availability = kind.availability(facts);
    return (
      <Tabs.Content value={tab} className="side-panel-tab-content side-panel-unavailable">
        {!availability.available && availability.reason}
      </Tabs.Content>
    );
  }

  const View = TAB_VIEWS[kind.id];
  // No `tabIndex`, unlike Radix's default of 0: a click on text in a view
  // would focus this panel, which does not scroll, and the keys would then
  // scroll nothing. Left unfocused, a click focuses the view's own scroller,
  // or leaves the keyboard on the page, where the browser scrolls what was
  // clicked.
  return (
    <Tabs.Content
      key={`${kind.id}:${facts.session.id}`}
      ref={content}
      value={tab}
      forceMount
      hidden={!inFront}
      tabIndex={undefined}
      className="side-panel-tab-content"
    >
      <View facts={facts} close={close} />
    </Tabs.Content>
  );
}
