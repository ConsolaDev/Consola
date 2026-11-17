import type { ConductorCreateRequest } from '../../shared/types';
import type {
  Group,
  Label,
  NewLabelFields,
  NewSessionFields,
  Session,
  Workspace,
} from '../../shared/workspace';
import { generateSessionInstanceId } from '../../shared/workspace';

/**
 * The orchestration door's spine: scaffold -> group -> conductor session.
 *
 * Ordering is the error handling. The scaffold goes first because a name
 * collision must fail before any record exists; the group and its label precede
 * the session because the session is born pointing at them. A launch failure does
 * NOT roll the scaffold back — the generated files are user-editable state
 * from the moment they land — and archives the group and drops its label so a half-born
 * orchestration never lingers in the sidebar.
 */

/** Re-exported so callers of this module need only one import. */
export type { ConductorCreateRequest };

export interface CreateConductorDeps {
  getWorkspace(id: string): Workspace | undefined;
  scaffold(
    scopePath: string,
    name: string,
    kickoff: string,
    workspaceName: string,
  ): Promise<string>;
  createGroup(
    workspaceId: string,
    fields: { name: string; parentGroupId?: string; conductorSessionId?: string },
  ): Group;
  createLabel(workspaceId: string, fields: NewLabelFields): Label;
  deleteLabel(workspaceId: string, labelId: string): void;
  updateGroup(
    workspaceId: string,
    groupId: string,
    updates: Partial<Pick<Group, 'conductorSessionId' | 'archivedAt'>>,
  ): void;
  launchSession(
    workspaceId: string,
    fields: NewSessionFields & { initialPrompt?: string },
  ): Promise<Session>;
}

export async function createConductor(
  deps: CreateConductorDeps,
  request: ConductorCreateRequest,
): Promise<Group> {
  const workspace = deps.getWorkspace(request.workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${request.workspaceId}`);

  const scope = workspace.scopes.find((candidate) => candidate.id === request.scopeId);
  if (!scope) throw new Error(`Scope not found in workspace: ${request.scopeId}`);

  const conductorDir = await deps.scaffold(
    scope.path,
    request.name,
    request.kickoff,
    workspace.name,
  );

  const group = deps.createGroup(request.workspaceId, { name: request.name });
  // The label that replaces the group in the sidebar shares its id, exactly
  // as the v7 -> v8 migration names it, so migrating over this record adds
  // nothing. The Group stays because the conductor's own tools still scope by it.
  deps.createLabel(request.workspaceId, { id: group.id, name: request.name });

  let session: Session;
  try {
    session = await deps.launchSession(request.workspaceId, {
      name: 'conductor',
      workspaceId: request.workspaceId,
      instanceId: generateSessionInstanceId(request.workspaceId),
      harnessId: workspace.defaultHarnessId,
      scopeId: request.scopeId,
      cwd: conductorDir,
      kind: 'conductor',
      groupId: group.id,
      labelIds: [group.id],
      initialPrompt: request.kickoff,
    } as NewSessionFields & { initialPrompt?: string });
  } catch (error) {
    deps.updateGroup(request.workspaceId, group.id, { archivedAt: Date.now() });
    deps.deleteLabel(request.workspaceId, group.id);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Conductor launch failed: ${message}\n` +
        `The generated files remain at ${conductorDir} — fix the cause and try again ` +
        'with the same name after removing that directory, or a new name.',
    );
  }

  deps.updateGroup(request.workspaceId, group.id, { conductorSessionId: session.id });
  return { ...group, conductorSessionId: session.id };
}
