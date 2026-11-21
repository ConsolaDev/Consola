import { Fragment, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  type Active,
  type Announcements,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  MouseSensor,
  useDndContext,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { type DraggedTab, type DropZone, splitEdge } from '../../sidePanel/dropTarget';
import { groupPosition, groupsOf, type TabId, visibleGroups } from '../../sidePanel/layout';
import { tabKind, type TabFacts } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { dragPointer, pointerWithinNoted } from './dragPointer';
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

  /**
   * A drag is the pointer's, so the keyboard goes back to where it was before
   * the press. When that place went with the drop (the tab's own content,
   * remounted in another group), or is out of sight or will not take it, it
   * goes to the tab, in the bar it is in now.
   *
   * Out of sight is asked first: a page the drop sent behind another tab is
   * still connected, only not drawn, and a `<webview>`'s own `focus()` takes
   * the keyboard into it all the same, `display: none` or `inert`.
   */
  const giveKeyboardBack = (tab: TabId) => {
    const before = keyboardBefore.current;
    keyboardBefore.current = null;
    requestAnimationFrame(() => {
      const back =
        before instanceof HTMLElement &&
        before !== document.body &&
        before.checkVisibility() &&
        !before.closest('[inert]')
          ? before
          : null;
      back?.focus();
      if (back === null || document.activeElement !== back) focusTrigger(tab);
    });
  };

  // A drag whose tab was closed on the way has nothing to drop, and the close
  // has already placed the keyboard, so its end and its cancel leave both be.
  const drop = ({ active, over }: DragEndEvent) => {
    const tab = draggedTabOf(active);
    if (tab === undefined) return;
    const zone = over?.data.current as DropZone | undefined;
    const pointer = dragPointer();
    const store = useSidePanelStore.getState();
    if (over && zone && pointer) {
      if (zone.part === 'bar') {
        const place = zone.placeAt(tab, pointer.x);
        if (place) store.moveTab(tab, zone.groupId, place.index);
      } else {
        const edge = splitEdge(store.layout, zone.groupId, tab, over.rect, pointer);
        if (edge) store.splitWithTab(zone.groupId, tab, edge);
      }
    }
    giveKeyboardBack(tab);
  };

  // Said by the tab's title, rather than dnd-kit's ids.
  const titleOf = (active: Active) => {
    const tab = draggedTabOf(active);
    return (tab !== undefined && tabKind(tab)?.title(facts)) || 'tab';
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
        // The zone under the pointer, and the pointer it was found at, which
        // the caret, the drop target and the drop read (`dragPointer`).
        collisionDetection={pointerWithinNoted}
        // No box scrolls by itself during a drag, so the tabs stay where the
        // person aims.
        autoScroll={false}
        accessibility={{ announcements }}
        onDragEnd={drop}
        onDragCancel={({ active }) => {
          const tab = draggedTabOf(active);
          if (tab !== undefined) giveKeyboardBack(tab);
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
        <KeyboardWhileDragging />
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
 * What a drag does to the keyboard while dnd-kit has it under way, read from
 * dnd-kit's rendered state rather than its callbacks. A drag released before
 * dnd-kit renders its start (a flick, or a click that slipped past the 6px)
 * ends with neither `onDragEnd` nor `onDragCancel`, but it never shows as
 * under way here either, so nothing is held for it, and the press leaves the
 * keyboard where a click would.
 *
 * - A page with the keyboard keeps its own keys, which never reach this
 *   window, so Escape typed there could not cancel the drag. A drag begun
 *   from a ✕, whose press leaves the keyboard where it was, takes it from a
 *   page to the dragged tab, as a press on the tab itself does; the drag
 *   gives it back when it is over (`giveKeyboardBack`).
 * - Escape cancels the drag, and nothing else hears it (`escapeCancelsDrag`).
 *
 * Both follow the drag's id, which lasts as long as the drag. Its tab can go
 * first (`draggedTabOf`), and is read only for the keyboard's move at the start.
 */
function KeyboardWhileDragging() {
  const { active } = useDndContext();
  const id = active?.id;
  const tab = draggedTabOf(active);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the drag's id is the trigger; its tab is read once, at the start
  useEffect(() => {
    if (id === undefined) return undefined;
    const focused = document.activeElement;
    const inPage = focused?.tagName === 'WEBVIEW' || !!focused?.closest('.browser-host');
    if (tab !== undefined && inPage) focusTrigger(tab);
    return escapeCancelsDrag();
  }, [id]);
  return null;
}

/**
 * The tab a drag carries. Closing a tab while it is dragged (Delete on the
 * trigger its press focused) unmounts its draggable, and dnd-kit then gives
 * the drag, still under way, empty data: from there on it carries no tab.
 */
function draggedTabOf(active: Active | null): TabId | undefined {
  return (active?.data.current as Partial<DraggedTab> | undefined)?.tab;
}

/**
 * While a tab is dragged, Escape cancels the drag and reaches nothing else,
 * wherever the keyboard is: not the conversation's terminal, where it would
 * interrupt Claude, nor a shell, nor anything else in the window. It is taken
 * on the window's capture, ahead of them all, and the drag is cancelled with
 * dnd-kit's own key, sent to the document alone, where its sensor listens and
 * no element does. The held key's repeats stop there too.
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
