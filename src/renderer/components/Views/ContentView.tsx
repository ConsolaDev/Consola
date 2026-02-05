import { useEffect, useRef } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useAgentStore } from '../../stores/agentStore';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useGitStatusAutoRefresh } from '../../stores/gitStatusStore';
import { sessionStorageBridge } from '../../services/sessionStorageBridge';
import { AgentPanel } from '../Agent/AgentPanel';
import { PreviewPanel } from '../PreviewPanel';
import { PathDisplay } from './PathDisplay';
import { FileExplorer } from '../FileExplorer';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  sessionId: string;
}

export function ContentView({ workspaceId, sessionId }: ContentViewProps) {
  const isExplorerVisible = useNavigationStore((state) => state.isExplorerVisible);
  const toggleExplorer = useNavigationStore((state) => state.toggleExplorer);

  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);
  const getSession = useWorkspaceStore((state) => state.getSession);
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  const openFile = usePreviewTabStore((state) => state.openFile);
  const hasOpenTabs = usePreviewTabStore((state) => state.tabs.length > 0);
  const activePreviewTabId = usePreviewTabStore((state) => state.activeTabId);

  const loadInstanceHistory = useAgentStore((state) => state.loadInstanceHistory);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'content-view-split',
    storage: localStorage,
  });

  const workspace = getWorkspace(workspaceId);

  // Track which sessions we've loaded history for
  const loadedSessionsRef = useRef<Set<string>>(new Set());

  // Track which sessions we've generated names for
  const namedSessionsRef = useRef<Set<string>>(new Set());

  // Get active session
  const session = workspace ? getSession(workspaceId, sessionId) : undefined;

  // Determine instanceId and cwd from workspace
  const instanceId = session?.instanceId ?? '';
  const cwd = workspace?.path ?? '';

  // Enable auto-refresh of git status on window focus
  useGitStatusAutoRefresh(workspace?.isGitRepo ? workspace.path : null);

  // Get message count to detect first message
  const messageCount = useAgentStore(
    (state) => state.instances[instanceId]?.messages?.length ?? 0
  );

  // Load session history when session becomes active
  useEffect(() => {
    if (session && !loadedSessionsRef.current.has(session.id)) {
      loadedSessionsRef.current.add(session.id);
      loadInstanceHistory(session.instanceId);
    }
  }, [session, loadInstanceHistory]);

  // Generate session name after first user message if session has empty name
  useEffect(() => {
    if (!session || !workspace || messageCount === 0) return;
    if (session.name !== '') return; // Session already has a name
    if (namedSessionsRef.current.has(session.id)) return;

    const messages = useAgentStore.getState().instances[instanceId]?.messages ?? [];
    const firstUserMessage = messages.find(m => m.type === 'user');

    if (firstUserMessage) {
      namedSessionsRef.current.add(session.id);
      sessionStorageBridge.generateName(firstUserMessage.content).then((name) => {
        if (name) {
          updateSession(workspaceId, session.id, { name });
        }
      });
    }
  }, [session, workspace, messageCount, workspaceId, instanceId, updateSession]);

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
            <AgentPanel instanceId={instanceId} cwd={cwd} />
          </Panel>
          {hasOpenTabs && (
            <>
              <Separator className="resize-handle" />
              <Panel id="preview" defaultSize="40%" minSize="20%">
                <PreviewPanel />
              </Panel>
            </>
          )}
        </Group>
      </div>
    </div>
  );
}
