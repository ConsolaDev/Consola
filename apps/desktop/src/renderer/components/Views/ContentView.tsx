import { SessionTerminalLayout } from '../Terminal/SessionTerminalLayout';
import { useEffect, useMemo } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { checkoutPathForSession, scopeForSession } from '../../../shared/workspace';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useGitStatusAutoRefresh } from '../../stores/gitStatusStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { TerminalPanel } from '../Terminal';
import { PreviewPanel } from '../PreviewPanel';
import { GitReviewPanel } from '../GitReviewPanel';
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
  const isGitReviewOpen = useGitReviewStore((state) => state.isOpen);
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

  // Conditional panels must have separate saved layouts: hiding the explorer
  // must not overwrite the layout that remembers its width.
  const panelIds = [
    ...(isExplorerVisible && cwd ? ['explorer'] : []),
    'agent',
    ...(showWorkItemPanel ? ['work-item'] : []),
    ...(hasOpenTabs ? ['preview'] : []),
    ...(isGitReviewOpen ? ['git-review'] : []),
  ];
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'content-view-split',
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
          {isGitReviewOpen && (
            <>
              <Separator className="resize-handle" />
              <Panel id="git-review" defaultSize="40%" minSize="20%">
                <GitReviewPanel instanceId={instanceId} />
              </Panel>
            </>
          )}
        </Group>
      </div>
    </div>
  );
}
