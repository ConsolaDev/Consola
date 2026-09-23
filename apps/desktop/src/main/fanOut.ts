import * as path from 'path';
import { generateSessionInstanceId } from '../shared/workspace';
import type { Group, Session, Workspace } from '../shared/workspace';
import type { SessionFanOutIntent, SessionFanOutResult } from '../shared/types';
import type { LaunchSessionFields } from './SessionLauncher';

/** The slices of WorkspaceService and SessionLauncher fan-out needs. */
export interface FanOutDeps {
    workspaces: {
        getAll(): Workspace[];
        createGroup(workspaceId: string, fields: { name: string }): Group;
    };
    launcher: {
        launchSession(workspaceId: string, fields: LaunchSessionFields): Promise<Session>;
    };
}

/**
 * Fan one prompt out: a fresh group, one session per target repo.
 *
 * A creation gesture, not an entity — it mints ordinary sessions into an
 * ordinary group and walks away. The group is created first so every session
 * that does launch lands in it. Launches are sequential and individually
 * guarded: a target that fails is reported and skipped, and the sessions
 * launched before it stay.
 */
export async function fanOut(
    deps: FanOutDeps,
    intent: SessionFanOutIntent
): Promise<SessionFanOutResult> {
    const workspace = deps.workspaces
        .getAll()
        .find((candidate) => candidate.id === intent.workspaceId);
    if (!workspace) {
        throw new Error(`Cannot fan out: no workspace ${intent.workspaceId}`);
    }

    const group = deps.workspaces.createGroup(intent.workspaceId, { name: intent.groupName });

    const created: Session[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    for (const targetPath of intent.targetPaths) {
        try {
            created.push(
                await deps.launcher.launchSession(intent.workspaceId, {
                    name: path.basename(targetPath),
                    workspaceId: intent.workspaceId,
                    instanceId: generateSessionInstanceId(intent.workspaceId),
                    harnessId: workspace.defaultHarnessId,
                    scopeId: intent.scopeId,
                    cwd: targetPath,
                    groupId: group.id,
                    kind: 'interactive',
                    initialPrompt: intent.prompt,
                })
            );
        } catch (error) {
            failed.push({
                path: targetPath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { group, created, failed };
}
