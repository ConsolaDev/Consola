import { useEffect, useState } from 'react';
import { GitPullRequest, Home, Inbox, MoreVertical, Plus } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tabs from '@radix-ui/react-tabs';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useInboxStore } from '../../stores/inboxStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { homeScope, useHomeStore } from '../../stores/homeStore';
import { itemsForView } from '../../../shared/inboxViews';
import { PROVIDER_META } from '../../../shared/providers';
import { SessionNavItem } from './SessionNavItem';
import { NavigationSettings } from './NavigationSettings';
import { GroupNavItem } from './GroupNavItem';
import { ScopeSelector } from './ScopeSelector';
import { NewGroupDialog } from '../Dialogs/NewGroupDialog';
import { WorkspaceMenu } from '../Layout/WorkspaceMenu';
import { NewMenu } from '../Layout/NewMenu';
import { activateSession, moveSessionToGroup, createQuickSession, openNewSessionDialog } from '../../utils/sessionActions';
import { droppedSessionId, isSessionFromScope, leftDropTarget } from './sessionDrag';
import './styles.css';

export function Sidebar() {
  const isSidebarHidden = useNavigationStore(state => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore(state => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore(state => state.activeSessionId);
  const isInboxOpen = useNavigationStore(state => state.isInboxOpen);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const workspace = workspaces.find(candidate => candidate.id === activeWorkspaceId);
  const selectedScopeId = useHomeStore(state => state.scopeIds[activeWorkspaceId ?? '']);
  const tab = useHomeStore(state => state.tabs[activeWorkspaceId ?? ''] ?? 'home');
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const inboxCount = useInboxStore(state => workspace ? itemsForView(state.snapshots[workspace.id]?.items ?? [], 'inbox').length : 0);
  const providerAccount = workspace?.provider?.accountLogin;

  useEffect(() => {
    if (workspace && providerAccount) void useInboxStore.getState().load(workspace.id);
  }, [workspace?.id, providerAccount]);

  // External activation (palette, notification, restored window) reveals the
  // session's scope and group. Unrelated workspace writes never reset a filter.
  useEffect(() => {
    const current = useWorkspaceStore.getState().workspaces.find(candidate => candidate.id === activeWorkspaceId);
    const session = current?.sessions.find(candidate => candidate.id === activeSessionId);
    if (!current || !session) return;
    useHomeStore.getState().selectScope(current.id, session.scopeId);
    if (session.groupId) useSettingsStore.getState().expandSidebarSection(session.groupId);
  }, [activeWorkspaceId, activeSessionId]);

  if (isSidebarHidden) return null;

  const scope = workspace && homeScope(workspace, selectedScopeId, activeSessionId);
  const groups = workspace?.groups.filter(group => !group.archivedAt) ?? [];
  const liveGroupIds = new Set(groups.map(group => group.id));
  const allSessions = workspace?.sessions.filter(session => session.name.length > 0) ?? [];
  const sessions = allSessions.filter(session => session.scopeId === scope?.id);
  const ungrouped = sessions.filter(session => !session.groupId || !liveGroupIds.has(session.groupId));
  const startSession = (groupId?: string) => {
    if (workspace) void createQuickSession(workspace.id, { scopeId: scope?.id, groupId });
  };
  // The Home tab shows one scope at a time, so an empty list can mean "nothing
  // yet" or "it is in another scope". Say which, and point to the other one.
  const ungroupedEmptyMessage = () => {
    if (!scope) return 'Add a scope to start a session.';
    if (!allSessions.length) return `Sessions you start in ${scope.name} appear here.`;
    const elsewhere = allSessions.length - sessions.length;
    if (!sessions.length && elsewhere > 0) {
      return <>Nothing in {scope.name} yet.{' '}
        <button type="button" className="sidebar-empty-link" onClick={() => useHomeStore.getState().selectTab(workspace!.id, 'all')}>
          {elsewhere} {elsewhere === 1 ? 'session' : 'sessions'} in other scopes
        </button></>;
    }
    return 'No ungrouped sessions in this scope.';
  };
  const renderSession = (session: typeof allSessions[number], showScope = false) => <SessionNavItem
    key={session.id} session={session} workspaceId={workspace!.id}
    isActive={!isInboxOpen && activeSessionId === session.id}
    onClick={() => activateSession(workspace!.id, session.id)}
    subtitle={showScope ? workspace?.scopes.find(candidate => candidate.id === session.scopeId)?.name ?? 'Unavailable scope' : undefined}
  />;

  return (
    <aside className="sidebar" aria-label={isInboxOpen ? 'Inbox sidebar' : 'Home sidebar'}>
      <div className="sidebar-workspace"><WorkspaceMenu /><NavigationSettings /><NewMenu /></div>
      <nav className="app-navigation" aria-label="Main navigation">
        <button className={`app-navigation-item ${!isInboxOpen ? 'active' : ''}`} aria-label="Home" title="Home" aria-current={!isInboxOpen ? 'page' : undefined}
          onClick={() => useNavigationStore.getState().setActiveSession(activeSessionId)}><Home size={18} /><span className="app-navigation-label">Home</span></button>
        {workspace && <button className={`app-navigation-item ${isInboxOpen ? 'active' : ''}`} aria-label="Inbox" title="Inbox" aria-current={isInboxOpen ? 'page' : undefined}
          onClick={() => useNavigationStore.getState().openInbox()}><Inbox size={18} /><span className="app-navigation-label">Inbox</span>{workspace.provider && inboxCount > 0 && <span className="app-navigation-badge">{inboxCount}</span>}</button>}
      </nav>
      {workspace && isInboxOpen && <div className="home-navigation">
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
      {workspace && !isInboxOpen && <>
        <Tabs.Root className="home-navigation" value={tab} onValueChange={value => useHomeStore.getState().selectTab(workspace.id, value as 'home' | 'all')}>
          <Tabs.List className="home-tabs" aria-label="Session views">
            <Tabs.Trigger className="home-tab" value="home">Home</Tabs.Trigger>
            <Tabs.Trigger className="home-tab" value="all">All your sessions</Tabs.Trigger>
          </Tabs.List>
          {tab === 'home' && <div className="sidebar-scope-picker"><ScopeSelector workspace={workspace} /></div>}
          <Tabs.Content className="home-session-panel" value="home">
            <div className="sidebar-section">
              <div className="sidebar-section-header"><span className="sidebar-section-title">Your groups</span><button className="sidebar-section-button" aria-label="Add group" onClick={() => setIsCreatingGroup(true)}><Plus size={14} /></button></div>
              <nav className="session-list" aria-label="Session groups">
                {groups.map(group => <GroupNavItem key={group.id} group={group} sessions={sessions.filter(session => session.groupId === group.id)}
                  workspaceId={workspace.id} scopeFor={id => workspace.scopes.find(candidate => candidate.id === id)} activeSessionId={isInboxOpen ? null : activeSessionId}
                  onNewSession={() => startSession(group.id)}
                  onNewSessionWithOptions={() => openNewSessionDialog(workspace.id, { scopeId: scope?.id, groupId: group.id })} />)}
                {!groups.length && <p className="sidebar-empty">Group sessions that belong together, like a feature or a bug hunt.</p>}
              </nav>
            </div>
            <div className="sidebar-section sidebar-ungrouped">
              <div className={`sidebar-section-header ${isDropTarget ? 'drop-target' : ''}`}
                onDragOver={event => { if (!scope || !isSessionFromScope(event, scope.id)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setIsDropTarget(true); }}
                onDragLeave={event => { if (leftDropTarget(event)) setIsDropTarget(false); }}
                onDrop={event => { event.preventDefault(); setIsDropTarget(false); const id = droppedSessionId(event); if (id) void moveSessionToGroup(workspace.id, id, undefined); }}>
                <span className="sidebar-section-title">Ungrouped</span>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild><button className="sidebar-section-button" aria-label="Ungrouped actions"><MoreVertical size={14} /></button></DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={4} onCloseAutoFocus={event => event.preventDefault()}>
                      <DropdownMenu.Item className="dropdown-item" disabled={!scope} onSelect={() => startSession()}>New session</DropdownMenu.Item>
                      <DropdownMenu.Item className="dropdown-item" onSelect={() => openNewSessionDialog(workspace.id, { scopeId: scope?.id })}>New session with options…</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <button className="sidebar-section-button" aria-label="New ungrouped session" disabled={!scope} onClick={() => startSession()}><Plus size={14} /></button>
              </div>
              <nav className="session-list" aria-label="Ungrouped sessions">{ungrouped.map(session => renderSession(session))}</nav>
              {!ungrouped.length && <p className="sidebar-empty">{ungroupedEmptyMessage()}</p>}
            </div>
          </Tabs.Content>
          <Tabs.Content className="home-session-panel" value="all">
            <div className="sidebar-section">
              <div className="sidebar-section-header"><span className="sidebar-section-title">All scopes · {allSessions.length}</span><button className="sidebar-section-button" aria-label="New session" disabled={!scope} onClick={() => startSession()}><Plus size={14} /></button></div>
              <nav className="session-list" aria-label="All sessions">{[...allSessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).map(session => renderSession(session, true))}</nav>
              {!allSessions.length && <p className="sidebar-empty">Your sessions will appear here.</p>}
            </div>
          </Tabs.Content>
        </Tabs.Root>
        {isCreatingGroup && <NewGroupDialog key={workspace.id} workspaceId={workspace.id} onClose={() => setIsCreatingGroup(false)} />}
      </>}
    </aside>
  );
}
