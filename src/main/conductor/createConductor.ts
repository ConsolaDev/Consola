import type { Group, NewSessionFields, Session, Workspace } from '../../shared/workspace';
import { generateId } from '../../shared/workspace';

/**
 * The orchestration door's spine: scaffold -> group -> conductor session.
 *
 * Ordering is the error handling. The scaffold goes first because a name
 * collision must fail before any record exists; the group precedes the
 * session because the session is born pointing at it. A launch failure does
 * NOT roll the scaffold back — the generated files are user-editable state
 * from the moment they land — and archives the group so a half-born
 * orchestration never lingers in the sidebar.
 */

export interface ConductorCreateRequest {
    workspaceId: string;
    scopeId: string;
    name: string;
    kickoff: string;
}

export interface CreateConductorDeps {
    getWorkspace(id: string): Workspace | undefined;
    scaffold(
        scopePath: string,
        name: string,
        kickoff: string,
        workspaceName: string
    ): Promise<string>;
    createGroup(
        workspaceId: string,
        fields: { name: string; parentGroupId?: string; conductorSessionId?: string }
    ): Group;
    updateGroup(
        workspaceId: string,
        groupId: string,
        updates: Partial<Pick<Group, 'conductorSessionId' | 'archivedAt'>>
    ): void;
    launchSession(
        workspaceId: string,
        fields: NewSessionFields & { initialPrompt?: string }
    ): Promise<Session>;
}

export async function createConductor(
    deps: CreateConductorDeps,
    request: ConductorCreateRequest
): Promise<Group> {
    const workspace = deps.getWorkspace(request.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${request.workspaceId}`);

    const scope = workspace.scopes.find((candidate) => candidate.id === request.scopeId);
    if (!scope) throw new Error(`Scope not found in workspace: ${request.scopeId}`);

    const conductorDir = await deps.scaffold(
        scope.path,
        request.name,
        request.kickoff,
        workspace.name
    );

    const group = deps.createGroup(request.workspaceId, { name: request.name });

    let session: Session;
    try {
        session = await deps.launchSession(request.workspaceId, {
            name: 'conductor',
            workspaceId: request.workspaceId,
            instanceId: generateId(),
            harnessId: workspace.defaultHarnessId,
            scopeId: request.scopeId,
            cwd: conductorDir,
            kind: 'conductor',
            groupId: group.id,
            initialPrompt: request.kickoff,
        } as NewSessionFields & { initialPrompt?: string });
    } catch (error) {
        deps.updateGroup(request.workspaceId, group.id, { archivedAt: Date.now() });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Conductor launch failed: ${message}\n` +
                `The generated files remain at ${conductorDir} — fix the cause and try again ` +
                'with the same name after removing that directory, or a new name.'
        );
    }

    deps.updateGroup(request.workspaceId, group.id, { conductorSessionId: session.id });
    return { ...group, conductorSessionId: session.id };
}
