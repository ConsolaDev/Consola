import * as path from 'path';
import type { GitProviderId } from '../../shared/providers';
import type { InboxItem, WorkItemLaunchAction, WorkItemRef } from '../../shared/workItems';
import { isValidWorkItemRef, workItemActionKey, workItemKey } from '../../shared/workItems';
import { fallbackWorkItemTitle, renderActionPrompt } from '../../shared/workItemPrompt';
import type { WorkItemPromptResult } from '../../shared/workItemPrompt';
import type { WorkItemLaunchResult } from '../../shared/types';
import { generateSessionInstanceId } from '../../shared/workspace';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import { describeError } from './errors';
import type { GitProviderDriver } from './GitProviderDriver';

export interface WorkItemLaunchDeps {
  getWorkspace(id: string): Workspace | undefined;
  /** The driver for the workspace's bound provider; throws on an unknown id. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
  createSession(workspaceId: string, fields: NewSessionFields): Session | undefined;
  resolveRepo(workspace: Workspace, repo: string): string | null;
  ensureWorktree(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<string>;
  /** Login env plus the provider's token var for this account. Composed main-side only. */
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined;
  /** Un-archives an action's target group so its arrivals are visible. */
  restoreGroup(workspaceId: string, groupId: string): void;
}

/** The deepest scope whose path contains the clone — its home in the sidebar. */
function scopeIdForPath(workspace: Workspace, clonePath: string): string {
  let best: Workspace['scopes'][number] | undefined;
  for (const scope of workspace.scopes) {
    const matches = clonePath === scope.path || clonePath.startsWith(scope.path + path.sep);
    if (matches && (!best || scope.path.length > best.path.length)) best = scope;
  }
  return (best ?? workspace.scopes[0]).id;
}

/**
 * The action's name snapshot, raw body, and the group it lands sessions in.
 * A stored action is looked up by id; a custom prompt is named 'Custom
 * prompt' so the sidebar and strip still have a label, its body is never
 * persisted anywhere, and it has no group — an ad-hoc prompt is not one of
 * the workspace's configured verbs, so it has nowhere it routinely belongs.
 *
 * Discriminates on `'id' in action`, matching the IPC door's shape check and
 * `workItemActionKey` — the same three sites must agree on which variant a
 * value is, or a payload could pass validation as one shape and be resolved
 * as the other.
 */
function resolveAction(
  workspace: Workspace,
  action: WorkItemLaunchAction
): { name: string; body: string; groupId?: string } | undefined {
  if ('id' in action) {
    const stored = workspace.actions.find((candidate) => candidate.id === action.id);
    if (!stored) return undefined;
    return {
      name: stored.name,
      body: stored.prompt,
      ...(stored.groupId !== undefined ? { groupId: stored.groupId } : {}),
    };
  }
  return { name: 'Custom prompt', body: action.customPrompt };
}

/**
 * The group a session should land in, readied for arrivals.
 *
 * Two things can go wrong with a stored target and neither may cost anyone a
 * launch. A group that no longer exists is dropped, so the session lands
 * under its scope the way an unrouted one does — losing the grouping is a
 * far smaller failure than refusing to start the work. A group that is
 * merely archived is restored: the user pointed this action here on purpose,
 * and an archived group hands its members back to their scopes, so a session
 * arriving into one would be invisible under the heading it was routed to.
 */
function readyGroup(
  deps: WorkItemLaunchDeps,
  workspace: Workspace,
  groupId: string | undefined
): string | undefined {
  if (groupId === undefined) return undefined;
  const group = workspace.groups.find((candidate) => candidate.id === groupId);
  if (!group) return undefined;
  if (group.archivedAt) deps.restoreGroup(workspace.id, group.id);
  return group.id;
}

/**
 * Serialises the worktree step for one item, keyed by workspace + item.
 *
 * Same-item, different-action launches are meant to run concurrently — a
 * "Review" and a "Fix CI" started back to back on the same PR should both
 * proceed, and that's the whole point of the action-keyed coalescer. But
 * WorktreeService.ensureWorktree is not safe under two overlapping calls for
 * one directory: both callers can see no .git and race mkdir/prune, or one
 * call's failure cleanup can remove a worktree the other just fast-pathed
 * onto. So only this step is chained per item; action resolution, rendering,
 * resolveRepo and createSession all still run concurrently.
 *
 * The map always holds a promise that resolves, never rejects — a failed
 * `run` must not poison the chain for the next caller — and each entry
 * removes itself once its chain has settled, so a quiet item's key does not
 * linger forever.
 */
const worktreeChains = new Map<string, Promise<unknown>>();

function chainWorktreeStep(key: string, run: () => Promise<string>): Promise<string> {
  const previous = worktreeChains.get(key) ?? Promise.resolve();
  const started = previous.catch(() => undefined).then(run);
  const settled = started.catch(() => undefined).then(() => {
    if (worktreeChains.get(key) === settled) worktreeChains.delete(key);
  });
  worktreeChains.set(key, settled);
  return started;
}

