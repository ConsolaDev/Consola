// src/renderer/components/Inbox/index.tsx
import { useEffect, useId, useMemo, useState } from 'react';
import {
  DEFAULT_COLLAPSED_SECTIONS,
  INBOX_SECTIONS,
  type InboxSection,
} from '../../../shared/inboxSections';
import { INBOX_VIEWS, groupBySection, itemsForView, type InboxViewId } from '../../../shared/inboxViews';
import { PROVIDER_META } from '../../../shared/providers';
import type { InboxItem } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';
import { useInboxStore } from '../../stores/inboxStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTerminalStore } from '../../stores/terminalStore';
import type { Workspace } from '../../stores/workspaceStore';
import { CloneDialog } from './CloneDialog';
import { InboxHeader } from './InboxHeader';
import { InboxItemPane } from './InboxItemPane';
import { InboxRow } from './InboxRow';
import { InboxSectionGroup } from './InboxSectionGroup';
import { ViewTabs } from './ViewTabs';
import { filterByRepos, filterByUpdated, reposInSnapshot } from './inboxFilters';
import { groupSessionsByWorkItem, isRepoCloned } from './inboxPresentation';
import './styles.css';

interface InboxViewProps {
  workspace: Workspace;
}

const NO_ITEMS: InboxItem[] = [];

const SECTION_LABELS = Object.fromEntries(
  INBOX_SECTIONS.map(({ id, label }) => [id, label])
) as Record<InboxSection, string>;

/**
 * GitHub's PR inbox, in Consola (mockup inbox-layout option B, inbox-views
 * option 2): header, the five views as tabs, then sections or a flat list
 * on the left and the selected item's pane on the right. Remote-driven and
 * read-only against the provider -- the only verbs live in the pane, and
 * every one of them creates or opens a local session.
 *
 * State that is this view's alone: which view, which item is selected,
 * and which sections are folded (per workspace, never persisted). Filters
 * live in the settings store because they survive relaunch.
 */
