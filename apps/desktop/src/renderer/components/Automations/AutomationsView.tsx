import { useEffect, useId, useRef } from 'react';
import { ExternalLink, Plus, Zap } from 'lucide-react';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore, type AutomationsTab } from '../../stores/automationsStore';
import type { Workspace } from '../../stores/workspaceStore';
import { ActivityTab } from './ActivityTab';
import { AutomationsTab as AutomationsList } from './AutomationsTab';
import { SidePanel } from './SidePanel';
import { TemplatesTab } from './TemplatesTab';
import { useIntent } from './parts';
import './styles.css';

interface AutomationsViewProps {
  workspace: Workspace;
}

const TABS: ReadonlyArray<{ id: AutomationsTab; label: string }> = [
  { id: 'activity', label: 'Activity' },
  { id: 'automations', label: 'Automations' },
  { id: 'templates', label: 'Templates' },
];

/**
 * The workspace's automations, over the session pane: a header that is the
 * window's title bar, the three tabs, and the side panel that opens over
 * them. The file stays the source of truth — "Open factory.yml" hands it to
 * the person's editor — and everything here is an intent sent to main.
 */
export function AutomationsView({ workspace }: AutomationsViewProps) {
  const panelId = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const snapshot = useAutomationsStore((state) => state.snapshots[workspace.id]);
  const tab = useAutomationsStore((state) => state.tab);
  const setTab = useAutomationsStore((state) => state.setTab);
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const panel = useAutomationsStore((state) => state.panel);
  const { busy, error, act } = useIntent();

  // The sidebar row loads it too, but a notification can open this with the sidebar hidden.
  useEffect(() => {
    void useAutomationsStore.getState().load(workspace.id);
  }, [workspace.id]);

  // The tablist pattern with automatic activation, as the Inbox's views.
  const handleTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  };

  return (
    <section className="automations-view" aria-label="Automations">
      <header className="automations-header">
        <Zap size={16} className="automations-header-icon" aria-hidden="true" />
        <h1 className="automations-title">Automations · {workspace.name}</h1>
        <div className="automations-header-actions">
          <button
            type="button"
            className="dialog-button-secondary automations-small-button"
            onClick={() => void act('open', () => automationsBridge.openFile(workspace.id))}
            disabled={busy === 'open'}
          >
            <ExternalLink size={13} />
            Open factory.yml
          </button>
          <button
            type="button"
            className="dialog-button-primary automations-small-button"
            onClick={() => openPanel({ kind: 'new' })}
          >
            <Plus size={13} />
            New automation
          </button>
        </div>
      </header>
      {error && <div className="automations-error automations-header-error" role="alert">{error}</div>}

      <div className="automations-tabs" role="tablist" aria-label="Automations views">
        {TABS.map(({ id, label }, index) => (
          <button
            key={id}
            ref={(element) => {
              tabRefs.current[id] = element;
            }}
            type="button"
            role="tab"
            id={`${panelId}-tab-${id}`}
            aria-controls={panelId}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={`automations-tab ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
            onKeyDown={(event) => handleTabKey(event, index)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Where the side panel opens, over whichever tab is showing. */}
      <div className="automations-body">
        <div className="automations-tabpanel" role="tabpanel" id={panelId} aria-labelledby={`${panelId}-tab-${tab}`}>
          {/* Keyed: one workspace's search and filter are not another's. */}
          {snapshot && tab === 'activity' && <ActivityTab key={workspace.id} workspace={workspace} snapshot={snapshot} />}
          {snapshot && tab === 'automations' && (
            <AutomationsList key={workspace.id} workspace={workspace} snapshot={snapshot} />
          )}
          {snapshot && tab === 'templates' && (
            <TemplatesTab key={workspace.id} workspace={workspace} snapshot={snapshot} />
          )}
        </div>
        {panel && <SidePanel workspace={workspace} panel={panel} />}
      </div>
    </section>
  );
}
