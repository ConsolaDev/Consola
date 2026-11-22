import { useEffect, useMemo, useRef } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { checkoutPathForSession, scopeForSession } from '../../../shared/workspace';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { useGitStatusAutoRefresh } from '../../stores/gitStatusStore';
import { useCheckout } from '../../stores/checkoutStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import {
  useContentWidth,
  useConversationKeepsRoom,
  useInfoPanelShown,
} from '../../stores/infoPanelRoomStore';
import {
  CONVERSATION_ROOM_PX,
  INFO_PANEL_DEFAULT_PX,
  SIDE_PANEL_MIN_PX,
} from '../../infoPanel/stepAside';
import { isInfoSectionOpen, useSettingsStore } from '../../stores/settingsStore';
import {
  looksAtPullRequest,
  useBranchPullRequestLookup,
  useFoundPullRequest,
} from '../../stores/branchPullRequestStore';
import { tabFactsFor } from '../../sidePanel/tabKinds';
import { TerminalPanel } from '../Terminal';
import { InfoPanel } from '../InfoPanel/InfoPanel';
import { SidePanel } from '../SidePanel/SidePanel';
import { SessionHeader } from './SessionHeader';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  sessionId: string;
}

export function ContentView({ workspaceId, sessionId }: ContentViewProps) {
  const isSidePanelVisible = useSidePanelStore((state) => state.layout.visible);
  // Whether the info panel is on screen: the person's setting, unless it has
  // stepped aside for a narrow pane (`infoPanel/stepAside.ts`), measured on
  // the Group below. A panel that stepped aside reads nothing.
  const infoShown = useInfoPanelShown();
  // The conversation's floor: 60 columns while all three are on screen on a
  // pane that holds them, so the panels give way first; else 20%. The
  // library re-registers a Panel whose `minSize` changes and re-validates its
  // remembered layout, and a saved one as it restores, so a split saved while
  // the person kept the info panel on a narrow pane comes back with those
  // columns.
  const conversationMinSize = useConversationKeepsRoom() ? `${CONVERSATION_ROOM_PX}px` : '20%';
  const groupRef = useRef<HTMLDivElement | null>(null);

  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);
  const getSession = useWorkspaceStore((state) => state.getSession);
  const updateSession = useWorkspaceStore((state) => state.updateSession);

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
  // What the side panel's tabs read: `useTabFacts`, split around the early
  // return below, since hooks cannot wait for the session to be found.
  const checkout = useCheckout(cwd || null);
  const foundPullRequest = useFoundPullRequest(workspace, session, checkout);

  // The one place the branch's pull request is looked up: while someone looks
  // at pull request facts, the info panel shown with its Pull request section
  // open, or the Pull request tab in front. A folded section, or a panel
  // hidden or stepped aside, asks nothing.
  const pullRequestSectionOpen = useSettingsStore((state) =>
    isInfoSectionOpen(state.infoSectionOpen, 'pull-request'),
  );
  const lookingAtPullRequest = useSidePanelStore((state) =>
    looksAtPullRequest(infoShown && pullRequestSectionOpen, state.layout),
  );
  useBranchPullRequestLookup(workspace, session, checkout, lookingAtPullRequest);

  // Conditional panels must have separate saved layouts: hiding the info
  // panel or the side panel must not overwrite the layout that remembers
  // its width.
  const panelIds = [
    'agent',
    ...(infoShown ? ['info-panel'] : []),
    ...(isSidePanelVisible ? ['side-panel'] : []),
  ];
  // Not the id the columns before the side panel saved under, so none of
  // their layouts is read back.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'session-pane',
    panelIds,
    storage: localStorage,
  });

  useContentWidth(groupRef, !!workspace && !!session);

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

  const facts = tabFactsFor(workspace, session, checkout, foundPullRequest);

  return (
    <div className="workspace-view">
      <SessionHeader key={session.id} workspace={workspace} session={session} />
      <div className="workspace-view-content">
        <Group
          elementRef={groupRef}
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          {/* The conversation. It stays the unconditional first child of this
              Group, with no wrapper that differs between layouts and the same
              key, so showing, hiding or resizing the info panel, and opening,
              closing or resizing the side panel, only resizes it: a remount
              would reattach the terminal at a captured size and could lose
              the prompt's frame (AGENTS.md, "Terminals Outlive Their
              Views"). */}
          <Panel id="agent" minSize={conversationMinSize}>
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
          </Panel>
          {/* The info panel, always the first thing after the conversation.
              Its default width, the side panel's minimum and the
              conversation's floor are `infoPanel/stepAside.ts`'s, which
              reckons `INFO_PANEL_ROOM_PX` from them and the two separators. */}
          {infoShown && (
            <>
              <Separator className="resize-handle info-panel-resize-handle" />
              <Panel
                id="info-panel"
                defaultSize={`${INFO_PANEL_DEFAULT_PX}px`}
                minSize="220px"
                maxSize="400px"
              >
                <InfoPanel facts={facts} />
              </Panel>
            </>
          )}
          {isSidePanelVisible && (
            <>
              <Separator className="resize-handle" />
              <Panel
                id="side-panel"
                defaultSize="40%"
                minSize={`${SIDE_PANEL_MIN_PX}px`}
                maxSize="75%"
              >
                <SidePanel facts={facts} />
              </Panel>
            </>
          )}
        </Group>
      </div>
    </div>
  );
}
