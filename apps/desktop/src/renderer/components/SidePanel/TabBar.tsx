import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Maximize2, Minimize2, Plus, X } from 'lucide-react';
import { NEW_TAB, type GroupPosition, type TabGroupNode, type TabId } from '../../sidePanel/layout';
import { tabKind, type TabFacts } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { keyboardAfterClose } from './keyboardAfterClose';
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

/** A group's tabs and its "+", then the controls for the group as a whole. */
export function TabBar({ group, position, facts, canMaximize, isMaximized }: TabBarProps) {
  const toggleMaximize = useSidePanelStore((state) => state.toggleMaximize);
  const closeGroup = useSidePanelStore((state) => state.closeGroup);
  const addPlaceholder = useSidePanelStore((state) => state.addPlaceholder);

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
      <div className="side-panel-tab-bar">
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
          <BarButton label="Close group" onClick={() => closeGroup(group.id)}>
            <X size={14} />
          </BarButton>
        </div>
      </div>
    </Tooltip.Provider>
  );
}

/**
 * One tab: its trigger, and a close button beside it rather than inside, so
 * the trigger stays a plain tab for the keyboard, all inside the tab's menu.
 * A tab id the registry does not list has nothing to show; the placeholder
 * still gets its name, so it can be closed. A kind's mark is drawn on its tab
 * while the tab is behind another: in front, its view is showing what the
 * mark is about.
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
  const kind = tabKind(tab);
  if (!kind && tab !== NEW_TAB) return null;

  const title = kind ? kind.title(facts) : 'New tab';
  const marked = mark !== null && !inFront;
  const label = kind?.tabTitle?.(facts) ?? title;
  const Icon = kind?.icon;
  const close = () => closeTab(groupId, tab);

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
      <div className={`side-panel-tab${inFront ? ' active' : ''}`}>
        <Tabs.Trigger
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
          // A press that opens the tab's menu (the right button, or Ctrl on
          // macOS) leaves the keyboard where it was, as the trigger's does.
          onMouseDown={(event) => {
            if (event.button !== 0 || event.ctrlKey) event.preventDefault();
          }}
          onClick={close}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </TabMenu>
  );
}

function BarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className="side-panel-bar-button"
          aria-label={label}
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