/**
 * Start a session from an action: validate -> render -> resolve -> worktree
 * -> record.
 *
 * Everything that can be refused cheaply (workspace, binding, ref, action,
 * an empty rendered body) is refused before any subprocess runs. The
 * worktree exists before the record does, and the record exists before any
 * PTY spawns (the spawn happens when the session pane mounts, exactly like
 * every hand-made session). On any failure nothing is created.
 *
 * Always a new session. Several sessions on one item share its worktree —
 * ensureWorktree is idempotent and keyed by item — and re-attaching is an
 * explicit "Open" in the renderer, never a side effect here.
 */
export async function launchWorkItem(
  deps: WorkItemLaunchDeps,
  workspaceId: string,
  ref: WorkItemRef,
  action: WorkItemLaunchAction
): Promise<WorkItemLaunchResult> {
  const workspace = deps.getWorkspace(workspaceId);
  if (!workspace) {
    return { ok: false, reason: 'error', message: `Unknown workspace: ${workspaceId}` };
  }
  if (!workspace.provider) {
    return { ok: false, reason: 'error', message: 'This workspace has no provider account bound.' };
  }
  if (!isValidWorkItemRef(ref)) {
    return { ok: false, reason: 'error', message: 'Invalid work item reference.' };
  }

  const resolved = resolveAction(workspace, action);
  if (!resolved) return { ok: false, reason: 'error', message: 'Unknown action.' };

  let driver: GitProviderDriver;
  try {
    driver = deps.resolveDriver(workspace.provider.id);
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }

  let item: InboxItem | undefined;
  let prompt: WorkItemPromptResult;
  try {
    // findItem and seedHeader both run off deps/driver state, not validated
    // input — a lookup miss or a broken template should degrade like any
    // other fallible step here, not reject the whole invoke.
    item = deps.findItem(workspaceId, ref);
    prompt = renderActionPrompt(driver.seedHeader(ref, item), resolved.body, ref, item);
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }
  if (!prompt.ok) return { ok: false, reason: 'error', message: prompt.message };

  // One try around resolve -> worktree -> record: every step past this
  // point can throw (a bad scope path, a git failure, a full disk), and any
  // of them must degrade the same way as the steps above rather than reject
  // the invoke with Electron's own prefixed message. `not-cloned` is a
  // normal return, not a throw, so it still reads as that reason.
  let session: Session | undefined;
  try {
    const clonePath = deps.resolveRepo(workspace, ref.repo);
    if (!clonePath) return { ok: false, reason: 'not-cloned' };

    const env = await deps.composeEnv(driver, workspace.provider.accountLogin);
    const worktreeChainKey = `${workspaceId}:${workItemKey(ref)}`;
    const worktreePath = await chainWorktreeStep(worktreeChainKey, () =>
      deps.ensureWorktree(clonePath, ref, env)
    );

    // Last, so a failed worktree step never leaves a group restored for a
    // session that was never created.
    const groupId = readyGroup(deps, workspace, resolved.groupId);

    session = deps.createSession(workspaceId, {
      name: item?.title ?? fallbackWorkItemTitle(ref),
      workspaceId,
      instanceId: generateSessionInstanceId(workspaceId),
      harnessId: workspace.defaultHarnessId,
      scopeId: scopeIdForPath(workspace, clonePath),
      cwd: worktreePath,
      kind: 'interactive',
      workItem: ref,
      workItemAction: resolved.name,
      ...(groupId !== undefined ? { groupId } : {}),
    });
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }
  if (!session) {
    return { ok: false, reason: 'error', message: 'Could not create the session record.' };
  }
  return { ok: true, session, seedPrompt: prompt.seedPrompt };
}

/**
 * Coalesces concurrent launches of the same item *and action* into one
 * in-flight call — the same in-flight-Map pattern InboxService.refresh uses
 * for concurrent refreshes of one workspace.
 *
 * Keyed by item plus action (custom prompts by item plus trimmed body): a
 * double-click on one button still mints one session, while two different
 * actions started back to back on the same item each get their own — that
 * concurrency is intentional, e.g. a review and a "fix CI" on the same PR
 * should both proceed rather than one waiting on the other. What isn't safe
 * under that concurrency is the worktree step: WorktreeService.ensureWorktree
 * cannot tolerate two overlapping calls for the same directory, so
 * launchWorkItem serialises only that step per item (see chainWorktreeStep)
 * — this coalescer's job is strictly the identical-request case above it.
 */
export function createLaunchCoalescer(
  deps: WorkItemLaunchDeps
): (
  workspaceId: string,
  ref: WorkItemRef,
  action: WorkItemLaunchAction
) => Promise<WorkItemLaunchResult> {
  const inFlight = new Map<string, Promise<WorkItemLaunchResult>>();
  return (workspaceId, ref, action) => {
    const key = `${workspaceId}:${workItemKey(ref)}:${workItemActionKey(action)}`;
    const running = inFlight.get(key);
    if (running) return running;
    const job = launchWorkItem(deps, workspaceId, ref, action).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  };
}
