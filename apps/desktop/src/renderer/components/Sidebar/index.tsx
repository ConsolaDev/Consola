import { useEffect, useRef, useState } from 'react';
import { CheckCheck, GitPullRequest, Home, Inbox } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useAttentionStore } from '../../stores/attentionStore';
import { useInboxStore } from '../../stores/inboxStore';
import { isShelfOpen, useSettingsStore } from '../../stores/settingsStore';
import { filteredScope, useHomeStore } from '../../stores/homeStore';
import { itemsForView } from '../../../shared/inboxViews';
import { PROVIDER_META } from '../../../shared/providers';
import type { AttentionState } from '../../../shared/attention';
import { AutomationsNavItem } from './AutomationsNavItem';
import { FilterBar } from './FilterBar';
import { useSessionFilterStore } from '../../stores/sessionFilterStore';
import { useRenamingStore } from '../../stores/renamingStore';
import { effectiveFilters, hasActiveFilters, matchesFilters } from '../../utils/sessionFilters';
import { SidebarSearch } from './SidebarSearch';
import { NavigationSettings } from './NavigationSettings';
import { useDensityShift } from './useDensityShift';
import { NewMenu } from '../Layout/NewMenu';
import { clearAllFilters, revealSessionScope } from '../../utils/sessionActions';
import { useSettleOnChange } from '../../hooks/useSettleOnChange';
import { addScopeViaDialog } from '../../utils/scopeActions';
import { WORKING_SHELF_SHORTCUT_LABEL } from '../../utils/platform';
import { bucketize } from '../../sidebar/bucketize';
import type { Bucket } from '../../sidebar/bucketize';
import { runEntries, sessionEntries, sessionKey, filterSelection } from '../../sidebar/entries';
import type { EntryKey } from '../../sidebar/entry';
import { applyFilter } from '../../sidebar/filter';
import { aggregateAttention, buildForest } from '../../sidebar/forest';
import type { TreeNode } from '../../sidebar/forest';
import { leafCount, visibleNodes } from '../../sidebar/fold';
import { holdFor, pinHold } from '../../sidebar/openRowHold';
import type { Hold } from '../../sidebar/openRowHold';
import { settleOffer } from '../../sidebar/settleRules';
import { snoozeOffer } from '../../sidebar/snoozeRules';
import { wakeWithUndo } from '../../utils/snoozeActions';
import { droppedSnoozedSessionId, isSnoozedSessionDrag, leftDropTarget } from './sessionDrag';
import { drawnOrder } from '../../sidebar/selection';
import { SelectionContext } from '../../sidebar/selectionContext';
import type { SelectionFrame } from '../../sidebar/selectionContext';
import { treeView } from '../../sidebar/treeView';
import {
  clearSelection,
  pruneSelected,
  useSessionSelectionStore,
} from '../../stores/sessionSelectionStore';
import { entryRow } from '../../sidebar/rowRegistry';
import { useAutomationsStore } from '../../stores/automationsStore';
import { ShelfHeader } from './rows/ShelfHeader';
import { TreeRow } from './rows/TreeRow';
import { useRevealWorking } from './useRevealWorking';
import { useShiftGuard } from './useShiftGuard';
import { useWorkingObservation } from './useWorkingObservation';
import { BucketMotion } from './BucketMotion';
import { placementOf } from '../../sidebar/departures';
import './styles.css';

const NO_RUNS: never[] = [];

