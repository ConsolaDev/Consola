import { SessionTerminalLayout } from '../Terminal/SessionTerminalLayout';
import { useEffect, useMemo } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { checkoutPathForSession, scopeForSession } from '../../../shared/workspace';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useGitStatusAutoRefresh } from '../../stores/gitStatusStore';
import { useCheckout } from '../../stores/checkoutStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { tabFactsFor } from '../../sidePanel/tabKinds';
import { TerminalPanel } from '../Terminal';
import { PreviewPanel } from '../PreviewPanel';
import { SidePanel } from '../SidePanel/SidePanel';
import { WorkItemStrip } from '../WorkItemStrip';
import { WorkItemPanel } from '../WorkItemPanel';
import { SessionHeader } from './SessionHeader';
import { FileExplorer } from '../FileExplorer';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  sessionId: string;
}

export function ContentView({ workspaceId, sessionId }: ContentViewProps) {
  const isExplorerVisible = useNavigationStore((state) => state.isExplorerVisible);
  const isSidePanelVisible = useSidePanelStore((state) => state.layout.visible);
  const isWorkItemPanelVisible = useNavigationStore((state) => state.isWorkItemPanelVisible);

  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);
  const getSession = useWorkspaceStore((state) => state.getSession);
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  const openFile = usePreviewTabStore((state) => state.openFile);
  const hasOpenTabs = usePreviewTabStore((state) => state.tabs.length > 0);
  const activePreviewTabId = usePreviewTabStore((state) => state.activeTabId);

  const workspace = getWorkspace(workspaceId);

  // Get active session
  const session = workspace ? getSession(workspaceId, sessionId) : undefined;

  // Determine instanceId and cwd from workspace
  const instanceId = session?.instanceId ?? '';
  // The session's home scope decides where it runs, unless the session
  // carries a cwd override (worktrees, from Phase 1 on).
  const scope = workspace ? scopeForSession(workspace, session) : undefined;
  const cwd = (workspace && checkoutPathForSession(workspace, session)) ?? '';
  // While a cleanup rule has its worktree removed there is no checkout to
  // show, but the terminal still launches where the session belongs: main
  // rebuilds the worktree there before it spawns.
  const terminalCwd = cwd || (session?.removedWorktree ? (session.cwd ?? scope?.path ?? '') : '');
  // Details are read as the workspace's account, so a workspace without one
  // has nothing to show even when the session still names an item.
  const showWorkItemPanel =
    isWorkItemPanelVisible && Boolean(session?.workItem) && Boolean(workspace?.provider);
  // What the side panel's tabs read: `useTabFacts`, split around the early
  // return below, since hooks cannot wait for the session to be found.
  const checkout = useCheckout(cwd || null);

  // Conditional panels must have separate saved layouts: hiding the explorer
  // must not overwrite the layout that remembers its width.
  const panelIds = [
    ...(isExplorerVisible && cwd ? ['explorer'] : []),
    'agent',
    ...(showWorkItemPanel ? ['work-item'] : []),
    ...(hasOpenTabs ? ['preview'] : []),
    ...(isSidePanelVisible ? ['side-panel'] : []),
  ];
  // Not the id the columns before the side panel saved under, so none of
  // their layouts is read back.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'session-pane',
    panelIds,
    storage: localStorage,
  });

  const hasStarted = session?.hasStarted;
  const harnessId = session?.harnessId;

  // Launch settings are resolved from the registry on every render rather than
  // copied onto the session, so editing a harness in Settings reaches its
  // sessions the next time they start. `harnesses` is a dependency because
  // getLaunchFields reads it, even though it is not referenced directly.
  const harnesses = useHarnessStore((state) => state.harnesses);
  const getLaunchFields = useHarnessStore((state) => state.getLaunchFields);
  const launchFields = useMemo(
    () => getLaunchFields(harnessId),
    [getLaunchFields, harnessId, harnesses],
  );

  // Git status follows the checkout the session runs in. A worktree has its
  // own branch, index and changes, so its scope's path would report a
  // different checkout than the one the agent is editing.
  useGitStatusAutoRefresh(scope?.isGitRepo || session?.cwd || session?.agentCwd ? cwd : null);

  // Record that this tab has launched, so reopening it resumes the
  // conversation instead of trying to create a session ID Claude already has.
  useEffect(() => {
    if (!hasStarted && sessionId) {
      void updateSession(workspaceId, sessionId, { hasStarted: true });
    }
  }, [hasStarted, sessionId, workspaceId, updateSession]);

  if (!workspace || !session) {
    return (
      <div className="workspace-view">
        <div className="workspace-view-content">
          <div className="workspace-placeholder">
            <p>Session not found</p>
          </div>
        </div>
      </div>
    );
  }

  const handleSelectFile = (path: string) => {
    openFile(path);
  };
  const facts = tabFactsFor(workspace, session, checkout);

  return (
    <div className="workspace-view">
      <SessionHeader key={session.id} workspace={workspace} session={session} />
      {session.workItem && <WorkItemStrip workspaceId={workspaceId} session={session} />}
      <div className="workspace-view-content">
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          {isExplorerVisible && cwd && (
            <>
              <Panel id="explorer" defaultSize="240px" minSize="160px" maxSize="40%">
                <FileExplorer
                  rootPath={cwd}
                  selectedPath={activePreviewTabId}
                  onSelectFile={handleSelectFile}
                />
              </Panel>
              <Separator className="resize-handle" />
            </>
          )}
          {/* The conversation. It stays an unconditional child of this Group,
              with no wrapper that differs between layouts and the same key,
              so opening, closing or resizing the side panel only resizes it:
              a remount would reattach the terminal at a captured size and
              could lose the prompt's frame (CLAUDE.md, "Terminals Outlive
              Their Views"). */}
          <Panel id="agent" minSize="20%">
            <SessionTerminalLayout instanceId={instanceId}>
              <TerminalPanel
                instanceId={instanceId}
                workspaceId={workspaceId}
                sessionId={session.id}
                readOnly={
                  session.toolPolicy === 'read-only'
                    ? { startedBy: session.automation?.name }
                    : undefined
                }
                cwd={terminalCwd}
                claudeSessionId={session.claudeSessionId}
                resume={session.hasStarted}
                harness={launchFields}
                // Read from the session record rather than re-resolved: unlike
                // the harness's launch fields, this was chosen once for this
                // conversation and must not drift.
                model={session.model}
              />
            </SessionTerminalLayout>
          </Panel>
          {/* The info panel (PR 2) goes here, between the conversation and the side panel. */}
          {showWorkItemPanel && (
            <>
              <Separator className="resize-handle" />
              <Panel id="work-item" defaultSize="38%" minSize="320px" maxSize="70%">
                <WorkItemPanel workspaceId={workspaceId} session={session} />
              </Panel>
            </>
          )}
          {hasOpenTabs && (
            <>
              <Separator className="resize-handle" />
              <Panel id="preview" defaultSize="40%" minSize="20%">
                <PreviewPanel />
              </Panel>
            </>
          )}
          {isSidePanelVisible && (
            <>
              <Separator className="resize-handle" />
              <Panel id="side-panel" defaultSize="40%" minSize="280px" maxSize="75%">
                <SidePanel facts={facts} />
              </Panel>
            </>
          )}
        </Group>
      </div>
    </div>
  );
}