export function InboxView({ workspace }: InboxViewProps) {
  // Shared between the tab strip and the panel below it, so each tab's own
  // id and the panel's aria-labelledby agree on the same generated string.
  const panelId = useId();
  const [view, setView] = useState<InboxViewId>('inbox');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Keyed by workspace id: MainContent keeps this component mounted across
  // a workspace switch, and one workspace's folded sections are not another's.
  const [collapsedByWorkspace, setCollapsedByWorkspace] = useState<
    Record<string, ReadonlySet<InboxSection>>
  >({});

  const snapshot = useInboxStore((state) => state.snapshots[workspace.id]);
  const resolvedRepos = useInboxStore((state) => state.resolvedRepos[workspace.id]);
  const refresh = useInboxStore((state) => state.refresh);
  const terminals = useTerminalStore((state) => state.terminals);
  const filter = useSettingsStore((state) => state.inboxFilterFor(workspace.id));
  const setInboxRepoFilter = useSettingsStore((state) => state.setInboxRepoFilter);
  const setInboxUpdatedFilter = useSettingsStore((state) => state.setInboxUpdatedFilter);

  useEffect(() => {
    void useInboxStore.getState().load(workspace.id);
    // A different workspace's snapshot has its own keys; carrying a
    // selection across would risk landing on an unrelated item that
    // happens to share a repo/number with one in the workspace just left.
    setSelectedKey(null);
  }, [workspace.id]);

  const items = snapshot?.items ?? NO_ITEMS;
  const repos = useMemo(() => reposInSnapshot(items), [items]);

  // A persisted repo selection can name repos that have since left the
  // inbox (merged, archived, org changed). Clamp it once a snapshot has
  // something to clamp against, so the menu never shows a tick for a repo
  // it does not list and the filter never silently hides everything.
  useEffect(() => {
    if (items.length === 0) return;
    const present = new Set(repos);
    const kept = filter.repos.filter((repo) => present.has(repo));
    if (kept.length !== filter.repos.length) setInboxRepoFilter(workspace.id, kept);
  }, [workspace.id, items, repos, filter.repos, setInboxRepoFilter]);

  const filtered = useMemo(
    () => filterByRepos(filterByUpdated(items, filter.updated), filter.repos),
    [items, filter.updated, filter.repos]
  );
  const counts = useMemo(() => {
    const result = {} as Record<InboxViewId, number>;
    for (const { id } of INBOX_VIEWS) result[id] = itemsForView(filtered, id).length;
    return result;
  }, [filtered]);
  const shown = useMemo(() => itemsForView(filtered, view), [filtered, view]);
  const sections = useMemo(() => groupBySection(shown), [shown]);
  const sessionsByItem = useMemo(
    () => groupSessionsByWorkItem(workspace.sessions),
    [workspace.sessions]
  );

  // Selection is a key, not an item: the snapshot behind it refreshes every
  // few minutes, and the pane must show the fresh facts. An item that left
  // the snapshot simply has no pane any more.
  const selected = selectedKey
    ? items.find((item) => workItemKey(item.workItem) === selectedKey)
    : undefined;

  // A refresh can drop the selected item from the snapshot entirely (PR
  // merged, issue closed) without ever clearing selectedKey. Once that
  // key no longer resolves to anything shown, drop it -- otherwise a later
  // refresh that resurrects a same-numbered item would reopen the pane on
  // a selection the user never made.
  useEffect(() => {
    if (selectedKey && !selected) setSelectedKey(null);
  }, [selected, selectedKey]);

  // Esc closes the pane. The Inbox defers to ANY open dialog, without
  // requiring dialogs to opt in: CloneDialog and LinkSessionDialog also
  // stopPropagation on their own Esc, but WorkspaceSettingsModal and its
  // ConfirmDialog can sit above the Inbox too and never wired that up, so
  // this listener checks for an open Radix dialog itself rather than
  // trusting every future dialog to remember the contract.
  useEffect(() => {
    if (!selectedKey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      setSelectedKey(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedKey]);

  const collapsed = collapsedByWorkspace[workspace.id] ?? DEFAULT_COLLAPSED_SECTIONS;
  const toggleSection = (section: InboxSection) => {
    setCollapsedByWorkspace((previous) => {
      const current = previous[workspace.id] ?? DEFAULT_COLLAPSED_SECTIONS;
      const next = new Set(current);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return { ...previous, [workspace.id]: next };
    });
  };

  const selectItem = (item: InboxItem) => {
    const key = workItemKey(item.workItem);
    setSelectedKey((current) => (current === key ? null : key));
  };

  const provider = workspace.provider;
  if (!provider) return null;
  const providerName = PROVIDER_META[provider.id].displayName;

  return (
    <div className="inbox-view">
      <InboxHeader
        workspace={workspace}
        provider={provider}
        snapshot={snapshot}
        repos={repos}
        filter={filter}
        onReposChange={(next) => setInboxRepoFilter(workspace.id, next)}
        onUpdatedChange={(next) => setInboxUpdatedFilter(workspace.id, next)}
        onRefresh={() => void refresh(workspace.id)}
      />
      <ViewTabs active={view} counts={counts} onSelect={setView} panelId={panelId} />
      <div className="inbox-body">
        <div
          className="inbox-main"
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${panelId}-tab-${view}`}
        >
          {!snapshot && <p className="inbox-empty">Fetching from {providerName}...</p>}
          {snapshot &&
            view === 'inbox' &&
            sections.map(({ section, items: sectionItems }) => (
              <InboxSectionGroup
                key={section}
                section={section}
                label={SECTION_LABELS[section]}
                items={sectionItems}
                collapsed={collapsed.has(section)}
                onToggle={() => toggleSection(section)}
                sessionsByItem={sessionsByItem}
                terminals={terminals}
                resolvedRepos={resolvedRepos}
                selectedKey={selectedKey}
                onSelectItem={selectItem}
              />
            ))}
          {snapshot && view !== 'inbox' && shown.length === 0 && (
            <p className="inbox-empty">Nothing here right now.</p>
          )}
          {snapshot && view !== 'inbox' && shown.length > 0 && (
            <div className="inbox-list">
              {shown.map((item) => {
                const key = workItemKey(item.workItem);
                return (
                  <InboxRow
                    key={key}
                    item={item}
                    sessions={sessionsByItem.get(key) ?? []}
                    terminals={terminals}
                    cloned={isRepoCloned(resolvedRepos, item.workItem.repo)}
                    selected={selectedKey === key}
                    onSelect={selectItem}
                  />
                );
              })}
            </div>
          )}
        </div>
        {selected && (
          // A plain div, not a landmark: InboxItemPane's own <aside
          // aria-label="Work item details"> is the complementary region --
          // wrapping it in a second, unnamed one would nest two landmarks
          // for one piece of content. Keyed by item so the pane's confirm
          // and custom-prompt state never carries over when selection moves
          // to a different item.
          <div className="inbox-pane-slot">
            <InboxItemPane
              key={workItemKey(selected.workItem)}
              workspace={workspace}
              item={selected}
              onClose={() => setSelectedKey(null)}
            />
          </div>
        )}
      </div>
      <CloneDialog />
    </div>
  );
}
