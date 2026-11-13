import { createQuickSession, openAssistant, openNewSessionDialog } from '../../utils/sessionActions';
import { pickFoldersAndCreateWorkspace } from '../../utils/workspaceActions';
import { NewSessionDialog } from '../Dialogs/NewSessionDialog';
import { useNewSessionDialogStore } from '../../stores/newSessionDialogStore';
import { useEffect, useRef, type CSSProperties } from 'react';
import { Sidebar } from '../Sidebar';
import { SidebarResizeHandle } from '../Sidebar/SidebarResizeHandle';
import { AppHeader } from './AppHeader';
import { WorkspaceRail } from './WorkspaceRail';
import { MainContent } from './MainContent';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { useWindowDropGuard } from '../../hooks/useWindowDropGuard';
import { useSettings } from '../../contexts/SettingsContext';
import { useCommandPalette } from '../../contexts/CommandPaletteContext';
import {
  useNavigationStore,
  subscribeToWindowWorkspace,
  subscribeToActivateSession,
  subscribeToShowAutomations,
} from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useAutomationsStore } from '../../stores/automationsStore';
import { useInboxStore } from '../../stores/inboxStore';
import { useAssistantStore } from '../../stores/assistantStore';
import './styles.css';

export function Layout() {
  const { openSettings } = useSettings();
  const { togglePalette, openPalette } = useCommandPalette();
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const sidebarWidth = useNavigationStore((state) => state.sidebarWidth);
  const layoutRef = useRef<HTMLDivElement>(null);

  // ⌘N starts the next thing there is to start: a session in the open
  // workspace, or, with none open, the workspace itself.
  const handleNewSession = () => {
    if (activeWorkspaceId) {
      if (!useNewSessionDialogStore.getState().destination) void createQuickSession(activeWorkspaceId);
    } else {
      void pickFoldersAndCreateWorkspace();
    }
  };

  useKeyboardShortcuts({
    onNewSession: handleNewSession,
    onNewSessionWithOptions: () => {
      if (useNewSessionDialogStore.getState().destination) return;
      if (activeWorkspaceId) openNewSessionDialog(activeWorkspaceId);
      else void pickFoldersAndCreateWorkspace();
    },
    onOpenSettings: openSettings,
    onTogglePalette: togglePalette,
    onOpenScopedPalette: openPalette,
    onOpenAssistant: () => {
      if (!activeWorkspaceId) return;
      // A workspace with no scope has nowhere to run it; the sidebar row says so.
      const workspace = useWorkspaceStore.getState().getWorkspace(activeWorkspaceId);
      if (workspace && workspace.scopes.length > 0) void openAssistant(activeWorkspaceId);
    },
  });
  useTheme();
  useWindowDropGuard();

  // Terminals report activity for every session, including ones whose pane is
  // not mounted, so the subscription lives here rather than in the pane.
  useEffect(() => useTerminalStore.getState().subscribeToEvents(), []);

  // Inbox snapshots arrive on main's push channel for every github-bound
  // workspace, including ones whose pane is not mounted.
  useEffect(() => useInboxStore.getState().subscribeToEvents(), []);

  // Automation snapshots likewise: the sidebar row reads them while the
  // dashboard is closed, and the Assistant's tray holds the ones it asked for.
  useEffect(() => useAutomationsStore.getState().subscribe(), []);

  // The Assistant's row shows what finished while its pane is closed.
  useEffect(() => useAssistantStore.getState().subscribe(), []);

  // Main can drop this window's workspace out from under it, e.g. when it was
  // deleted from another window.
  useEffect(() => subscribeToWindowWorkspace(), []);

  // A notification click can land on a window that is already open.
  useEffect(() => subscribeToActivateSession(), []);

  // So can one about an automation's run: it lands on the dashboard.
  useEffect(() => subscribeToShowAutomations(), []);

  // The sidebar and the header strip above it both read this variable, so
  // the two cannot drift apart. It goes on the root as a style prop rather
  // than from an effect so a persisted width paints on the first frame.
  const layoutStyle = { '--sidebar-width': `${sidebarWidth}px` } as CSSProperties;

  return (
    <div ref={layoutRef} className={`layout ${isSidebarHidden ? 'sidebar-hidden' : ''}`} style={layoutStyle}>
      <NewSessionDialog />
      <AppHeader />
      <WorkspaceRail />
      <Sidebar />
      {!isSidebarHidden && <SidebarResizeHandle layoutRef={layoutRef} />}
      <main className="content-area">
        <MainContent />
      </main>
    </div>
  );
}
