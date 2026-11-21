import { Fragment, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  type Active,
  type Announcements,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { type DraggedTab, type DropZone, pointerAt, splitEdge } from '../../sidePanel/dropTarget';
import { groupPosition, groupsOf, type TabId, visibleGroups } from '../../sidePanel/layout';
import { tabKind, type TabFacts } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { focusTrigger, swallowHeldKeyRepeats } from './keyboardAfterClose';
import { DraggedTabPreview } from './TabBar';
import { TabGroup } from './TabGroup';
import './styles.css';

/**
 * The side panel beside a session's conversation: its groups of tabs, side
 * by side or stacked. The `Group` is rendered even for one group, and each
 * panel is keyed by its group's id, so splitting and unsplitting never
 * remount a group that survives the change.
 *
 * Tabs are dragged with the pointer: along a bar, onto the other group's bar,
 * or to an edge of their group's content to split it. Nothing in the layout
 * changes until the drop, so no tab's view moves or re-renders while the
 * pointer does; only the caret and the drop target follow it. There is no
 * keyboard sensor: the tab menu is the keyboard's way to move a tab.
 */
export function SidePanel({ facts }: { facts: TabFacts }) {
  const layout = useSidePanelStore((state) => state.layout);
  const groups = visibleGroups(layout);
  const total = groupsOf(layout).length;
  const stacked = layout.root.type === 'split' && layout.root.orientation === 'stacked';
  const orientation = stacked ? 'vertical' : 'horizontal';
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `side-panel-groups-${orientation}`,
    panelIds: groups.map((group) => `side-group-${group.id}`),
    storage: localStorage,
  });
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }));
  // Where the keyboard was before the press that began a drag: the press
  // itself moves it onto the tab.
  const keyboardBefore = useRef<Element | null>(null);
  // Ends Escape's hold on the drag under way.
  const releaseEscape = useRef<(() => void) | null>(null);
  const endDrag = () => {
    releaseEscape.current?.();
    releaseEscape.current = null;
  };
  // A panel that goes mid-drag lets go of Escape too.
  useEffect(() => () => releaseEscape.current?.(), []);

  /**
   * A drag is the pointer's, so the keyboard goes back to where it was before
   * the press. When that place went with the drop (the tab's own content,
   * remounted in another group), it goes to the tab, in the bar it is in now.
   */
  const giveKeyboardBack = (tab: TabId) => {
    const before = keyboardBefore.current;
    keyboardBefore.current = null;
    requestAnimationFrame(() => {
      if (before instanceof HTMLElement && before.isConnected && before !== document.body) {
        before.focus();
      } else {
        focusTrigger(tab);
      }
    });
  };

  const drop = ({ active, over, activatorEvent, delta }: DragEndEvent) => {
    endDrag();
    const dragged = active.data.current as DraggedTab | undefined;
    if (!dragged) return;
    const zone = over?.data.current as DropZone | undefined;
    const pointer = pointerAt(activatorEvent, delta);
    const store = useSidePanelStore.getState();
    if (over && zone && pointer) {
      if (zone.part === 'bar') {
        const place = zone.placeAt(dragged.tab, pointer.x);
        if (place) store.moveTab(dragged.tab, zone.groupId, place.index);
      } else {
        const edge = splitEdge(store.layout, zone.groupId, dragged.tab, over.rect, pointer);
        if (edge) store.splitWithTab(zone.groupId, dragged.tab, edge);
      }
    }
    giveKeyboardBack(dragged.tab);
  };

  // Said by the tab's title, rather than dnd-kit's ids.
  const titleOf = (active: Active) => {
    const dragged = active.data.current as DraggedTab | undefined;
    return (dragged && tabKind(dragged.tab)?.title(facts)) ?? 'tab';
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up the ${titleOf(active)} tab.`,
    onDragOver: () => undefined,
    onDragEnd: ({ active }) => `Dropped the ${titleOf(active)} tab.`,
    onDragCancel: ({ active }) => `The ${titleOf(active)} tab was not moved.`,
  };

  return (
    <aside
      aria-label="Side panel"
      className="side-panel"
      onPointerDownCapture={() => {
        keyboardBefore.current = document.activeElement;
      }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        // The pointer is read as where it pressed plus the drag's delta, which
        // a scroll during the drag would move.
        autoScroll={false}
        accessibility={{ announcements }}
        onDragStart={() => {
          releaseEscape.current = escapeCancelsDrag();
        }}
        onDragEnd={drop}
        onDragCancel={({ active }) => {
          endDrag();
          const dragged = active.data.current as DraggedTab | undefined;
          if (dragged) giveKeyboardBack(dragged.tab);
        }}
      >
        <Group
          orientation={orientation}
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          {groups.map((group, index) => (
            <Fragment key={group.id}>
              {index > 0 && (
                <Separator className={stacked ? 'side-panel-split-handle' : 'resize-handle'} />
              )}
              <Panel id={`side-group-${group.id}`} minSize="120px">
                <TabGroup
                  group={group}
                  position={groupPosition(layout, group.id)}
                  facts={facts}
                  canMaximize={total > 1}
                  isMaximized={groups.length < total}
                />
              </Panel>
            </Fragment>
          ))}
        </Group>
        {createPortal(
          <DragOverlay dropAnimation={null}>
            <DraggedTabPreview facts={facts} />
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </aside>
  );
}

/**
 * While a tab is dragged, Escape cancels the drag and reaches nothing else,
 * wherever the keyboard is: not the conversation's terminal, where it would
 * interrupt Claude, nor a shell, nor anything else in the window. It is taken
 * on the window's capture, ahead of them all, and the drag is cancelled with
 * dnd-kit's own key, sent to the document alone, where its sensor listens and
 * no element does. The held key's repeats stop there too. A page with the
 * keyboard keeps its own keys, which never reach this window, so an Escape
 * typed there is the page's, and the drag lasts until the button is let go.
 *
 * Returns what ends the hold, for when the drag is over.
 */
function escapeCancelsDrag(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    swallowHeldKeyRepeats();
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
