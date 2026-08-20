import { JsonStateFile } from './JsonStateFile';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  createSessionRecord,
  createWorkspaceRecord,
  migrateWorkspaceState,
  type NewSessionFields,
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

  public createSession(workspaceId: string, fields: NewSessionFields): Session | undefined {
    if (!this.workspaces.some((workspace) => workspace.id === workspaceId)) return undefined;

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
