import { useEffect, useMemo } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { driverSupportsSessionNaming } from '../../../shared/constants';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useGitStatusAutoRefresh } from '../../stores/gitStatusStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { harnessBridge } from '../../services/harnessBridge';
import { TerminalPanel } from '../Terminal';
import { PreviewPanel } from '../PreviewPanel';
import { GitReviewPanel } from '../GitReviewPanel';
import { PathDisplay } from './PathDisplay';
import { FileExplorer } from '../FileExplorer';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  sessionId: string;
}

/** How often to check whether the CLI has written a summary for the session. */
const SESSION_NAME_POLL_MS = 5000;

export function ContentView({ workspaceId, sessionId }: ContentViewProps) {
  const isExplorerVisible = useNavigationStore((state) => state.isExplorerVisible);
  const toggleExplorer = useNavigationStore((state) => state.toggleExplorer);
  const isGitReviewOpen = useGitReviewStore((state) => state.isOpen);

  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);
  const getSession = useWorkspaceStore((state) => state.getSession);
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  const openFile = usePreviewTabStore((state) => state.openFile);
  const hasOpenTabs = usePreviewTabStore((state) => state.tabs.length > 0);
  const activePreviewTabId = usePreviewTabStore((state) => state.activeTabId);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'content-view-split',
    storage: localStorage,
  });

  const workspace = getWorkspace(workspaceId);

  // Get active session
  const session = workspace ? getSession(workspaceId, sessionId) : undefined;

  // Determine instanceId and cwd from workspace
  const instanceId = session?.instanceId ?? '';
  const cwd = workspace?.path ?? '';

  const sessionName = session?.name;
  const claudeSessionId = session?.claudeSessionId;
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
    [getLaunchFields, harnessId, harnesses]
  );
  const supportsSessionNaming = driverSupportsSessionNaming(launchFields.driverId);

  // Enable auto-refresh of git status on window focus
  useGitStatusAutoRefresh(workspace?.isGitRepo ? workspace.path : null);

  // Record that this tab has launched, so reopening it resumes the
  // conversation instead of trying to create a session ID Claude already has.
  useEffect(() => {
    if (!hasStarted && sessionId) {
      void updateSession(workspaceId, sessionId, { hasStarted: true });
    }
  }, [hasStarted, sessionId, workspaceId, updateSession]);

  // The CLI writes a summary for a conversation once it has content. Adopt it
  // as the tab name, polling until it appears, and stop once the session is
  // named. Drivers whose transcripts Consola cannot read never produce one, so
  // they are skipped outright rather than polled forever.
  useEffect(() => {
    if (!claudeSessionId) return;
    if (!supportsSessionNaming) return;
    if (sessionName !== '' && sessionName !== 'New Session') return;

    let cancelled = false;

    const adoptName = () => {
      harnessBridge
        .getSessionName(claudeSessionId, launchFields)
        .then((name) => {
          if (cancelled || !name) return;
          void updateSession(workspaceId, sessionId, { name });
        })
        .catch(() => {
          // Index not written yet; the next poll will pick it up.
        });
    };

    adoptName();
    const timer = setInterval(adoptName, SESSION_NAME_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    claudeSessionId,
    sessionName,
    sessionId,
    workspaceId,
    updateSession,
    launchFields,
    supportsSessionNaming,
  ]);

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
      <div className="workspace-view-header">
        <h1 className="workspace-view-title">
          <span>{workspace.name}</span>
          {session.name && (
            <>
              <span className="workspace-view-separator">/</span>
              <span className="workspace-view-session">{session.name}</span>
            </>
          )}
        </h1>
        {workspace.path && (
          <PathDisplay
            path={workspace.path}
            className="workspace-view-path"
            showExplorerToggle
            isExplorerVisible={isExplorerVisible}
            onToggleExplorer={toggleExplorer}
          />
        )}
      </div>
      <div className="workspace-view-content">
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          {isExplorerVisible && cwd && (
            <>
              <Panel id="explorer" defaultSize="20%" minSize="15%" maxSize="40%">
                <FileExplorer
                  rootPath={cwd}
                  selectedPath={activePreviewTabId}
                  onSelectFile={handleSelectFile}
                />
              </Panel>
              <Separator className="resize-handle" />
            </>
          )}
          <Panel id="agent" defaultSize={isExplorerVisible ? "45%" : "60%"} minSize="20%">
            <TerminalPanel
              instanceId={instanceId}
              cwd={cwd}
              claudeSessionId={session.claudeSessionId}
              resume={session.hasStarted}
              harness={launchFields}
              // Read from the session record rather than re-resolved: unlike
              // the harness's launch fields, this was chosen once for this
              // conversation and must not drift.
              model={session.model}
            />
          </Panel>
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
