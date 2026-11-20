import { Fragment } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { groupPosition, groupsOf, visibleGroups } from '../../sidePanel/layout';
import type { TabFacts } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { TabGroup } from './TabGroup';
import './styles.css';

/**
 * The side panel beside a session's conversation: its groups of tabs, side
 * by side or stacked. The `Group` is rendered even for one group, and each
 * panel is keyed by its group's id, so splitting and unsplitting never
 * remount a group that survives the change.
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

  return (
    <aside aria-label="Side panel" className="side-panel">
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
    </aside>
  );
}
