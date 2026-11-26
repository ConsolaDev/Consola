import type {
  InboxItemView,
  ItemRef,
  ItemSnapshot,
  SessionView,
  TurnInitView,
  TurnReportView,
  TurnResultView,
  WorkspaceView,
} from '@consola/automation-engine';
import type { TurnInit, TurnReport, TurnResult } from '../drivers';
import { isGitProviderId } from '../../shared/providers';
import type { Session, SessionProvenance, Workspace } from '../../shared/workspace';
import { workItemKey } from '../../shared/workItems';
import type { InboxItem, InboxSnapshot, WorkItemRef } from '../../shared/workItems';

/** The desktop's records, narrowed to what the engine reads. */

export function toSessionView(session: Session): SessionView {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    name: session.name,
    scopeId: session.scopeId,
    harnessId: session.harnessId,
    claudeSessionId: session.claudeSessionId,
    ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
    createdAt: session.createdAt,
    ...(session.automation ? { automation: toProvenanceView(session.automation) } : {}),
    ...(session.workItem ? { workItemKey: workItemKey(session.workItem) } : {}),
    ...(session.workItemAction !== undefined ? { workItemAction: session.workItemAction } : {}),
    ...(session.toolPolicy ? { toolPolicy: session.toolPolicy } : {}),
  };
}

function toProvenanceView({
  name,
  runId,
  step,
}: SessionProvenance): NonNullable<SessionView['automation']> {
  return { name, runId, ...(step ? { step: { id: step.id, attempt: step.attempt } } : {}) };
}

export function toWorkspaceView(workspace: Workspace): WorkspaceView {
  return {
    id: workspace.id,
    ...(workspace.provider
      ? {
          provider: {
            id: workspace.provider.id,
            accountLogin: workspace.provider.accountLogin,
            ...(workspace.provider.org ? { org: workspace.provider.org } : {}),
          },
        }
      : {}),
    actions: workspace.actions.map((action) => ({
      name: action.name,
      appliesTo: [...action.appliesTo],
      prompt: action.prompt,
      ...(action.groupId !== undefined ? { groupId: action.groupId } : {}),
    })),
    scopes: workspace.scopes.map((scope) => ({ id: scope.id, name: scope.name, path: scope.path })),
    sessions: workspace.sessions.map(toSessionView),
  };
}

export function toInboxItemView(item: InboxItem): InboxItemView {
  return {
    workItem: { ...item.workItem },
    key: workItemKey(item.workItem),
    title: item.title,
    author: item.author,
    url: item.url,
    roles: [...item.roles],
    isDraft: item.isDraft,
    state: item.state,
  };
}

export function toItemSnapshot(snapshot: InboxSnapshot): ItemSnapshot {
  return {
    workspaceId: snapshot.workspaceId,
    items: snapshot.items.map(toInboxItemView),
    fetchedAt: snapshot.fetchedAt,
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
  };
}

/** The full record behind a session id, across workspaces. */
export function sessionRecord(workspaces: Workspace[], sessionId: string): Session | undefined {
  for (const workspace of workspaces) {
    const found = workspace.sessions.find((session) => session.id === sessionId);
    if (found) return found;
  }
  return undefined;
}

/** An engine ref back to the desktop's, refusing a provider this build does not know. */
export function toWorkItemRef(ref: ItemRef): WorkItemRef {
  if (!isGitProviderId(ref.provider)) throw new Error(`Unknown provider "${ref.provider}".`);
  return { provider: ref.provider, repo: ref.repo, type: ref.type, number: ref.number };
}

/** A reporting turn's `init` as the engine reads it: the CLI's own object stays behind. */
export function toTurnInitView(init: TurnInit): TurnInitView {
  return {
    ...(init.model !== undefined ? { model: init.model } : {}),
    servers: init.servers.map(({ name, status }) => ({ name, status })),
    ...(init.signInHint !== undefined ? { signInHint: init.signInHint } : {}),
  };
}

function toTurnResultView(result: TurnResult): TurnResultView {
  return {
    subtype: result.subtype,
    isError: result.isError,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.turns !== undefined ? { turns: result.turns } : {}),
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.apiErrorStatus !== undefined ? { apiErrorStatus: result.apiErrorStatus } : {}),
    deniedTools: [...result.deniedTools],
  };
}

/**
 * A reporting turn's report as the engine reads it: parsed fields, and the
 * CLI's own `init` and `result` objects moved to `raw`, for `turn.json`.
 */
export function toTurnReportView(report: TurnReport): TurnReportView {
  const raw: TurnReportView['raw'] = {};
  if (report.init) raw.init = report.init.raw;
  if (report.result) raw.result = report.result.raw;
  return {
    ...(report.init ? { init: toTurnInitView(report.init) } : {}),
    ...(report.result ? { result: toTurnResultView(report.result) } : {}),
    otherLines: [...report.otherLines],
    ...(report.maxTurns !== undefined ? { maxTurns: report.maxTurns } : {}),
    raw,
  };
}
