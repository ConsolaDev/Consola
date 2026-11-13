import { useEffect, useRef, useState } from 'react';
import { GitPullRequest, Home, Inbox, MoreVertical, Plus } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useInboxStore } from '../../stores/inboxStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { filteredScope, hasScopeChoice, useHomeStore } from '../../stores/homeStore';
import { listedSessions, scopeForSession, type Session } from '../../../shared/workspace';
import { scopeTrail } from '../../utils/scopeTrail';
import { itemsForView } from '../../../shared/inboxViews';
import { PROVIDER_META } from '../../../shared/providers';
import { AssistantNavItem } from './AssistantNavItem';
import { AutomationsNavItem } from './AutomationsNavItem';
import { ScopeFilter } from './ScopeFilter';
import { SidebarSearch } from './SidebarSearch';
import { SessionNavItem } from './SessionNavItem';
import { NavigationSettings } from './NavigationSettings';
import { GroupNavItem } from './GroupNavItem';
import { NewGroupDialog } from '../Dialogs/NewGroupDialog';
import { NewMenu } from '../Layout/NewMenu';
import { activateSession, chooseScope, moveSessionToGroup, createQuickSession, openNewSessionDialog, revealSessionScope } from '../../utils/sessionActions';
import { droppedSessionId, isGroupedSessionDrag, isSessionFromScope, leftDropTarget } from './sessionDrag';
import { useSettleOnChange } from '../../hooks/useSettleOnChange';
import { addScopeViaDialog } from '../../utils/scopeActions';
import './styles.css';

