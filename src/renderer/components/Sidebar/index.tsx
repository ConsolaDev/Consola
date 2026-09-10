import { useEffect, useState } from 'react';
import { Home, Inbox, Plus, Settings } from 'lucide-react';
import * as Tabs from '@radix-ui/react-tabs';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useInboxStore } from '../../stores/inboxStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { homeScope, useHomeStore } from '../../stores/homeStore';
import { itemsForView } from '../../../shared/inboxViews';
import { useSettings } from '../../contexts/SettingsContext';
import { SessionNavItem } from './SessionNavItem';
import { NavigationSettings } from './NavigationSettings';
import { GroupNavItem } from './GroupNavItem';
import { ScopeSelector } from './ScopeSelector';
import { NewGroupDialog } from '../Dialogs/NewGroupDialog';
import { WorkspaceSwitcher } from '../Layout/WorkspaceSwitcher';
import { NewMenu } from '../Layout/NewMenu';
import { activateSession, moveSessionToGroup, openNewSessionComposer } from '../../utils/sessionActions';
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
  const { openSettings } = useSettings();
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
    if (workspace) void openNewSessionComposer(workspace.id, { scopeId: scope?.id, groupId });
  };
  const renderSession = (session: typeof allSessions[number], showScope = false) => <SessionNavItem
    key={session.id} session={session} workspaceId={workspace!.id}
    isActive={!isInboxOpen && activeSessionId === session.id}
    onClick={() => activateSession(workspace!.id, session.id)}
    subtitle={showScope ? workspace?.scopes.find(candidate => candidate.id === session.scopeId)?.name ?? 'Unavailable scope' : undefined}
  />;

  return <>
    <nav className="app-navigation" aria-label="Main navigation">
      <button className={`app-navigation-item ${!isInboxOpen ? 'active' : ''}`} aria-current={!isInboxOpen ? 'page' : undefined}
        onClick={() => useNavigationStore.getState().setActiveSession(activeSessionId)}><Home size={18} /><span>Home</span></button>
      {workspace?.provider && <button className={`app-navigation-item ${isInboxOpen ? 'active' : ''}`} aria-current={isInboxOpen ? 'page' : undefined}
        onClick={() => useNavigationStore.getState().openInbox()}><Inbox size={18} /><span>Inbox</span>{inboxCount > 0 && <span className="app-navigation-badge">{inboxCount}</span>}</button>}
      <button className="app-navigation-item app-navigation-settings" onClick={openSettings} aria-label="Settings"><Settings size={18} /></button>
    </nav>
    <aside className="sidebar" aria-label="Home sidebar">
      <div className="sidebar-workspace"><WorkspaceSwitcher /><NavigationSettings /><NewMenu /></div>
      {workspace && <>
        <Tabs.Root className="home-navigation" value={tab} onValueChange={value => useHomeStore.getState().selectTab(workspace.id, value as 'home' | 'all')}>
          <Tabs.List className="home-tabs" aria-label="Session views">
            <Tabs.Trigger className="home-tab" value="home">Home</Tabs.Trigger>
            <Tabs.Trigger className="home-tab" value="all">All your sessions</Tabs.Trigger>
          </Tabs.List>
          <div className="sidebar-scope-picker"><ScopeSelector workspace={workspace} /></div>
          <Tabs.Content className="home-session-panel" value="home">
            <div className="sidebar-section">
              <div className="sidebar-section-header"><span className="sidebar-section-title">Your groups</span><button className="sidebar-section-button" aria-label="Add group" onClick={() => setIsCreatingGroup(true)}><Plus size={14} /></button></div>
              <nav className="session-list" aria-label="Session groups">
                {groups.map(group => <GroupNavItem key={group.id} group={group} sessions={sessions.filter(session => session.groupId === group.id)}
                  workspaceId={workspace.id} scopeFor={id => workspace.scopes.find(candidate => candidate.id === id)} activeSessionId={isInboxOpen ? null : activeSessionId}
                  onNewSession={() => startSession(group.id)} />)}
                {!groups.length && <p className="sidebar-empty">Organize your sessions into groups.</p>}
              </nav>
            </div>
            <div className="sidebar-section sidebar-ungrouped">
              <div className={`sidebar-section-header ${isDropTarget ? 'drop-target' : ''}`}
                onDragOver={event => { if (!scope || !isSessionFromScope(event, scope.id)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setIsDropTarget(true); }}
                onDragLeave={event => { if (leftDropTarget(event)) setIsDropTarget(false); }}
                onDrop={event => { event.preventDefault(); setIsDropTarget(false); const id = droppedSessionId(event); if (id) void moveSessionToGroup(workspace.id, id, undefined); }}>
                <span className="sidebar-section-title">Ungrouped</span><button className="sidebar-section-button" aria-label="New ungrouped session" disabled={!scope} onClick={() => startSession()}><Plus size={14} /></button>
              </div>
              <nav className="session-list" aria-label="Ungrouped sessions">{ungrouped.map(session => renderSession(session))}</nav>
              {!ungrouped.length && <p className="sidebar-empty">{scope ? 'No ungrouped sessions in this scope.' : 'Add a scope to start a session.'}</p>}
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
  </>;
}
