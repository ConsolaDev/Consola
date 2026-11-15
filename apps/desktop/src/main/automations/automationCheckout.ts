import {
    describeError,
    StartedByHandError,
    withoutGitHooks,
    type CheckoutPort,
    type CheckoutRequest,
    type PreparedCheckout,
} from '@consola/automation-engine';
import type { WorkItemRef } from '../../shared/workItems';
import { workItemKey } from '../../shared/workItems';
import type { Workspace } from '../../shared/workspace';
import { chainWorktreeStep, itemActionLaunchKey, scopeIdForPath } from '../providers/launchWorkItem';
import { toWorkItemRef } from './engineViews';
import { findStartedByHand, missingCloneMessage, type ItemWorktreeDeps } from './launchAgentRun';

export interface AutomationCheckoutDeps extends Pick<ItemWorktreeDeps, 'resolveDriver' | 'resolveRepo' | 'composeEnv'> {
    automationCheckoutPathFor(workItem: WorkItemRef): string;
    syncCheckout(clonePath: string, workItem: WorkItemRef, env: NodeJS.ProcessEnv): Promise<{ dir: string; head: string }>;
    getWorkspace(id: string): Workspace | undefined;
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
 * Bring the item's automation checkout to its head, under the locks an Inbox
 * click on the item takes, in its order: the item and action's, then the
 * item's worktree chain.
 *
 * The git and `gh` calls run in a PR author's tree, so all of them get the
 * bound account's env with git hooks off: a hook from the tree never runs.
 */
async function prepareAutomationCheckout(deps: AutomationCheckoutDeps, request: CheckoutRequest): Promise<PreparedCheckout> {
    const workspace = deps.getWorkspace(request.workspaceId);
    if (!workspace) throw new Error(`No workspace ${request.workspaceId}.`);
    const workItem = toWorkItemRef(request.workItem);
    const provider = workspace.provider;
    if (!provider) throw new Error('This workspace has no provider account bound.');
    const clonePath = deps.resolveRepo(workspace, workItem.repo);
    if (!clonePath) throw new Error(missingCloneMessage(workItem));
    const env = withoutGitHooks(await deps.composeEnv(deps.resolveDriver(provider.id), provider.accountLogin));
    const sessions = () => deps.getWorkspace(workspace.id)?.sessions ?? [];

    const sync = () =>
        chainWorktreeStep(`${workspace.id}:${workItemKey(workItem)}`, async () => {
            // Read inside the chain: a session may have been launched there while this waited.
            const dir = deps.automationCheckoutPathFor(workItem);
            const fullTools = sessions().find((session) => session.cwd === dir && session.toolPolicy !== 'read-only');
            if (fullTools) {
                // Claude trusts a folder per path: moving one a full-tools
                // session trusts would hand it the author's newest hooks.
                throw new Error(
                    `A full-tools session was launched in this item's automation checkout (“${fullTools.name}”), so Consola will not move it. Delete that session, then retry.`
                );
            }
            try {
                return await deps.syncCheckout(clonePath, workItem, env);
            } catch (error) {
                const reason = describeError(error).trim().replace(/\.+$/, '');
                throw new Error(
                    `Could not bring the automation checkout to the head of ${workItem.repo}#${workItem.number}: ${reason}. Nothing was read; retry once it can be fetched.`
                );
            }
        });

    const { startedByHand } = request;
    const { dir, head } = startedByHand
        ? // The lock an Inbox click on this item and action takes: whichever comes second sees the other's session.
          await chainWorktreeStep(itemActionLaunchKey(workspace.id, workItem, startedByHand.label), async () => {
              const byHand = findStartedByHand(sessions(), workItem, startedByHand.label, startedByHand.since);
              if (byHand) throw new StartedByHandError(byHand.name);
              return sync();
          })
        : await sync();
    return { cwd: dir, scopeId: scopeIdForPath(workspace, clonePath), head };
}