export function Sidebar() {
  const isSidebarHidden = useNavigationStore(state => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore(state => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore(state => state.activeSessionId);
  const overlay = useNavigationStore(state => state.overlay);
  const isInbox = overlay === 'inbox';
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const workspace = workspaces.find(candidate => candidate.id === activeWorkspaceId);
  const filterId = useHomeStore(state => state.scopeFilters[activeWorkspaceId ?? '']);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [scopeError, setScopeError] = useState('');
  const inboxCount = useInboxStore(state => workspace ? itemsForView(state.snapshots[workspace.id]?.items ?? [], 'inbox').length : 0);
  const providerAccount = workspace?.provider?.accountLogin;

  useEffect(() => {
    if (workspace && providerAccount) void useInboxStore.getState().load(workspace.id);
  }, [workspace?.id, providerAccount]);

  // Activation (palette, notification, restored window) reveals the session:
  // a filter that would hide it follows it, and its group unfolds. Unrelated
  // workspace writes never reset a filter.
  useEffect(() => {
    const current = useWorkspaceStore.getState().workspaces.find(candidate => candidate.id === activeWorkspaceId);
    const session = current?.sessions.find(candidate => candidate.id === activeSessionId);
    // The Assistant belongs to no scope the filter could show.
    if (!current || !session || session.kind === 'assistant') return;
    revealSessionScope(current.id, session.id);
    if (session.groupId) useSettingsStore.getState().expandSidebarSection(session.groupId);
  }, [activeWorkspaceId, activeSessionId]);

  // A changed filter settles the list in, so it reads as a new list rather
  // than a flicker.
  const scope = workspace && filteredScope(workspace, filterId);
  const sessionPanelRef = useRef<HTMLDivElement>(null);
  useSettleOnChange(sessionPanelRef, scope?.id ?? 'all', { rise: 4 });

  if (isSidebarHidden) return null;

  const groups = workspace?.groups.filter(group => !group.archivedAt) ?? [];
  const liveGroupIds = new Set(groups.map(group => group.id));
  const allSessions = workspace ? listedSessions(workspace).filter(session => session.name.length > 0) : [];
  const sessions = scope ? allSessions.filter(session => session.scopeId === scope.id) : allSessions;
  const ungrouped = sessions.filter(session => !session.groupId || !liveGroupIds.has(session.groupId));
  // No scopeId: where a session starts is one rule (the filter, else the open
  // session's scope, else the primary one), applied by sessionDestination.
  const startSession = (groupId?: string) => {
    if (workspace) void createQuickSession(workspace.id, { groupId });
  };
  // A filtered list can be empty because nothing exists yet or because it is
  // all in other scopes. Say which, and offer the way back to everything.
  // With no scope there is no scope row either, so the way back is here.
  const addFirstScope = async (workspaceId: string) => {
    setScopeError('');
    try { await addScopeViaDialog(workspaceId); }
    catch (reason) { setScopeError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const ungroupedEmptyMessage = () => {
    if (!workspace?.scopes.length) {
      return <><button type="button" className="sidebar-empty-link" onClick={() => void addFirstScope(workspace!.id)}>Add a scope</button>
        {' '}to start a session.</>;
    }
    if (!allSessions.length) return scope ? `Sessions you start in ${scope.name} appear here.` : 'Sessions you start appear here.';
    if (scope && !sessions.length) {
      return <>Nothing in {scope.name} yet.{' '}
        <button type="button" className="sidebar-empty-link" onClick={() => chooseScope(workspace.id, null)}>Show all scopes</button></>;
    }
    return scope ? 'No ungrouped sessions in this scope.' : 'No ungrouped sessions.';
  };
  // Under All, each row says which scope it runs in; a filtered list already
  // says it once, in the scope row.
  const showScopeNames = !!workspace && !scope && hasScopeChoice(workspace);
  const labelFor = (session: Session) =>
    showScopeNames ? scopeTrail(workspace.scopes, scopeForSession(workspace, session)!) : undefined;
  const renderSession = (session: typeof allSessions[number]) => <SessionNavItem
    key={session.id} session={session} workspaceId={workspace!.id} scopeLabel={labelFor(session)}
    isActive={overlay === null && activeSessionId === session.id}
    onClick={() => activateSession(workspace!.id, session.id)}
  />;

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
      {workspace && !isInbox && <>
        <div className="home-navigation">
          <AssistantNavItem workspace={workspace} />
          <AutomationsNavItem workspace={workspace} />
          {/* Always there, even with one scope: it is also where scopes are added. */}
          <hr className="sidebar-scope-divider" />
          <ScopeFilter workspace={workspace} />
          <div ref={sessionPanelRef} className="home-session-panel">
            <div className="sidebar-section">
              <div className="sidebar-section-header"><span className="sidebar-section-title">Your groups</span><button className="sidebar-section-button" aria-label="Add group" onClick={() => setIsCreatingGroup(true)}><Plus size={14} /></button></div>
              <nav className="session-list" aria-label="Session groups">
                {groups.map(group => <GroupNavItem key={group.id} group={group} sessions={sessions.filter(session => session.groupId === group.id)}
                  workspaceId={workspace.id} scopeFor={id => workspace.scopes.find(candidate => candidate.id === id)} scopeLabelFor={labelFor} activeSessionId={overlay !== null ? null : activeSessionId}
                  onNewSession={() => startSession(group.id)}
                  onNewSessionWithOptions={() => openNewSessionDialog(workspace.id, { groupId: group.id })} />)}
                {!groups.length && <p className="sidebar-empty">Group sessions that belong together, like a feature or a bug hunt.</p>}
              </nav>
            </div>
            <div className="sidebar-section sidebar-ungrouped">
              <div className={`sidebar-section-header ${isDropTarget ? 'drop-target' : ''}`}
                onDragOver={event => { if (!(scope ? isSessionFromScope(event, scope.id) : isGroupedSessionDrag(event))) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setIsDropTarget(true); }}
                onDragLeave={event => { if (leftDropTarget(event)) setIsDropTarget(false); }}
                onDrop={event => { event.preventDefault(); setIsDropTarget(false); const id = droppedSessionId(event); if (id) void moveSessionToGroup(workspace.id, id, undefined); }}>
                <span className="sidebar-section-title">Ungrouped</span>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild><button className="sidebar-section-button" aria-label="Ungrouped actions"><MoreVertical size={14} /></button></DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={4} onCloseAutoFocus={event => event.preventDefault()}>
                      <DropdownMenu.Item className="dropdown-item" disabled={!workspace.scopes.length} onSelect={() => startSession()}>New session</DropdownMenu.Item>
                      <DropdownMenu.Item className="dropdown-item" onSelect={() => openNewSessionDialog(workspace.id)}>New session with options…</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <button className="sidebar-section-button" aria-label="New ungrouped session" disabled={!workspace.scopes.length} onClick={() => startSession()}><Plus size={14} /></button>
              </div>
              <nav className="session-list" aria-label="Ungrouped sessions">{ungrouped.map(session => renderSession(session))}</nav>
              {!ungrouped.length && <p className="sidebar-empty">{ungroupedEmptyMessage()}</p>}
              {scopeError && <p className="sidebar-error" role="alert">{scopeError}</p>}
            </div>
          </div>
        </div>
        {isCreatingGroup && <NewGroupDialog key={workspace.id} workspaceId={workspace.id} onClose={() => setIsCreatingGroup(false)} />}
      </>}
    </aside>
  );
}
