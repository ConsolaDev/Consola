import * as fs from 'fs';
import * as path from 'path';
import type { GitProviderId } from '../../shared/providers';
import type { WorkItemRef } from '../../shared/workItems';
import { sameWorkItem, workItemKey } from '../../shared/workItems';
import { generateSessionInstanceId, type Session, type Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import { chainWorktreeStep, itemActionLaunchKey, readyGroup, scopeIdForPath } from '../providers/launchWorkItem';
import type { LaunchSessionFields } from '../SessionLauncher';
import type { AgentLaunchRequest } from './AutomationService';

export interface AgentLaunchDeps {
    getWorkspace(id: string): Workspace | undefined;
    resolveDriver(id: GitProviderId): GitProviderDriver;
    resolveRepo(workspace: Workspace, repo: string): string | null;
    /** Where `ensureWorktree` puts an item's worktree. */
    worktreePathFor(workItem: WorkItemRef): string;
    ensureWorktree(clonePath: string, workItem: WorkItemRef, env: NodeJS.ProcessEnv): Promise<string>;
    /** Bring a clean existing PR worktree to the PR's head; false when it was left as is. */
    refreshWorktree(dir: string, workItem: WorkItemRef, env: NodeJS.ProcessEnv): Promise<boolean>;
    /** Whether `dir` must stay as it is: see `worktreeHeld`. */
    worktreeInUse(dir: string): boolean;
    composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
    restoreGroup(workspaceId: string, groupId: string): void;
    launchSession(workspaceId: string, fields: LaunchSessionFields): Promise<Session>;
}

/**
 * The person started this item's action themselves while the automation was
 * on its way: their session is the review, and the automation's run is moot.
 */
export class StartedByHandError extends Error {
    constructor(readonly sessionName: string) {
        super(`Already started by hand: “${sessionName}”.`);
        this.name = 'StartedByHandError';
    }
}

/**
 * `env` with git's hooks turned off for every git it reaches — including the
 * ones `gh` starts — by a command-line-level config entry that beats any
 * repository or user setting. Appends to entries already in `env`.
 */
export function withoutGitHooks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
    return {
        ...env,
        GIT_CONFIG_COUNT: String(count + 1),
        [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath',
        [`GIT_CONFIG_VALUE_${count}`]: '/dev/null',
    };
}

/**
 * Whether an item worktree must stay as it is, so nothing refreshes it.
 *
 * - A running session works in it, launched there or moved in since: its
 *   files must not move under it.
 * - A full-tools session was launched there, running or not. Claude trusts
 *   a folder per path, so moving a worktree it already trusts would load
 *   the PR author's newly pushed settings and hooks into that session's
 *   next launch with no trust prompt. A read-only session launches
 *   `--restricted`, which never loads them, so only a running one holds it.
 *
 * The worktree is one per item, so this is about every session on it, not
 * only the one about to run.
 */
export function worktreeHeld(sessions: readonly Session[], dir: string, isRunning: (session: Session) => boolean): boolean {
    return sessions.some((session) => {
        if (session.cwd === dir && session.toolPolicy !== 'read-only') return true;
        return (session.cwd === dir || session.agentCwd === dir) && isRunning(session);
    });
}

export type ItemWorktreeDeps = Pick<
    AgentLaunchDeps,
    'resolveDriver' | 'resolveRepo' | 'worktreePathFor' | 'ensureWorktree' | 'refreshWorktree' | 'worktreeInUse' | 'composeEnv'
>;

/**
 * The item's Consola worktree, made ready: the clone resolved among the
 * workspace's scopes, the worktree ensured under the per-item chain with git
 * hooks off, and, when `refreshExisting`, an existing one nothing holds
 * (`worktreeHeld`) brought to the PR's head. Shared by automations and the
 * Assistant so both serialise with Inbox clicks.
 *
 * Refreshing is for read-only sessions only. Claude records folder trust per
 * path, so moving a worktree the person already trusted would load the PR
 * author's newly pushed settings and hooks into a full-tools session with no
 * trust prompt. A full-tools start uses the worktree exactly as it is, and a
 * read-only start leaves alone one a full-tools session was launched in.
 */
export async function prepareItemWorktree(
    deps: ItemWorktreeDeps,
    workspace: Workspace,
    workItem: WorkItemRef,
    options: { refreshExisting: boolean }
): Promise<{ cwd: string; scopeId: string }> {
    if (!workspace.provider) throw new Error('This workspace has no provider account bound.');
    const clonePath = deps.resolveRepo(workspace, workItem.repo);
    if (!clonePath) throw new Error(`Clone ${workItem.repo} into one of this workspace’s scopes first.`);
    const driver = deps.resolveDriver(workspace.provider.id);
    // Checking a PR out runs git hooks, and a repo whose hooks path lives in
    // its own tree (husky) would run the PR's — unattended, outside any
    // sandbox, for whoever got a review requested of this person.
    const env = withoutGitHooks(await deps.composeEnv(driver, workspace.provider.accountLogin));
    const existed = fs.existsSync(path.join(deps.worktreePathFor(workItem), '.git'));
    const cwd = await chainWorktreeStep(`${workspace.id}:${workItemKey(workItem)}`, async () => {
        const dir = await deps.ensureWorktree(clonePath, workItem, env);
        if (options.refreshExisting && existed && !deps.worktreeInUse(dir)) {
            // Best effort: a refresh that fails leaves the review on what is there.
            await deps.refreshWorktree(dir, workItem, env).catch((error) =>
                console.error(`Could not bring ${dir} up to date; reviewing it as it is.`, error)
            );
        }
        return dir;
    });
    return { cwd, scopeId: scopeIdForPath(workspace, clonePath) };
}

/**
 * Before a read-only session is re-run on its pull request: bring its
 * Consola worktree to the PR's head, so the re-run reviews what is there now.
 * Does nothing for any other session, or while something holds the worktree
 * (`worktreeHeld`): a full-tools session on the same PR shares it.
 */
export async function refreshIdleWorktree(deps: ItemWorktreeDeps, workspace: Workspace, session: Session): Promise<void> {
    const workItem = session.workItem;
    const provider = workspace.provider;
    if (workItem?.type !== 'pr' || !provider) return;
    const cwd = session.cwd;
    if (!cwd || cwd !== deps.worktreePathFor(workItem)) return;
    if (!fs.existsSync(path.join(cwd, '.git')) || deps.worktreeInUse(cwd)) return;
    const env = withoutGitHooks(await deps.composeEnv(deps.resolveDriver(provider.id), provider.accountLogin));
    await chainWorktreeStep(`${workspace.id}:${workItemKey(workItem)}`, async () => {
        // Checked again inside the chain: a session may have started while this waited.
        if (deps.worktreeInUse(cwd)) return;
        await deps.refreshWorktree(cwd, workItem, env);
    });
}

/**
 * Start an automation's session: the steps of an Inbox click, but headless,
 * since there is no pane to mount — and read-only, whatever it runs.
 *
 * An item run resolves the item's repo among the workspace's scopes, runs in
 * the item's worktree (one per item, shared with Inbox launches, serialised
 * the same way), and lands in its action's group. A re-requested review
 * reads the PR as it is now: an existing worktree nobody is using is checked
 * out again when it is clean. A scheduled run starts in its scope's folder.
 * Either way the record carries where it came from, and its policy is fixed
 * for its lifetime.
 */
export async function launchAgentRun(deps: AgentLaunchDeps, request: AgentLaunchRequest): Promise<Session> {
    const workspace = deps.getWorkspace(request.workspaceId);
    if (!workspace) throw new Error(`No workspace ${request.workspaceId}.`);
    const common = {
        workspaceId: workspace.id,
        instanceId: generateSessionInstanceId(workspace.id),
        harnessId: workspace.defaultHarnessId,
        kind: 'interactive' as const,
        toolPolicy: 'read-only' as const,
        automation: { name: request.run.automation, runId: request.run.id },
        initialPrompt: request.prompt,
        // Nobody is watching: the first turn runs non-interactively, so
        // there is no composer to type into and no trust prompt to stall on.
        unattended: true,
    };

    if (!request.item) {
        const scope = workspace.scopes.find((candidate) => candidate.id === request.scopeId);
        if (!scope) throw new Error('Its scope is no longer in this workspace.');
        return deps.launchSession(workspace.id, { ...common, name: request.run.automation, scopeId: scope.id });
    }

    const { workItem, title, label } = request.item;
    if (!workspace.provider) throw new Error('This workspace has no provider account bound.');
    // Checked here too, so an automation keeps its own wording: the shared
    // step's message is not about automatic runs.
    if (!deps.resolveRepo(workspace, workItem.repo)) {
        const what = workItem.type === 'pr' ? 'review its pull requests' : 'work on its issues';
        throw new Error(`Clone ${workItem.repo} into one of this workspace’s scopes to ${what} automatically.`);
    }
    const { startedByHandSince } = request.item;
    // The same lock an Inbox click on this item and action takes: whichever
    // comes second sees the other's session.
    return chainWorktreeStep(itemActionLaunchKey(workspace.id, workItem, label), async () => {
        if (startedByHandSince !== undefined) {
            const since = Date.parse(startedByHandSince);
            const byHand = deps
                .getWorkspace(workspace.id)
                ?.sessions.find(
                    (session) =>
                        !session.automation &&
                        sameWorkItem(session.workItem, workItem) &&
                        session.workItemAction === label &&
                        session.createdAt > since
                );
            if (byHand) throw new StartedByHandError(byHand.name);
        }
        const { cwd, scopeId } = await prepareItemWorktree(deps, workspace, workItem, {
            refreshExisting: true, // automations are read-only
        });
        const groupId = readyGroup(deps, workspace, request.item!.groupId);
        return deps.launchSession(workspace.id, {
            ...common,
            name: title,
            scopeId,
            cwd,
            workItem,
            workItemAction: label,
            ...(groupId !== undefined ? { groupId } : {}),
        });
    });
}
