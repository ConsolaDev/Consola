import { StartedByHandError, withoutGitHooks } from '@consola/automation-engine';
import type { CheckoutPort, CheckoutRequest, PreparedCheckout } from '@consola/automation-engine';
import type { WorkItemRef } from '../../shared/workItems';
import type { Session, Workspace } from '../../shared/workspace';
import {
  chainWorktreeStep,
  itemActionLaunchKey,
  scopeIdForPath,
} from '../providers/launchWorkItem';
import { HeadCheckoutError } from '../WorktreeService';
import { toWorkItemRef } from './engineViews';
import { findStartedByHand, launchedWithFullTools, missingCloneMessage } from './launchAgentRun';
import type { ItemWorktreeDeps } from './launchAgentRun';

export interface AutomationCheckoutDeps
  extends Pick<ItemWorktreeDeps, 'resolveDriver' | 'resolveRepo' | 'composeEnv'> {
  automationCheckoutPathFor(workItem: WorkItemRef): string;
  /** Throws `HeadCheckoutError` when the head could not be reached, anything else for any other failure. */
  syncCheckout(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv,
  ): Promise<{ dir: string; head: string }>;
  getWorkspace(id: string): Workspace | undefined;
  /**
   * Every workspace's sessions. The folder is one per item, so workspaces
   * bound to the same clone share it, and a session any of them launched
   * there counts.
   */
  allSessions(): readonly Session[];
}

/**
 * The automation checkout, the desktop's half: the git and provider work,
 * and the checks that need its session records. Whether and when a run
 * prepares it is the engine's.
 */
export function automationCheckoutPort(deps: AutomationCheckoutDeps): CheckoutPort {
  return {
    pathFor: (_workspaceId, workItem) => deps.automationCheckoutPathFor(toWorkItemRef(workItem)),
    prepare: (request) => prepareAutomationCheckout(deps, request),
  };
}

/**
 * Bring the item's automation checkout to its head. With `startedByHand`,
 * under the lock an Inbox click on the item and action takes (this
 * workspace's), then, in every case, the folder's own chain, which a
 * preparation from any workspace takes.
 *
 * The git and `gh` calls run in a PR author's tree, so all of them get the
 * bound account's env with git hooks off: a hook from the tree never runs.
 */
async function prepareAutomationCheckout(
  deps: AutomationCheckoutDeps,
  request: CheckoutRequest,
): Promise<PreparedCheckout> {
  const workspace = deps.getWorkspace(request.workspaceId);
  if (!workspace) throw new Error(`No workspace ${request.workspaceId}.`);
  const workItem = toWorkItemRef(request.workItem);
  const provider = workspace.provider;
  if (!provider) throw new Error('This workspace has no provider account bound.');
  const clonePath = deps.resolveRepo(workspace, workItem.repo);
  if (!clonePath) throw new Error(missingCloneMessage(workItem));
  const env = withoutGitHooks(
    await deps.composeEnv(deps.resolveDriver(provider.id), provider.accountLogin),
  );
  const dir = deps.automationCheckoutPathFor(workItem);

  const sync = () =>
    chainWorktreeStep(`automation-checkout:${dir}`, async () => {
      // Read inside the chain: a session may have been launched there while this waited.
      const fullTools = deps.allSessions().find((session) => launchedWithFullTools(session, dir));
      if (fullTools) {
        throw new Error(
          `A full-tools session was launched in this item's automation checkout (“${fullTools.name}”), so Consola will not move it. Delete that session, then retry.`,
        );
      }
      try {
        return await deps.syncCheckout(clonePath, workItem, env);
      } catch (error) {
        // Anything else (a folder that is not Consola's, a name two
        // repos share) fails on every retry, so it keeps its own reason.
        if (!(error instanceof HeadCheckoutError)) throw error;
        const reason = error.message.trim().replace(/\.+$/, '');
        throw new Error(
          `Could not bring the automation checkout to the head of ${workItem.repo}#${workItem.number}: ${reason}. Nothing was read; retry once it can be fetched.`,
        );
      }
    });

  const { startedByHand } = request;
  const prepared = startedByHand
    ? // The lock an Inbox click on this item and action takes: whichever comes second sees the other's session.
      await chainWorktreeStep(
        itemActionLaunchKey(workspace.id, workItem, startedByHand.label),
        async () => {
          const byHand = findStartedByHand(
            deps.getWorkspace(workspace.id)?.sessions ?? [],
            workItem,
            startedByHand.label,
            startedByHand.since,
          );
          if (byHand) throw new StartedByHandError(byHand.name);
          return sync();
        },
      )
    : await sync();
  return { cwd: prepared.dir, scopeId: scopeIdForPath(workspace, clonePath), head: prepared.head };
}
