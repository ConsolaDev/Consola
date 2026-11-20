import { useCallback } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import type { GroupId, GroupPosition, TabGroupNode, TabId } from '../../sidePanel/layout';
import { bodyFor, tabKind, type TabFacts } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
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
      </div>
    </Tabs.Root>
  );
}

/**
 * What one tab renders, as `bodyFor` decides. A view behind another tab stays
 * mounted but hidden, and is keyed by the session, so it follows the session
 * on screen rather than carrying one session's state into the next. A tab id
 * the registry does not list renders nothing.
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
  const close = useCallback(() => closeTab(groupId, tab), [closeTab, groupId, tab]);
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

  return (
    <Tabs.Content
      key={`${kind.id}:${facts.session.id}`}
      value={tab}
      forceMount
      hidden={!inFront}
      className="side-panel-tab-content"
    >
      {TAB_VIEWS[kind.id]({ facts, close })}
    </Tabs.Content>
  );
}
