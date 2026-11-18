import { useEffect, useReducer } from 'react';
import type { TreeNode } from '../../sidebar/forest';
import {
  createWorkingExits,
  type WorkingExits,
  type WorkingObservation,
} from '../../sidebar/workingExits';

/**
 * One per workspace, at module scope: what the list saw survives the sidebar
 * being hidden or switched to another workspace and back.
 */
const trackers = new Map<string, WorkingExits>();

/**
 * Looks at the workspace's trees on every render, and once more when a grace
 * runs out, so a row that stopped leaves Working without waiting for some
 * other change to redraw the list.
 *
 * Fed every tree rather than only those a filter shows, so changing a filter
 * forgets nothing.
 */
export function useWorkingObservation(
  workspaceId: string | undefined,
  roots: readonly TreeNode[],
): WorkingObservation | undefined {
  const [, lookAgain] = useReducer((count: number) => count + 1, 0);
  let observation: WorkingObservation | undefined;
  if (workspaceId !== undefined) {
    let tracker = trackers.get(workspaceId);
    if (!tracker) {
      tracker = createWorkingExits();
      trackers.set(workspaceId, tracker);
    }
    observation = tracker.observe(roots, Date.now());
  }
  const due = observation?.nextDeadline ?? null;
  useEffect(() => {
    if (due === null) return;
    const timer = window.setTimeout(lookAgain, Math.max(0, due - Date.now()));
    return () => window.clearTimeout(timer);
  }, [due]);
  return observation;
}
