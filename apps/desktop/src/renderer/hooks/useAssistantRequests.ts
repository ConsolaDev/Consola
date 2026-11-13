import { useEffect, useMemo } from 'react';
import { waitingAssistantRequests, type RunRecord } from '../../shared/automations';
import { assistantSession, type Workspace } from '../../shared/workspace';
import { useAutomationsStore } from '../stores/automationsStore';

const NONE: RunRecord[] = [];

/** What the workspace's Assistant asked for that is waiting for the person, newest first. */
export function useAssistantRequests(workspace: Workspace | undefined): RunRecord[] {
  const workspaceId = workspace?.id;
  const assistantId = workspace ? assistantSession(workspace)?.id : undefined;
  const snapshot = useAutomationsStore((state) => (workspaceId ? state.snapshots[workspaceId] : undefined));
  const loaded = Boolean(snapshot);

  useEffect(() => {
    if (workspaceId && !loaded) void useAutomationsStore.getState().load(workspaceId).catch(() => {});
  }, [workspaceId, loaded]);

  return useMemo(
    () => (snapshot ? waitingAssistantRequests(snapshot.runs, assistantId) : NONE),
    [snapshot, assistantId]
  );
}
