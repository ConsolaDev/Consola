import type { RunActionInSessionResult } from '../../shared/types';
import { actionConversation, type ActionConversation } from '../../shared/workItemActions';
import { renderActionPrompt, substitutePlaceholders } from '../../shared/workItemPrompt';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';
import type { GitProviderId } from '../../shared/providers';
import type { Workspace } from '../../shared/workspace';
import { describeError } from './errors';
import type { GitProviderDriver } from './GitProviderDriver';

export interface RunActionInSessionDeps {
  getWorkspace(id: string): Workspace | undefined;
  /** The driver for the workspace's bound provider; throws on an unknown id. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
  findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined;
  /** SessionLauncher.runInSession: delivery, and the conversation swap for 'fresh'. */
  runInSession(
    workspaceId: string,
    sessionId: string,
    prompt: string,
    conversation: ActionConversation
  ): Promise<void>;
}

/**
 * Run a stored action in a work-item session that already exists:
 * validate -> render -> deliver.
 *
 * The item comes from the session's own link, never from the caller: an
 * action's placeholders describe what the session is about. What is sent
 * depends on the action's conversation setting. A fresh conversation knows
 * nothing yet, so it gets the provider's context header first, exactly like
 * a session launched from the Inbox; a continued one already has its
 * context, so it gets the body alone — the next thing the person would type.
 *
 * Everything that can be refused is refused before anything is touched, and
 * every failure — including one thrown by delivery — comes back as a
 * message, never as a rejected invoke.
 */
export async function runActionInSession(
  deps: RunActionInSessionDeps,
  workspaceId: string,
  sessionId: string,
  actionId: string
): Promise<RunActionInSessionResult> {
  const workspace = deps.getWorkspace(workspaceId);
  if (!workspace) return { ok: false, message: `Unknown workspace: ${workspaceId}` };
  if (!workspace.provider) return { ok: false, message: 'This workspace has no provider account bound.' };
  const session = workspace.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return { ok: false, message: 'That session no longer exists.' };
  const ref = session.workItem;
  if (!ref) return { ok: false, message: 'This session is not linked to a pull request or issue.' };
  const action = workspace.actions.find((candidate) => candidate.id === actionId);
  if (!action) return { ok: false, message: 'Unknown action.' };
  if (!action.appliesTo.includes(ref.type)) {
    return {
      ok: false,
      message: `"${action.name}" does not apply to ${ref.type === 'pr' ? 'pull requests' : 'issues'}.`,
    };
  }

  const conversation = actionConversation(action);
  try {
    const item = deps.findItem(workspaceId, ref);
    let prompt: string;
    if (conversation === 'fresh') {
      const driver = deps.resolveDriver(workspace.provider.id);
      const rendered = renderActionPrompt(driver.seedHeader(ref, item), action.prompt, ref, item);
      if (!rendered.ok) return { ok: false, message: rendered.message };
      prompt = rendered.seedPrompt;
    } else {
      prompt = substitutePlaceholders(action.prompt, ref, item).trim();
      if (!prompt) return { ok: false, message: 'This action has no prompt to send.' };
    }
    await deps.runInSession(workspaceId, session.id, prompt, conversation);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

/**
 * Coalesces a repeat of the same action on the same session while the first
 * is in flight. A double-click on a 'fresh' action would otherwise replace
 * the conversation twice and send the prompt into the second one only after
 * killing the first mid-launch. Different actions on one session still run
 * back to back, in the order they were asked for.
 */
export function createRunInSessionCoalescer(
  deps: RunActionInSessionDeps
): (workspaceId: string, sessionId: string, actionId: string) => Promise<RunActionInSessionResult> {
  const inFlight = new Map<string, Promise<RunActionInSessionResult>>();
  return (workspaceId, sessionId, actionId) => {
    const key = `${workspaceId}:${sessionId}:${actionId}`;
    const running = inFlight.get(key);
    if (running) return running;
    const job = runActionInSession(deps, workspaceId, sessionId, actionId).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  };
}
