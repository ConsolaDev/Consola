import { JsonStateFile } from './JsonStateFile';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  createGroupRecord,
  createScopeRecord,
  createSessionRecord,
  createWorkspaceRecord,
  migrateWorkspaceState,
  type Group,
  type NewGroupFields,
  type NewScopeFields,
  type NewSessionFields,
  type Scope,
  type Session,
  type Workspace,
} from '../../shared/workspace';

export interface WorkspaceStateFile {
  version: number;
  workspaces: Workspace[];
}

/**
 * The single writer for workspaces and sessions.
 *
 * Renderers send intents and never whole-state writes, which is what makes two
 * windows mutating at once safe: there is no snapshot in a renderer that can go
 * stale and overwrite another window's work.
 */
export class WorkspaceService {
  private workspaces: Workspace[] = [];
  /**
   * Whether state has ever been established — loaded from disk, or written.
   *
   * Not "are there workspaces": an empty list that has been committed is
   * still state, and a one-time import that overwrote it would be data loss.
   */
  private established = false;
  private readonly listeners = new Set<(workspaces: Workspace[]) => void>();

  constructor(private readonly file: JsonStateFile<WorkspaceStateFile>) {}

  /** Read from disk. Throws if the file exists but cannot be recovered. */
  public load(): void {
    const stored = this.file.read();
    this.established = stored !== null;
    this.workspaces = stored ? this.migrate(stored.workspaces, stored.version) : [];
  }

  /** Whether state has ever been established, which is what gates the one-time import. */
  public hasState(): boolean {
    return this.established;
  }

  public getAll(): Workspace[] {
    return this.workspaces;
  }

  /**
   * Take the renderer's localStorage state, once.
   *
   * Guarded on absence rather than on a flag, so two windows racing at first
   * launch is settled by construction: the second call finds state and returns
   * false without a lock.
   */
  public importState(workspaces: Workspace[], version: number): boolean {
    if (this.hasState()) return false;
    this.commit(this.migrate(workspaces, version));
    return true;
  }

  public createWorkspace(
    name: string,
    path: string,
    isGitRepo: boolean,
    defaultHarnessId?: string
  ): Workspace {
    const workspace = createWorkspaceRecord(name, path, isGitRepo, defaultHarnessId);
    this.commit([...this.workspaces, workspace]);
    return workspace;
  }

  public deleteWorkspace(id: string): void {
    this.commit(this.workspaces.filter((workspace) => workspace.id !== id));
  }

  public updateWorkspace(
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
  ): void {
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, ...updates, updatedAt: Date.now() } : workspace
      )
    );
  }

  public addScope(workspaceId: string, fields: NewScopeFields): Scope {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`No workspace ${workspaceId}`);

    const scope = createScopeRecord(fields);
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? { ...candidate, scopes: [...candidate.scopes, scope], updatedAt: Date.now() }
          : candidate
      )
    );
    return scope;
  }

  /**
   * Remove a scope. Refuses while any session still references it: a scope is
   * only a pointer, so the rule is simply that the pointer outlives its
   * referents — there is no archive tier the way harnesses have.
   */
  public removeScope(workspaceId: string, scopeId: string): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;

    if (workspace.sessions.some((session) => session.scopeId === scopeId)) {
      throw new Error(
        'This scope still has sessions. Close or delete them before removing the scope.'
      );
    }

    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              scopes: candidate.scopes.filter((scope) => scope.id !== scopeId),
              updatedAt: Date.now(),
            }
          : candidate
      )
    );
  }

  /**
   * Bind this workspace to a `gh` keyring account, or unbind with null.
   *
   * Unbinding removes the key entirely rather than storing null: an absent
   * `github` is what "pure local workspace, today's behavior" means, and
   * every reader tests for absence.
   */
  public setGitHubBinding(
    workspaceId: string,
    binding: { accountLogin: string; org?: string } | null
  ): void {
    this.commit(
      this.workspaces.map((candidate) => {
        if (candidate.id !== workspaceId) return candidate;
        if (binding === null) {
          const { github: _github, ...rest } = candidate;
          return { ...rest, updatedAt: Date.now() };
        }
        return { ...candidate, github: binding, updatedAt: Date.now() };
      })
    );
  }

  public createGroup(workspaceId: string, fields: NewGroupFields): Group {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`No workspace ${workspaceId}`);

    const group = createGroupRecord(fields);
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? { ...candidate, groups: [...candidate.groups, group], updatedAt: Date.now() }
          : candidate
      )
    );
    return group;
  }

  /** Archive a group. Sessions keep their groupId; group UI semantics land in Phase 2. */
  public archiveGroup(workspaceId: string, groupId: string): void {
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              groups: candidate.groups.map((group) =>
                group.id === groupId ? { ...group, archivedAt: Date.now() } : group
              ),
              updatedAt: Date.now(),
            }
          : candidate
      )
    );
  }

  public createSession(workspaceId: string, fields: NewSessionFields): Session | undefined {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return undefined;
    // A session pointing at a scope that does not exist would render nowhere
    // and spawn nowhere; refuse the same quiet way an unknown workspace is.
    if (!workspace.scopes.some((scope) => scope.id === fields.scopeId)) return undefined;

    const session = createSessionRecord(fields);
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              sessions: [...workspace.sessions, session],
              updatedAt: session.createdAt,
            }
          : workspace
      )
    );
    return session;
  }

  public updateSession(
    workspaceId: string,
    sessionId: string,
    updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted' | 'groupId'>>
  ): void {
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              sessions: workspace.sessions.map((session) =>
                session.id === sessionId ? { ...session, ...updates } : session
              ),
              updatedAt: Date.now(),
            }
          : workspace
      )
    );
  }

  public deleteSession(workspaceId: string, sessionId: string): void {
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              sessions: workspace.sessions.filter((session) => session.id !== sessionId),
              updatedAt: Date.now(),
            }
          : workspace
      )
    );
  }

  public onChange(listener: (workspaces: Workspace[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private migrate(workspaces: Workspace[], version: number): Workspace[] {
    const migrated = migrateWorkspaceState({ workspaces }, version) as { workspaces: Workspace[] };
    return migrated.workspaces;
  }

  /**
   * Persist, then adopt, then notify.
   *
   * The order is the point. If the write throws, `this.workspaces` still holds
   * the last state that reached disk, so a failed mutation cannot leave a
   * reader seeing a record that does not exist — and the caller still gets the
   * exception.
   */
  private commit(next: Workspace[]): void {
    this.file.write({ version: CURRENT_WORKSPACE_STATE_VERSION, workspaces: next });
    this.workspaces = next;
    this.established = true;
    for (const listener of this.listeners) listener(next);
  }
}
