import type { InboxItemView, ItemRef, ItemSnapshot, SessionView, WorkspaceView } from '@consola/automation-engine';
import { isGitProviderId } from '../../shared/providers';
import type { Session, SessionProvenance, Workspace } from '../../shared/workspace';
import { workItemKey, type InboxItem, type InboxSnapshot, type WorkItemRef } from '../../shared/workItems';

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

function toProvenanceView({ name, runId, step }: SessionProvenance): NonNullable<SessionView['automation']> {
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
