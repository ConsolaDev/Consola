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
  private hadFileAtLoad = false;
  private readonly listeners = new Set<(workspaces: Workspace[]) => void>();

  constructor(private readonly file: JsonStateFile<WorkspaceStateFile>) {}

  /** Read from disk. Throws if the file exists but cannot be recovered. */
  public load(): void {
    const stored = this.file.read();
    this.hadFileAtLoad = stored !== null;
    this.workspaces = stored ? this.migrate(stored.workspaces, stored.version) : [];
  }

  /** Whether state already exists, which is what gates the one-time import. */
  public hasState(): boolean {
    return this.hadFileAtLoad || this.workspaces.length > 0;
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
    this.workspaces = this.migrate(workspaces, version);
    this.commit();
    return true;
  }

  public createWorkspace(
    name: string,
    path: string,
    isGitRepo: boolean,
    defaultHarnessId?: string
  ): Workspace {
    const workspace = createWorkspaceRecord(name, path, isGitRepo, defaultHarnessId);
    this.workspaces = [...this.workspaces, workspace];
    this.commit();
    return workspace;
  }

  public deleteWorkspace(id: string): void {
    this.workspaces = this.workspaces.filter((workspace) => workspace.id !== id);
    this.commit();
  }

  public updateWorkspace(
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
  ): void {
    this.workspaces = this.workspaces.map((workspace) =>
      workspace.id === id ? { ...workspace, ...updates, updatedAt: Date.now() } : workspace
    );
    this.commit();
  }

  public createSession(workspaceId: string, fields: NewSessionFields): Session | undefined {
    if (!this.workspaces.some((workspace) => workspace.id === workspaceId)) return undefined;

    const session = createSessionRecord(fields);
    this.workspaces = this.workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? {
            ...workspace,
            sessions: [...workspace.sessions, session],
            updatedAt: session.createdAt,
          }
        : workspace
    );
    this.commit();
    return session;
  }

  public updateSession(
    workspaceId: string,
    sessionId: string,
    updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
  ): void {
    this.workspaces = this.workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? {
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === sessionId ? { ...session, ...updates } : session
            ),
            updatedAt: Date.now(),
          }
        : workspace
    );
    this.commit();
  }

  public deleteSession(workspaceId: string, sessionId: string): void {
    this.workspaces = this.workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? {
            ...workspace,
            sessions: workspace.sessions.filter((session) => session.id !== sessionId),
            updatedAt: Date.now(),
          }
        : workspace
    );
    this.commit();
  }

  public onChange(listener: (workspaces: Workspace[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private migrate(workspaces: Workspace[], version: number): Workspace[] {
    const migrated = migrateWorkspaceState({ workspaces }, version) as { workspaces: Workspace[] };
    return migrated.workspaces;
  }

  /** Persist first, then notify: no listener should see state a crash would lose. */
  private commit(): void {
    this.file.write({ version: CURRENT_WORKSPACE_STATE_VERSION, workspaces: this.workspaces });
    for (const listener of this.listeners) listener(this.workspaces);
  }
}
