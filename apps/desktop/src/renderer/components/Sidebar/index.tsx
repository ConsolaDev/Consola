import { useEffect, useRef, useState } from 'react';
import { GitPullRequest, Home, Inbox } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useAttentionStore } from '../../stores/attentionStore';
import { useInboxStore } from '../../stores/inboxStore';
import { isShelfOpen, useSettingsStore } from '../../stores/settingsStore';
import { filteredScope, useHomeStore } from '../../stores/homeStore';
import { listedSessions } from '../../../shared/workspace';
import { itemsForView } from '../../../shared/inboxViews';
import { PROVIDER_META } from '../../../shared/providers';
import type { AttentionState } from '../../../shared/attention';
import { AssistantNavItem } from './AssistantNavItem';
import { AutomationsNavItem } from './AutomationsNavItem';
import { FilterBar } from './FilterBar';
import { useSessionFilterStore } from '../../stores/sessionFilterStore';
import { effectiveFilters, hasActiveFilters, matchesFilters } from '../../utils/sessionFilters';
import { SidebarSearch } from './SidebarSearch';
import { NavigationSettings } from './NavigationSettings';
import { NewMenu } from '../Layout/NewMenu';
import { clearAllFilters, revealSessionScope } from '../../utils/sessionActions';
import { useSettleOnChange } from '../../hooks/useSettleOnChange';
import { addScopeViaDialog } from '../../utils/scopeActions';
import { WORKING_SHELF_SHORTCUT_LABEL } from '../../utils/platform';
import { bucketize, type Bucket } from '../../sidebar/bucketize';
import { runEntries, sessionEntries, sessionKey, filterSelection } from '../../sidebar/entries';
import type { EntryKey } from '../../sidebar/entry';
import { applyFilter } from '../../sidebar/filter';
import { buildForest, type TreeNode } from '../../sidebar/forest';
import { leafCount, visibleNodes } from '../../sidebar/fold';
import { applyHold, holdFor, type Hold } from '../../sidebar/openRowHold';
import { settleOffer } from '../../sidebar/settleRules';
import { viewedSessionId } from '../../utils/viewing';
import { entryRow } from '../../sidebar/rowRegistry';
import { useAutomationsStore } from '../../stores/automationsStore';
import { ShelfHeader } from './rows/ShelfHeader';
import { TreeRow } from './rows/TreeRow';
import { useRevealWorking } from './useRevealWorking';
import './styles.css';

const NO_RUNS: never[] = [];

