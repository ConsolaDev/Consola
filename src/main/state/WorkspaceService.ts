import { JsonStateFile } from './JsonStateFile';
import type { InboxSection } from '../../shared/inboxSections';
import {
  createDefaultActions,
  createDefaultSectionDefaults,
  validateActionsWrite,
  type WorkItemAction,
} from '../../shared/workItemActions';
import { sameWorkItem } from '../../shared/workItems';
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
  type SessionUpdates,
  type Workspace,
  type WorkspaceProvider,
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

  public updateScope(
    workspaceId: string,
    scopeId: string,
    updates: Partial<Pick<Scope, 'name'>>
  ): void {
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              scopes: workspace.scopes.map((scope) =>
                scope.id === scopeId ? { ...scope, ...updates } : scope
              ),
              updatedAt: Date.now(),
            }
          : workspace
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

    // A workspace is never scope-less: every session resolves its cwd through
    // a scope, so there must always be at least one to point at.
    if (workspace.scopes.length <= 1) {
      throw new Error('A workspace needs at least one scope.');
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
   * Bind this workspace to a provider account, or unbind with null.
   *
   * Unbinding removes the key entirely rather than storing null: an absent
   * `provider` is what "pure local workspace, today's behavior" means, and
   * every reader tests for absence. Only the binding goes — actions and
   * section defaults are the user's and survive an unbind and a rebind.
   * Binding a workspace that has no actions yet seeds the defaults, so the
   * Inbox has verbs to offer on first paint; one that already has some
   * keeps them, edits included.
   */
  public setProviderBinding(workspaceId: string, binding: WorkspaceProvider | null): void {
    this.commit(
      this.workspaces.map((candidate) => {
        if (candidate.id !== workspaceId) return candidate;
        if (binding === null) {
          const { provider: _provider, ...rest } = candidate;
          return { ...rest, updatedAt: Date.now() };
        }
        const seed = candidate.actions.length === 0;
        const actions = seed ? createDefaultActions() : candidate.actions;
        return {
          ...candidate,
          provider: binding,
          actions,
          sectionDefaults: seed ? createDefaultSectionDefaults(actions) : candidate.sectionDefaults,
          updatedAt: Date.now(),
        };
      })
    );
  }

  /**
   * Replace a workspace's actions and section defaults in one validated
   * write. The whole write is rejected on the first problem — the panel
   * shows the message inline — and nothing is committed. Records are rebuilt
   * from the allow-list of fields, updateFilters-style: this payload arrives
   * over IPC and is persisted verbatim.
   *
   * The workspace is looked up before validating rather than only at commit
   * time, because an action's `groupId` can only be checked against the
   * groups this workspace actually has.
   */
  public setActions(
    workspaceId: string,
    actions: WorkItemAction[],
    sectionDefaults: Partial<Record<InboxSection, string>>
  ): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`No workspace ${workspaceId}`);
    const knownGroupIds = new Set(workspace.groups.map((group) => group.id));
    const verdict = validateActionsWrite({ actions, sectionDefaults }, knownGroupIds);
    if (!verdict.ok) throw new Error(verdict.message);
    const records: WorkItemAction[] = actions.map(({ id, name, appliesTo, prompt, groupId }) => ({
      id,
      name,
      appliesTo: [...appliesTo],
      prompt,
      // Presence-preserving: an unrouted action must persist without the
      // key at all, so it round-trips byte-for-byte as it did before.
      ...(groupId !== undefined ? { groupId } : {}),
    }));
    const defaults: Partial<Record<InboxSection, string>> = {};
    for (const [section, actionId] of Object.entries(sectionDefaults)) {
      if (actionId !== undefined) defaults[section as InboxSection] = actionId;
    }
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? { ...candidate, actions: records, sectionDefaults: defaults, updatedAt: Date.now() }
          : candidate
      )
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

  public updateGroup(
    workspaceId: string,
    groupId: string,
    updates: Partial<Pick<Group, 'name' | 'conductorSessionId' | 'archivedAt'>>
  ): void {
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              groups: workspace.groups.map((group) =>
                group.id === groupId ? { ...group, ...updates } : group
              ),
              updatedAt: Date.now(),
            }
          : workspace
      )
    );
  }

  /**
   * Bring an archived group back into circulation.
   *
   * A dedicated verb rather than `{ archivedAt: undefined }` through the
   * generic update, mirroring restoreHarness: lifecycle transitions get their
   * own named door, and the generic allow-list never carries `archivedAt`.
   * The explicitly-undefined key is dropped by JSON.stringify on persist, so
   * a restored group round-trips indistinguishable from one never archived.
   */
  public restoreGroup(workspaceId: string, groupId: string): void {
    this.updateGroup(workspaceId, groupId, { archivedAt: undefined });
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

  /**
   * Apply an already-filtered update (see allowedSessionUpdates).
   *
   * Linking is the one update with rules of its own: a conductor is never
   * about a work item, and a session already linked elsewhere must be
   * unlinked first — silently moving it would rewrite what the session is
   * about underneath a running agent. Re-linking to the same item is left
   * alone rather than overwritten with a possibly differently-cased ref, but
   * that alone never skips the whole call: any sibling field in the same
   * payload (e.g. `{ name, workItem }`) still commits, and only a payload
   * that has nothing left to apply is a true no-op. Unlinking always
   * succeeds and takes the action label with it: the label described a
   * launch this session no longer belongs to. Both clear as absence — the
   * keys are removed, never stored as `undefined` — the way restoreGroup's
   * persisted record never carries a null `archivedAt`.
   */
  public updateSession(workspaceId: string, sessionId: string, updates: SessionUpdates): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);

    const applied: SessionUpdates = { ...updates };
    if (session && updates.workItem !== undefined) {
      if (session.kind === 'conductor') {
        throw new Error('A conductor session cannot be linked to a work item.');
      }
      if (session.workItem) {
        if (sameWorkItem(session.workItem, updates.workItem)) {
          delete applied.workItem;
        } else {
          const { repo, type, number } = session.workItem;
          throw new Error(`This session is already linked to ${repo} ${type} #${number}. Unlink it first.`);
        }
      }
    }
    // Nothing left to write, e.g. a same-item re-link with no sibling
    // fields: skip the commit so onChange listeners see no-op as no-op.
    if (Object.keys(applied).length === 0) return;

    const unlinking = 'workItem' in applied && applied.workItem === undefined;
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              sessions: candidate.sessions.map((existing) => {
                if (existing.id !== sessionId) return existing;
                const merged = { ...existing, ...applied };
                if (!unlinking) return merged;
                const { workItem: _workItem, workItemAction: _workItemAction, ...rest } = merged;
                return rest;
              }),
              updatedAt: Date.now(),
            }
          : candidate
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
