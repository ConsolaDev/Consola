import type { Session, Workspace } from '../../shared/workspace';
import { assistantSession } from '../../shared/workspace';
import type { WorkspaceService } from '../state/WorkspaceService';

export interface AssistantServiceDeps {
    workspaces: Pick<WorkspaceService, 'getAll' | 'ensureAssistant' | 'replaceAssistant'>;
    /** Creates the Assistant's folder and brief; resolves to the folder. */
    ensureHome(workspaceId: string, workspaceName: string): Promise<string>;
    /** Tears down a session's terminal, shell and MCP endpoint, leaving its record alone. */
    stop(session: Session): void;
}

/**
 * Opens and restarts a workspace's Assistant. Opening only makes the record;
 * nothing launches until the pane mounts, like any other session.
 */
export class AssistantService {
    constructor(private readonly deps: AssistantServiceDeps) {}

    async open(workspaceId: string): Promise<Session> {
        const existing = assistantSession(this.workspace(workspaceId));
        if (existing) return existing;
        const { harnessId, cwd } = await this.launchFields(workspaceId);
        // ensureAssistant returns the record a concurrent open made meanwhile.
        return this.deps.workspaces.ensureAssistant(workspaceId, { harnessId, cwd });
    }

    /** A new conversation on the workspace's current default harness; the old process is stopped. */
    async startFresh(workspaceId: string): Promise<Session> {
        const { harnessId, cwd } = await this.launchFields(workspaceId);
        const { previous, next } = this.deps.workspaces.replaceAssistant(workspaceId, { harnessId, cwd });
        if (previous) this.deps.stop(previous);
        return next;
    }

    private async launchFields(workspaceId: string): Promise<{ harnessId: string; cwd: string }> {
        const workspace = this.workspace(workspaceId);
        if (workspace.scopes.length === 0) throw new Error('Add a scope to use the Assistant.');
        const cwd = await this.deps.ensureHome(workspaceId, workspace.name);
        // Re-read: the workspace may have changed while the folder was made.
        return { harnessId: this.workspace(workspaceId).defaultHarnessId, cwd };
    }

    private workspace(workspaceId: string): Workspace {
        const workspace = this.deps.workspaces.getAll().find((candidate) => candidate.id === workspaceId);
        if (!workspace) throw new Error('Workspace not found.');
        return workspace;
    }
}