export function Sidebar() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const overlay = useNavigationStore((state) => state.overlay);
  const isInbox = overlay === 'inbox';
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const records = useAttentionStore((state) => state.records);
  const derived = useAttentionStore((state) => state.attention);
  const snoozes = useAttentionStore((state) => state.snoozes);
  /** Whether a row off the Snoozed shelf is being dragged over the list, to wake it. */
  const [wakeDrop, setWakeDrop] = useState(false);
  const selectedCount = useSessionSelectionStore((state) =>
    state.workspaceId === activeWorkspaceId ? state.keys.length : 0,
  );
  // The rows as drawn last render, for selection ranges; kept current below.
  const drawn = useRef<SelectionFrame | null>(null);
  // A selection belongs to the workspace it was made in.
  useEffect(() => clearSelection(), [activeWorkspaceId]);
  // Rows deleted, filtered out or folded away leave the selection, so this
  // runs after every render.
  // oxlint-disable-next-line @nkzw/require-use-effect-arguments -- on purpose, above
  useEffect(() => {
    if (drawn.current) pruneSelected(drawn.current.workspaceId, drawn.current.order);
  });
  const runs =
    useAutomationsStore((state) => state.snapshots[activeWorkspaceId ?? '']?.runs) ?? NO_RUNS;
  const shelves = useSettingsStore((state) => state.sidebarShelfOpen);
  const workingSection = useSettingsStore((state) => state.sidebarWorkingSection);
  const densityShift = useDensityShift(useSettingsStore((state) => state.sidebarDensity));
  const toggleShelf = useSettingsStore((state) => state.toggleSidebarShelf);
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId);
  const filterId = useHomeStore((state) => state.scopeFilters[activeWorkspaceId ?? '']);
  const facetSelection = useSessionFilterStore((state) => state.filters[activeWorkspaceId ?? '']);
  const renamingSessionId = useRenamingStore((state) => state.sessionId);
  const [scopeError, setScopeError] = useState('');
  const inboxCount = useInboxStore((state) =>
    workspace ? itemsForView(state.snapshots[workspace.id]?.items ?? [], 'inbox').length : 0,
  );
  const providerAccount = workspace?.provider?.accountLogin;
  // Where the open row was opened from, until something else is opened or the
  // sections themselves change.
  const held = useRef<{ activeKey: EntryKey | null; workingSection: boolean; hold: Hold | null }>({
    activeKey: null,
    workingSection,
    hold: null,
  });
  // The row being renamed stays exactly where it was when its field opened.
  const pinned = useRef<{ key: EntryKey | null; pin: Hold | null }>({ key: null, pin: null });
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (workspace && providerAccount) void useInboxStore.getState().load(workspace.id);
  }, [workspace?.id, providerAccount]);

  // Activation (palette, notification, restored window) reveals the session:
  // a filter that would hide it follows it. Unrelated workspace writes never
  // reset a filter.
  useEffect(() => {
    const current = useWorkspaceStore
      .getState()
      .workspaces.find((candidate) => candidate.id === activeWorkspaceId);
    const session = current?.sessions.find((candidate) => candidate.id === activeSessionId);
    if (!current || !session) return;
    revealSessionScope(current.id, session.id);
    // Facet filters follow an activated session the same way: one that would
    // hide it is cleared rather than leaving the open session out of its list.
    const listed = current.sessions.filter((candidate) => candidate.name.length > 0);
    const facets = effectiveFilters(
      current,
      listed,
      useSessionFilterStore.getState().filters[current.id],
    );
    if (hasActiveFilters(facets) && !matchesFilters(session, facets)) {
      useSessionFilterStore.getState().clear(current.id);
    }
  }, [activeWorkspaceId, activeSessionId]);

  // A changed filter settles the list in, so it reads as a new list rather
  // than a flicker.
  const scope = workspace && filteredScope(workspace, filterId);
  const sessionPanelRef = useRef<HTMLDivElement>(null);
  useSettleOnChange(sessionPanelRef, scope?.id ?? 'all', { rise: 4 });

  const allSessions = workspace
    ? workspace.sessions.filter((session) => session.name.length > 0)
    : [];
  const facets = workspace ? effectiveFilters(workspace, allSessions, facetSelection) : {};
  // Filter -> entries -> narrow -> trees -> buckets. A filter only decides which
  // entries survive; placement is bucketize's alone.
  const entriesAt = (attention: AttentionState['attention']) =>
    workspace
      ? [
          ...sessionEntries(allSessions, { records, attention, snoozes }, workspace.labels),
          ...runEntries(runs, { attention }),
        ]
      : [];
  const everything = entriesAt(derived);
  const { entries: shown, hiddenNeedingYou } = applyFilter(
    everything,
    filterSelection(scope?.id, facets),
  );
  // Before the early return: a hidden sidebar is the one a starting turn most
  // needs to bring back, and what runs while it is hidden still happened.
  useRevealWorking(derived, shown, entriesAt);
  const observed = useWorkingObservation(workspace?.id, buildForest(everything));
  useShiftGuard(sidebarRef);

  if (isSidebarHidden) return null;

  const natural = bucketize(buildForest(shown), { workingSection, observed });

  const activeKey =
    workspace && activeSessionId && allSessions.some((session) => session.id === activeSessionId)
      ? sessionKey(activeSessionId)
      : null;
  if (held.current.activeKey !== activeKey || held.current.workingSection !== workingSection) {
    held.current = { activeKey, workingSection, hold: holdFor(natural, activeKey) };
  }
  // A row whose name is being edited stays exactly where it was when the field
  // opened: moving it would remount it and lose the field (see pinHold).
  const renamingKey =
    renamingSessionId && allSessions.some((session) => session.id === renamingSessionId)
      ? sessionKey(renamingSessionId)
      : null;
  if (pinned.current.key !== renamingKey) {
    pinned.current = { key: renamingKey, pin: holdFor(natural, renamingKey) };
  }
  const placed = pinHold(natural, pinned.current.pin);

  // Without a Working section, running rows share the top of the list
  // without waiting on anyone.
  const waitingOnYou = placed.waiting.some((tree) => aggregateAttention(tree) !== 'working');
  const workingOpen = isShelfOpen(shelves, 'working');
  const snoozedOpen = isShelfOpen(shelves, 'snoozed');
  const settledOpen = isShelfOpen(shelves, 'settled');
  // A folded Settled shelf keeps the open row in sight only when it was opened
  // from there (search, the palette). Settling the open row is putting it
  // away: it goes under the fold like any other, rather than the shelf
  // showing it as though it had opened itself.
  const settledPinKey = held.current.hold?.bucket === 'settled' ? activeKey : null;
  // The same for Snoozed: a snoozed session opened from the palette stays in sight under the fold.
  const snoozedPinKey = held.current.hold?.bucket === 'snoozed' ? activeKey : null;

  const addFirstScope = async (workspaceId: string) => {
    setScopeError('');
    try {
      await addScopeViaDialog(workspaceId);
    } catch (reason) {
      setScopeError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  // The list can be empty because nothing exists yet or because a filter hides
  // everything. Say which, and offer the way back to everything.
  const emptyMessage = () => {
    if (!workspace?.scopes.length) {
      return (
        <>
          <button
            type="button"
            className="sidebar-empty-link"
            onClick={() => void addFirstScope(workspace!.id)}
          >
            Add a scope
          </button>{' '}
          to start a session.
        </>
      );
    }
    if (!allSessions.length) {
      return scope
        ? `Sessions you start in ${scope.name} appear here.`
        : 'Sessions you start appear here.';
    }
    if (scope && !hasActiveFilters(facets)) {
      return (
        <>
          Nothing in {scope.name} yet.{' '}
          <button
            type="button"
            className="sidebar-empty-link"
            onClick={() => clearAllFilters(workspace.id)}
          >
            Show all scopes
          </button>
        </>
      );
    }
    return (
      <>
        No sessions match these filters.{' '}
        <button
          type="button"
          className="sidebar-empty-link"
          onClick={() => clearAllFilters(workspace.id)}
        >
          Clear filters
        </button>
      </>
    );
  };

  // One tree is a conductor and its children; anything else is a single row.
  // The row for each entry comes from the registry, so this names no kind.
  const renderNode = (node: TreeNode, bucket: Bucket) => {
    const highlightActive = overlay === null;
    if (node.children.length > 0) {
      return (
        <TreeRow
          key={node.entry.key}
          node={node}
          bucket={bucket}
          workspaceId={workspace!.id}
          activeKey={activeKey}
          highlightActive={highlightActive}
        />
      );
    }
    return entryRow(node.entry, {
      workspaceId: workspace!.id,
      active: highlightActive && node.entry.key === activeKey,
      settle: settleOffer(node, false),
      snooze: snoozeOffer(node, false),
      bucket,
    });
  };

  // A row dragged off the Snoozed shelf and dropped on the list wakes. Only
  // that drag is claimed: a label chip keeps every other.
  const wakeDropHandlers = workspace
    ? {
        onDragOver: (event: React.DragEvent) => {
          if (!isSnoozedSessionDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setWakeDrop(true);
        },
        onDragLeave: (event: React.DragEvent) => {
          if (leftDropTarget(event)) setWakeDrop(false);
        },
        onDrop: (event: React.DragEvent) => {
          setWakeDrop(false);
          const sessionId = droppedSnoozedSessionId(event);
          if (!sessionId) return;
          event.preventDefault();
          const name = allSessions.find((session) => session.id === sessionId)?.name ?? '';
          void wakeWithUndo(workspace.id, [sessionId], { [sessionId]: name });
        },
      }
    : {};
  const list = (nodes: TreeNode[], bucket: Bucket) => nodes.map((node) => renderNode(node, bucket));

  // The rows exactly as drawn, top to bottom, for ⇧-click ranges.
  const drawnSections = [
    placed.waiting,
    visibleNodes(placed.working, !workingOpen, activeKey),
    visibleNodes(placed.snoozed, !snoozedOpen, snoozedPinKey),
    visibleNodes(placed.settled, !settledOpen, settledPinKey),
  ];
  const frame: SelectionFrame | null = workspace
    ? {
        workspaceId: workspace.id,
        order: drawnOrder(drawnSections, (node) =>
          node.children.length > 0 ? treeView(node, shelves[node.entry.key], activeKey).shown : [],
        ),
        openKey: activeKey,
      }
    : null;
  drawn.current = frame;

  return (
    <aside
      ref={sidebarRef}
      className="sidebar"
      data-density-shift={densityShift}
      aria-label={isInbox ? 'Inbox sidebar' : 'Home sidebar'}
      // Esc ends a selection, here only: in the terminal it is the agent's key.
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selectedCount > 0) {
          event.stopPropagation();
          clearSelection();
        }
      }}
    >
      <SelectionContext.Provider value={frame}>
        <span className="sr-only" aria-live="polite">
          {selectedCount > 1 ? `${selectedCount} sessions selected` : ''}
        </span>
        <SidebarSearch>
          <NewMenu />
        </SidebarSearch>
        <nav className="app-navigation" aria-label="Main navigation">
          <button
            type="button"
            className={`app-navigation-item ${!isInbox ? 'active' : ''}`}
            aria-label="Home"
            title="Home"
            aria-current={overlay === null ? 'page' : undefined}
            onClick={() => useNavigationStore.getState().setActiveSession(activeSessionId)}
          >
            <Home size={18} />
            <span className="app-navigation-label">Home</span>
          </button>
          {workspace && (
            <button
              type="button"
              className={`app-navigation-item ${isInbox ? 'active' : ''}`}
              aria-label="Inbox"
              title="Inbox"
              aria-current={isInbox ? 'page' : undefined}
              onClick={() => useNavigationStore.getState().openInbox()}
            >
              <Inbox size={18} />
              <span className="app-navigation-label">Inbox</span>
              {workspace.provider && inboxCount > 0 && (
                <span className="app-navigation-badge">{inboxCount}</span>
              )}
            </button>
          )}
        </nav>
        {workspace && isInbox && (
          <div className="home-navigation">
            <div className="home-session-panel">
              <section className="sidebar-section sidebar-integrations" aria-label="Integrations">
                <div className="sidebar-section-header">
                  <span className="sidebar-section-title">Integrations</span>
                </div>
                <button
                  type="button"
                  className="sidebar-inbox-row active"
                  aria-current="page"
                  onClick={() => useNavigationStore.getState().openInbox()}
                >
                  <GitPullRequest size={14} aria-hidden="true" />
                  <span className="sidebar-inbox-name">{PROVIDER_META.github.displayName}</span>
                  {!workspace.provider ? (
                    <span className="sidebar-inbox-count">Set up</span>
                  ) : (
                    inboxCount > 0 && <span className="sidebar-inbox-count">{inboxCount}</span>
                  )}
                </button>
              </section>
            </div>
          </div>
        )}
        {workspace && !isInbox && (
          <div className="home-navigation">
            <AutomationsNavItem workspace={workspace} />
            {/* Always there, even with one scope: it is also where scopes are added. */}
            <hr className="sidebar-scope-divider" />
            <FilterBar workspace={workspace} accessory={<NavigationSettings />} />
            <div
              ref={sessionPanelRef}
              className={`home-session-panel sidebar-sessions${wakeDrop ? ' sidebar-sessions--wake-drop' : ''}`}
              {...wakeDropHandlers}
            >
              {hiddenNeedingYou > 0 && (
                <button
                  type="button"
                  className="sidebar-hidden-chip"
                  onClick={() => clearAllFilters(workspace.id)}
                  title="Clear filters"
                >
                  {hiddenNeedingYou} hidden by filter {hiddenNeedingYou === 1 ? 'needs' : 'need'}{' '}
                  you
                </button>
              )}
              {!shown.length && <p className="sidebar-empty">{emptyMessage()}</p>}
              {/* Everything is running or put away: the top of the list is the
              answer to "does anything need me?", so it says no in words
              rather than leaving a blank that could be a list still loading. */}
              {shown.length > 0 && !waitingOnYou && hiddenNeedingYou === 0 && (
                <p className="sidebar-all-clear">
                  <CheckCheck size={13} aria-hidden="true" />
                  <span>Nothing is waiting on you.</span>
                </p>
              )}
              {scopeError && (
                <p className="sidebar-error" role="alert">
                  {scopeError}
                </p>
              )}
              {/* Everything in play that is not running, first and under no
              heading: questions, unread results, idle prompts, exited
              processes, newest back first (`bucketize`). Without a Working
              section, what runs stays here too. Each row says which in a
              word, and none of them can be folded away. */}
              {placed.waiting.length > 0 && (
                <div className="sidebar-bucket sidebar-bucket--waiting">
                  <nav className="session-list" data-bucket="waiting" aria-label="Sessions">
                    {list(placed.waiting, 'waiting')}
                  </nav>
                </div>
              )}
            </div>
            {/* Pinned to the bottom of the sidebar, outside the scrolling panel,
            so the sessions waiting on the person fill the space above however
            many are running or were put away. */}
            {shown.length > 0 && (
              <div className="sidebar-dock">
                {/* Only while something is in it, right above Settled, and only
              when the person keeps a Working section. A session starting work
              opens it (`useRevealWorking`); collapsed, it keeps only the tree
              the person has open. A session that stops stays a moment before
              it leaves (`workingExits`). */}
                {placed.working.length > 0 && (
                  <section
                    className="sidebar-bucket sidebar-bucket--working"
                    data-shelf="working"
                    aria-label="Working"
                  >
                    <ShelfHeader
                      title="Working"
                      count={leafCount(placed.working)}
                      open={workingOpen}
                      live
                      onToggle={() => toggleShelf('working')}
                      shortcutHint={WORKING_SHELF_SHORTCUT_LABEL}
                    />
                    <nav
                      className="session-list"
                      data-bucket="working"
                      aria-label="Working sessions"
                    >
                      {list(visibleNodes(placed.working, !workingOpen, activeKey), 'working')}
                    </nav>
                  </section>
                )}
                {/* What was put away until a time, soonest back first. Only while
              something is in it; folded, it keeps only the row the person has
              open, if they opened it from here. */}
                {placed.snoozed.length > 0 && (
                  <section
                    className="sidebar-bucket sidebar-bucket--snoozed"
                    data-shelf="snoozed"
                    aria-label="Snoozed"
                  >
                    <ShelfHeader
                      title="Snoozed"
                      count={leafCount(placed.snoozed)}
                      open={snoozedOpen}
                      onToggle={() => toggleShelf('snoozed')}
                      tooltip="Sessions that come back by themselves at their time, or sooner if they need you. Drag one to the list to wake it."
                    />
                    <nav
                      className="session-list"
                      data-bucket="snoozed"
                      aria-label="Snoozed sessions"
                    >
                      {list(visibleNodes(placed.snoozed, !snoozedOpen, snoozedPinKey), 'snoozed')}
                    </nav>
                  </section>
                )}
                {/* Only what was put away, by hand or after sitting idle (see
              AutoSettler). A session that never had a message, and has no
              page open, is deleted rather than kept here (EmptySessionReaper). */}
                <section
                  className="sidebar-bucket sidebar-bucket--settled"
                  data-shelf="settled"
                  aria-label="Settled"
                >
                  <ShelfHeader
                    title="Settled"
                    count={leafCount(placed.settled)}
                    open={settledOpen}
                    onToggle={() => toggleShelf('settled')}
                  />
                  <nav className="session-list" data-bucket="settled" aria-label="Settled sessions">
                    {list(visibleNodes(placed.settled, !settledOpen, settledPinKey), 'settled')}
                  </nav>
                </section>
              </div>
            )}
          </div>
        )}
        {/* A row leaving the list travels to the shelf it joins. */}
        <BucketMotion placement={placementOf(placed)} rootRef={sidebarRef} />
      </SelectionContext.Provider>
    </aside>
  );
}
