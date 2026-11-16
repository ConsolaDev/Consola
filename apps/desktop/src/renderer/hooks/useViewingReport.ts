import { useEffect, useMemo } from 'react';
import { attentionBridge } from '../services/attentionBridge';
import { useNavigationStore } from '../stores/navigationStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { ViewingReporter, viewedInstanceId } from '../utils/viewing';

/**
 * Tell main what this window is showing and whether it has focus.
 *
 * Main decides what counts as seen from the two together; this only reports.
 * Nothing here clears a `done` state.
 */
export function useViewingReport(): void {
  const reporter = useMemo(() => new ViewingReporter(attentionBridge), []);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const overlay = useNavigationStore((state) => state.overlay);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === activeWorkspaceId)
  );
  const instanceId = viewedInstanceId({ activeSessionId, overlay }, workspace);

  useEffect(() => {
    reporter.view(instanceId);
  }, [reporter, instanceId]);

  // Closing the window ends the view; main also drops a destroyed window.
  useEffect(() => () => reporter.view(null), [reporter]);

  useEffect(() => {
    const focus = () => reporter.focus(true);
    const blur = () => reporter.focus(false);
    reporter.focus(document.hasFocus());
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
    };
  }, [reporter]);
}