export function Sidebar() {
  const isSidebarHidden = useNavigationStore(state => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore(state => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore(state => state.activeSessionId);
  const overlay = useNavigationStore(state => state.overlay);
  const isInbox = overlay === 'inbox';
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const records = useAttentionStore(state => state.records);
  const derived = useAttentionStore(state => state.attention);
  const runs = useAutomationsStore(state => state.snapshots[activeWorkspaceId ?? '']?.runs) ?? NO_RUNS;
  const shelves = useSettingsStore(state => state.sidebarShelfOpen);
  const toggleShelf = useSettingsStore(state => state.toggleSidebarShelf);
  const workspace = workspaces.find(candidate => candidate.id === activeWorkspaceId);
  const filterId = useHomeStore(state => state.scopeFilters[activeWorkspaceId ?? '']);
  const facetSelection = useSessionFilterStore(state => state.filters[activeWorkspaceId ?? '']);
  const [scopeError, setScopeError] = useState('');
  const inboxCount = useInboxStore(state => workspace ? itemsForView(state.snapshots[workspace.id]?.items ?? [], 'inbox').length : 0);
  const providerAccount = workspace?.provider?.accountLogin;
  // The open row holds the bucket it was opened from until something else is opened.
  const held = useRef<{ activeKey: EntryKey | null; hold: Hold | null }>({ activeKey: null, hold: null });

  useEffect(() => {
    if (workspace && providerAccount) void useInboxStore.getState().load(workspace.id);
  }, [workspace?.id, providerAccount]);

  // Activation (palette, notification, restored window) reveals the session:
  // a filter that would hide it follows it. Unrelated workspace writes never
  // reset a filter.
  useEffect(() => {
    const current = useWorkspaceStore.getState().workspaces.find(candidate => candidate.id === activeWorkspaceId);
    const session = current?.sessions.find(candidate => candidate.id === activeSessionId);
    // The Assistant belongs to no scope the filter could show.
    if (!current || !session || session.kind === 'assistant') return;
    revealSessionScope(current.id, session.id);
    // Facet filters follow an activated session the same way: one that would
    // hide it is cleared rather than leaving the open session out of its list.
    const listed = listedSessions(current).filter(candidate => candidate.name.length > 0);
    const facets = effectiveFilters(current, listed, useSessionFilterStore.getState().filters[current.id]);
    if (hasActiveFilters(facets) && !matchesFilters(session, facets)) useSessionFilterStore.getState().clear(current.id);
  }, [activeWorkspaceId, activeSessionId]);

  // A changed filter settles the list in, so it reads as a new list rather
  // than a flicker.
  const scope = workspace && filteredScope(workspace, filterId);
  const sessionPanelRef = useRef<HTMLDivElement>(null);
  useSettleOnChange(sessionPanelRef, scope?.id ?? 'all', { rise: 4 });

  const allSessions = workspace ? listedSessions(workspace).filter(session => session.name.length > 0) : [];
  const facets = workspace ? effectiveFilters(workspace, allSessions, facetSelection) : {};
  // Filter -> entries -> narrow -> trees -> buckets. A filter only decides which
  // entries survive; placement is bucketize's alone.
  const entriesAt = (attention: AttentionState['attention']) => workspace
    ? [...sessionEntries(allSessions, { records, attention }, workspace.labels), ...runEntries(runs, { attention })]
    : [];
  const { entries: shown, hiddenNeedingYou } = applyFilter(entriesAt(derived), filterSelection(scope?.id, facets));
  // Before the early return: a hidden sidebar is the one a starting turn most
  // needs to bring back.
  useRevealWorking(derived, shown, entriesAt);

  if (isSidebarHidden) return null;

  const natural = bucketize(buildForest(shown));

  const activeKey = workspace && activeSessionId && allSessions.some(session => session.id === activeSessionId)
    ? sessionKey(activeSessionId) : null;
  // The row this window is showing is never offered Settle: it would bounce
  // back the moment its CLI paints. The same rule main is told, overlay and
  // all, so one definition decides both.
  const viewedKey = viewedSessionId({ activeSessionId, overlay }) !== null ? activeKey : null;
  if (held.current.activeKey !== activeKey) held.current = { activeKey, hold: holdFor(natural, activeKey) };
  const placed = applyHold(natural, held.current.hold);

  const workingOpen = isShelfOpen(shelves, 'working');
  const settledOpen = isShelfOpen(shelves, 'settled');

  const addFirstScope = async (workspaceId: string) => {
    setScopeError('');
    try { await addScopeViaDialog(workspaceId); }
    catch (reason) { setScopeError(reason instanceof Error ? reason.message : String(reason)); }
  };
  // The list can be empty because nothing exists yet or because a filter hides
  // everything. Say which, and offer the way back to everything.
  const emptyMessage = () => {
    if (!workspace?.scopes.length) {
      return <><button type="button" className="sidebar-empty-link" onClick={() => void addFirstScope(workspace!.id)}>Add a scope</button>
        {' '}to start a session.</>;
    }
    if (!allSessions.length) return scope ? `Sessions you start in ${scope.name} appear here.` : 'Sessions you start appear here.';
    if (scope && !hasActiveFilters(facets)) {
      return <>Nothing in {scope.name} yet.{' '}
        <button type="button" className="sidebar-empty-link" onClick={() => clearAllFilters(workspace.id)}>Show all scopes</button></>;
    }
    return <>No sessions match these filters.{' '}
      <button type="button" className="sidebar-empty-link" onClick={() => clearAllFilters(workspace.id)}>Clear filters</button></>;
  };

  // One tree is a conductor and its children; anything else is a single row.
  // The row for each entry comes from the registry, so this names no kind.
  const renderNode = (node: TreeNode, bucket: Bucket) => {
    const highlightActive = overlay === null;
    if (node.children.length > 0) {
      return <TreeRow key={node.entry.key} node={node} bucket={bucket} workspaceId={workspace!.id}
        activeKey={activeKey} viewedKey={viewedKey} highlightActive={highlightActive} />;
    }
    return entryRow(node.entry, { workspaceId: workspace!.id, active: highlightActive && node.entry.key === activeKey, settle: settleOffer(node, false, viewedKey), bucket });
  };
  const list = (nodes: TreeNode[], bucket: Bucket) => nodes.map(node => renderNode(node, bucket));

  return (
    <aside className="sidebar" aria-label={isInbox ? 'Inbox sidebar' : 'Home sidebar'}>
      <SidebarSearch><NavigationSettings /><NewMenu /></SidebarSearch>
      <nav className="app-navigation" aria-label="Main navigation">
        <button className={`app-navigation-item ${!isInbox ? 'active' : ''}`} aria-label="Home" title="Home" aria-current={overlay === null ? 'page' : undefined}
          onClick={() => useNavigationStore.getState().setActiveSession(activeSessionId)}><Home size={18} /><span className="app-navigation-label">Home</span></button>
        {workspace && <button className={`app-navigation-item ${isInbox ? 'active' : ''}`} aria-label="Inbox" title="Inbox" aria-current={isInbox ? 'page' : undefined}
          onClick={() => useNavigationStore.getState().openInbox()}><Inbox size={18} /><span className="app-navigation-label">Inbox</span>{workspace.provider && inboxCount > 0 && <span className="app-navigation-badge">{inboxCount}</span>}</button>}
      </nav>
      {workspace && isInbox && <div className="home-navigation">
        <div className="home-session-panel">
          <section className="sidebar-section sidebar-integrations" aria-label="Integrations">
            <div className="sidebar-section-header"><span className="sidebar-section-title">Integrations</span></div>
            <button className="sidebar-inbox-row active" aria-current="page" onClick={() => useNavigationStore.getState().openInbox()}>
              <GitPullRequest size={14} aria-hidden="true" />
              <span className="sidebar-inbox-name">{PROVIDER_META.github.displayName}</span>
              {!workspace.provider ? <span className="sidebar-inbox-count">Set up</span> : inboxCount > 0 && <span className="sidebar-inbox-count">{inboxCount}</span>}
            </button>
          </section>
        </div>
      </div>}
      {workspace && !isInbox && <div className="home-navigation">
        <AssistantNavItem workspace={workspace} />
        <AutomationsNavItem workspace={workspace} />
        {/* Always there, even with one scope: it is also where scopes are added. */}
        <hr className="sidebar-scope-divider" />
        <FilterBar workspace={workspace} />
        <div ref={sessionPanelRef} className="home-session-panel sidebar-sessions">
          {hiddenNeedingYou > 0 && <button type="button" className="sidebar-hidden-chip" onClick={() => clearAllFilters(workspace.id)}
            title="Clear filters">
            {hiddenNeedingYou} hidden by filter {hiddenNeedingYou === 1 ? 'needs' : 'need'} you
          </button>}
          {!shown.length && <p className="sidebar-empty">{emptyMessage()}</p>}
          {scopeError && <p className="sidebar-error" role="alert">{scopeError}</p>}
          {/* Everything in play that is not running, first and under no
              heading: questions, unread results, idle prompts, exited
              processes (`bucketize`). Each row says which in a word, and
              none of them can be folded away. */}
          {placed.waiting.length > 0 && <div className="sidebar-bucket sidebar-bucket--waiting">
            <nav className="session-list" aria-label="Sessions">
              {list(placed.waiting, 'waiting')}
            </nav>
          </div>}
        </div>
        {/* Pinned to the bottom of the sidebar, outside the scrolling panel,
            so the sessions waiting on the person fill the space above however
            many are running or were put away. */}
        {shown.length > 0 && <div className="sidebar-dock">
          {/* Only while something is in it, right above Settled. A session
              starting work opens it (`useRevealWorking`); collapsed, it keeps
              only the tree the person has open. */}
          {placed.working.length > 0 && <section className="sidebar-bucket sidebar-bucket--working" aria-label="Working">
            <ShelfHeader title="Working" count={leafCount(placed.working)} open={workingOpen}
              onToggle={() => toggleShelf('working')} shortcutHint={WORKING_SHELF_SHORTCUT_LABEL} />
            <nav className="session-list" aria-label="Working sessions">
              {list(visibleNodes(placed.working, !workingOpen, activeKey), 'working')}
            </nav>
          </section>}
          {/* Only what was put away, by hand or after sitting idle (see
              AutoSettler). Nothing is deleted. */}
          <section className="sidebar-bucket sidebar-bucket--settled" aria-label="Settled">
            <ShelfHeader title="Settled" count={leafCount(placed.settled)} open={settledOpen} onToggle={() => toggleShelf('settled')} />
            <nav className="session-list" aria-label="Settled sessions">
              {list(visibleNodes(placed.settled, !settledOpen, activeKey), 'settled')}
            </nav>
          </section>
        </div>}
      </div>}
    </aside>
  );
}
