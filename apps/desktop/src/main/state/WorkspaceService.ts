import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JsonStateFile } from './JsonStateFile';
import type { InboxSection } from '../../shared/inboxSections';
import {
  createDefaultActions,
  createDefaultSectionDefaults,
  validateActionsWrite,
} from '../../shared/workItemActions';
import type { WorkItemAction } from '../../shared/workItemActions';
import { sameWorkItem } from '../../shared/workItems';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  createGroupRecord,
  createLabelRecord,
  createScopeRecord,
  createSessionRecord,
  createWorkspaceRecord,
  generateUuid,
  migrateWorkspaceState,
  scopeForSession,
  switchedSession,
} from '../../shared/workspace';
import type {
  DeletedLabel,
  HarnessSwitchChange,
  Group,
  Label,
  NewLabelFields,
  NewGroupFields,
  NewScopeFields,
  NewSessionFields,
  Scope,
  Session,
  SessionUpdates,
  Workspace,
  WorkspaceProvider,
  WorkspaceUpdates,
} from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';

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
    defaultHarnessId?: string,
  ): Workspace {
    const workspace = createWorkspaceRecord(name, path, isGitRepo, defaultHarnessId);
    this.commit([...this.workspaces, workspace]);
    return workspace;
  }

  public deleteWorkspace(id: string): void {
    this.commit(this.workspaces.filter((workspace) => workspace.id !== id));
  }

  /** Move one record relative to another without overwriting a stale window's snapshot. */
  public moveWorkspace(id: string, beforeId: string | null): void {
    if (typeof id !== 'string' || (beforeId !== null && typeof beforeId !== 'string')) {
      throw new Error('Invalid workspace move.');
    }
    const workspace = this.workspaces.find((candidate) => candidate.id === id);
    // Another window may have removed either record during the drag.
    if (
      !workspace ||
      id === beforeId ||
      (beforeId !== null && !this.workspaces.some((candidate) => candidate.id === beforeId))
    )
      return;
    const next = this.workspaces.filter((candidate) => candidate.id !== id);
    const index =
      beforeId === null ? next.length : next.findIndex((candidate) => candidate.id === beforeId);
    next.splice(index, 0, workspace);
    if (next.every((candidate, position) => candidate === this.workspaces[position])) return;
    this.commit(next);
  }

  public updateWorkspace(id: string, updates: WorkspaceUpdates): void {
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, ...updates, updatedAt: Date.now() } : workspace,
      ),
    );
  }

  public updateScope(
    workspaceId: string,
    scopeId: string,
    updates: Partial<Pick<Scope, 'name' | 'path'>>,
  ): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const scope = workspace?.scopes.find((candidate) => candidate.id === scopeId);
    if (!workspace || !scope) return;

    const applied: Partial<Pick<Scope, 'name' | 'path' | 'isGitRepo'>> = { ...updates };
    if (updates.path !== undefined) {
      if (typeof updates.path !== 'string' || !path.isAbsolute(updates.path)) {
        throw new Error('Choose an absolute folder path.');
      }
      try {
        if (!fs.statSync(updates.path).isDirectory()) throw new Error('Not a directory');
      } catch {
        throw new Error('Choose an existing folder.');
      }
      applied.path = path.resolve(updates.path);
      applied.isGitRepo = fs.existsSync(path.join(applied.path, '.git'));
    }

    const sessions = workspace.sessions.map((session) => {
      if (!applied.path || session.scopeId !== scopeId || !session.cwd) return session;
      const relative = path.relative(scope.path, session.cwd);
      // External checkouts stay where they are. Compare path components so
      // similarly named sibling directories do not follow this move.
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return session;
      }
      return { ...session, cwd: path.join(applied.path, relative) };
    });
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              scopes: candidate.scopes.map((existing) =>
                existing.id === scopeId ? { ...existing, ...applied } : existing,
              ),
              sessions,
              updatedAt: Date.now(),
            }
          : candidate,
      ),
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
          : candidate,
      ),
    );
    return scope;
  }

  /**
   * Remove a scope and its sessions in one write, keeping workspace groups,
   * and return the sessions that went so the caller can stop their processes.
   */
  public removeScope(workspaceId: string, scopeId: string): Session[] {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace?.scopes.some((scope) => scope.id === scopeId)) return [];

    const removed = workspace.sessions.filter((session) => session.scopeId === scopeId);
    const removedSessionIds = new Set(removed.map((session) => session.id));
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              scopes: candidate.scopes.filter((scope) => scope.id !== scopeId),
              sessions: candidate.sessions.filter((session) => !removedSessionIds.has(session.id)),
              groups: candidate.groups.map((group) => {
                if (!group.conductorSessionId || !removedSessionIds.has(group.conductorSessionId))
                  return group;
                const { conductorSessionId: _removed, ...rest } = group;
                return rest;
              }),
              updatedAt: Date.now(),
            }
          : candidate,
      ),
    );
    return removed;
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
      }),
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
    sectionDefaults: Partial<Record<InboxSection, string>>,
  ): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`No workspace ${workspaceId}`);
    const knownGroupIds = new Set(workspace.groups.map((group) => group.id));
    const verdict = validateActionsWrite({ actions, sectionDefaults }, knownGroupIds);
    if (!verdict.ok) throw new Error(verdict.message);
    const records: WorkItemAction[] = actions.map(
      ({ id, name, appliesTo, prompt, groupId, conversation }) => ({
        id,
        name,
        appliesTo: [...appliesTo],
        prompt,
        // Presence-preserving: an unrouted action must persist without the
        // key at all, so it round-trips byte-for-byte as it did before. The
        // same for the conversation setting, absent meaning 'continue'.
        ...(groupId !== undefined ? { groupId } : {}),
        ...(conversation !== undefined ? { conversation } : {}),
      }),
    );
    const defaults: Partial<Record<InboxSection, string>> = {};
    for (const [section, actionId] of Object.entries(sectionDefaults)) {
      if (actionId !== undefined) defaults[section as InboxSection] = actionId;
    }
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? { ...candidate, actions: records, sectionDefaults: defaults, updatedAt: Date.now() }
          : candidate,
      ),
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
          : candidate,
      ),
    );
    return group;
  }

  public createLabel(workspaceId: string, fields: NewLabelFields): Label {
    const label = createLabelRecord(fields);
    this.editWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      labels: [...workspace.labels, label],
    }));
    return label;
  }

  public updateLabel(
    workspaceId: string,
    labelId: string,
    updates: Partial<Pick<Label, 'name' | 'emoji' | 'color'>>,
  ): void {
    this.editWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      labels: workspace.labels.map((label) => {
        if (label.id !== labelId) return label;
        const merged = { ...label, ...updates };
        // Cleared as absence, like an unlinked work item: no stored undefined.
        if (merged.emoji === undefined) delete merged.emoji;
        if (merged.color === undefined) delete merged.color;
        return merged;
      }),
    }));
  }

  /**
   * Remove a label and take its id off every session in the same write.
   *
   * Returns what it removed, or null when there was no such label. The caller
   * needs that memento because this is the one write that destroys something
   * a person authored: the label, and its place on every session carrying it.
   * `restoreLabel` puts the memento back.
   */
  public deleteLabel(workspaceId: string, labelId: string): DeletedLabel | null {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const index = workspace?.labels.findIndex((label) => label.id === labelId) ?? -1;
    if (!workspace || index < 0) return null;
    const removed: DeletedLabel = {
      label: workspace.labels[index],
      index,
      sessionIds: workspace.sessions
        .filter((session) => session.labelIds?.includes(labelId))
        .map((session) => session.id),
    };
    this.editWorkspace(workspaceId, (current) => ({
      ...current,
      labels: current.labels.filter((label) => label.id !== labelId),
      sessions: current.sessions.map((session) => {
        if (!session.labelIds?.includes(labelId)) return session;
        const labelIds = session.labelIds.filter((id) => id !== labelId);
        const { labelIds: _previous, ...rest } = session;
        return labelIds.length > 0 ? { ...rest, labelIds } : rest;
      }),
    }));
    return removed;
  }

  /**
   * Put a deleted label back where it was, on the sessions that had it.
   *
   * One commit, like the delete: a session that has gone in the meantime is
   * skipped, and a label that is somehow back already is not added twice, so
   * undoing twice or undoing late cannot corrupt the list.
   */
  public restoreLabel(workspaceId: string, removed: DeletedLabel): void {
    const carried = new Set(removed.sessionIds);
    this.editWorkspace(workspaceId, (workspace) => {
      const labels = [...workspace.labels];
      if (!labels.some((label) => label.id === removed.label.id)) {
        labels.splice(Math.min(removed.index, labels.length), 0, removed.label);
      }
      return {
        ...workspace,
        labels,
        sessions: workspace.sessions.map((session) => {
          if (!carried.has(session.id) || session.labelIds?.includes(removed.label.id))
            return session;
          return { ...session, labelIds: [...(session.labelIds ?? []), removed.label.id] };
        }),
      };
    });
  }

  public assignLabel(workspaceId: string, sessionId: string, labelId: string): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace?.labels.some((label) => label.id === labelId))
      throw new Error(`No label ${labelId}`);
    const session = workspace.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.labelIds?.includes(labelId)) return;
    this.updateSession(workspaceId, sessionId, {
      labelIds: [...(session.labelIds ?? []), labelId],
    });
  }

  public unassignLabel(workspaceId: string, sessionId: string, labelId: string): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
    if (!session?.labelIds?.includes(labelId)) return;
    this.updateSession(workspaceId, sessionId, {
      labelIds: session.labelIds.filter((id) => id !== labelId),
    });
  }

  /** One workspace rewritten in one commit; throws for a workspace that does not exist. */
  private editWorkspace(workspaceId: string, edit: (workspace: Workspace) => Workspace): void {
    if (!this.workspaces.some((candidate) => candidate.id === workspaceId)) {
      throw new Error(`No workspace ${workspaceId}`);
    }
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId ? { ...edit(candidate), updatedAt: Date.now() } : candidate,
      ),
    );
  }

  public updateGroup(
    workspaceId: string,
    groupId: string,
    updates: Partial<Pick<Group, 'name' | 'emoji' | 'conductorSessionId' | 'archivedAt'>>,
  ): void {
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              groups: workspace.groups.map((group) =>
                group.id === groupId ? { ...group, ...updates } : group,
              ),
              updatedAt: Date.now(),
            }
          : workspace,
      ),
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
                group.id === groupId ? { ...group, archivedAt: Date.now() } : group,
              ),
              updatedAt: Date.now(),
            }
          : candidate,
      ),
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
          : workspace,
      ),
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
          throw new Error(
            `This session is already linked to ${repo} ${type} #${number}. Unlink it first.`,
          );
        }
      }
    }
    // Nothing left to write, e.g. a same-item re-link with no sibling
    // fields: skip the commit so onChange listeners see no-op as no-op.
    if (Object.keys(applied).length === 0) return;

    const unlinking = 'workItem' in applied && applied.workItem === undefined;
    // Presence with `undefined` means detach; the key goes rather than
    // lingering as an undefined a reload would not produce.
    const detaching = 'parentSessionId' in applied && applied.parentSessionId === undefined;
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              sessions: candidate.sessions.map((existing) => {
                if (existing.id !== sessionId) return existing;
                const merged = { ...existing, ...applied };
                if (detaching) delete merged.parentSessionId;
                if (!unlinking) return merged;
                const { workItem: _workItem, workItemAction: _workItemAction, ...rest } = merged;
                return rest;
              }),
              updatedAt: Date.now(),
            }
          : candidate,
      ),
    );
  }

  /**
   * Point a session at a new, empty conversation and return the updated
   * record. `claudeSessionId` defaults to a new UUID; a caller that has
   * already handed one to a live terminal passes it, so the two agree.
   *
   * The one way `claudeSessionId` changes on the same harness — the other is
   * `switchHarness`, which moves the harness with it — which is why it is a
   * verb here and absent from `allowedSessionUpdates`: everything that makes
   * the session *this* session — tab, name, harness, model, tool policy,
   * checkout, linked item — stays, and only the conversation the next spawn
   * names is replaced. `hasStarted` is set because the caller spawns at once;
   * should it never get that far, the next launch's resume of an id Claude
   * does not have falls back to a fresh conversation, which is the same
   * outcome. The old transcript is left where it is, in Claude's storage.
   */
  public replaceConversation(
    workspaceId: string,
    sessionId: string,
    claudeSessionId: string = generateUuid(),
  ): Session {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`No session ${sessionId} in workspace ${workspaceId}.`);

    const replaced: Session = { ...session, claudeSessionId, hasStarted: true };
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              sessions: candidate.sessions.map((existing) =>
                existing.id === sessionId ? replaced : existing,
              ),
              updatedAt: Date.now(),
            }
          : candidate,
      ),
    );
    return replaced;
  }

  /**
   * Move a session onto another harness, with the conversation it runs
   * there, and return the updated record.
   *
   * The one way `harnessId` ever changes, which is why it is a verb here and
   * absent from `allowedSessionUpdates`: a transcript lives in its harness's
   * config directory, so the harness and the conversation it names
   * (`claudeSessionId`) only ever change together. The record it leaves is
   * `switchedSession`'s; only conductors are refused.
   */
  public switchHarness(
    workspaceId: string,
    sessionId: string,
    change: HarnessSwitchChange,
  ): Session {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`No session ${sessionId} in workspace ${workspaceId}.`);
    if (session.kind !== 'interactive')
      throw new Error('Only your own sessions can switch harness.');

    const switched = switchedSession(session, change);
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              sessions: candidate.sessions.map((existing) =>
                existing.id === sessionId ? switched : existing,
              ),
              updatedAt: Date.now(),
            }
          : candidate,
      ),
    );
    return switched;
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
          : workspace,
      ),
    );
  }

  /**
   * Record where a session's agent works now, as its CLI reported it.
   *
   * The one writer of `agentCwd`, which is why it is absent from
   * `allowedSessionUpdates`: only the CLI knows that its agent moved itself
   * — Claude's EnterWorktree moves the process into a worktree Consola never
   * made. Kept only while it differs from where the session launches (its
   * `cwd`, else its scope's folder), so an agent that comes back clears it.
   * A report that changes nothing writes nothing: the CLI repeats itself
   * after every turn, and each write here is an fsync and a broadcast.
   */
  public recordAgentCwd(workspaceId: string, sessionId: string, reported: string): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
    if (!workspace || !session || !path.isAbsolute(reported)) return;

    const launchedIn = session.cwd ?? scopeForSession(workspace, session)?.path;
    const agentCwd =
      launchedIn && samePath(reported, launchedIn) ? undefined : path.resolve(reported);
    if (agentCwd === session.agentCwd) return;

    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              sessions: candidate.sessions.map((existing) => {
                if (existing.id !== sessionId) return existing;
                const { agentCwd: _previous, ...rest } = existing;
                return agentCwd ? { ...rest, agentCwd } : rest;
              }),
              updatedAt: Date.now(),
            }
          : candidate,
      ),
    );
  }

  /**
   * Mark sessions whose worktree a cleanup rule removed while they stayed.
   * One write for the whole batch: every commit is an fsync of the list and
   * a broadcast to every window. `cwd` is never rewritten; the rebuild puts
   * the folder back where it was.
   *
   * With `clearWorktreeRemoved`, the one writer of `removedWorktree`, which
   * is why it is absent from `allowedSessionUpdates`.
   */
  public recordWorktreesRemoved(
    entries: ReadonlyArray<{ sessionId: string; removed: RemovedWorktree }>,
  ): void {
    if (entries.length === 0) return;
    const bySession = new Map(entries.map((entry) => [entry.sessionId, entry.removed]));
    let changed = false;
    const next = this.workspaces.map((workspace) => {
      if (!workspace.sessions.some((session) => bySession.has(session.id))) return workspace;
      changed = true;
      return {
        ...workspace,
        sessions: workspace.sessions.map((session) => {
          const removed = bySession.get(session.id);
          return removed ? { ...session, removedWorktree: { ...removed } } : session;
        }),
        updatedAt: Date.now(),
      };
    });
    if (changed) this.commit(next);
  }

  /**
   * The folder is back (rebuilt, or it never went): clear the mark from
   * every session naming it. A no-op writes nothing.
   */
  public clearWorktreeRemoved(worktreePath: string): void {
    const names = (session: Session) => session.removedWorktree?.path === worktreePath;
    if (!this.workspaces.some((workspace) => workspace.sessions.some(names))) return;
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.sessions.some(names)
          ? {
              ...workspace,
              sessions: workspace.sessions.map((session) => {
                if (!names(session)) return session;
                const { removedWorktree: _removed, ...rest } = session;
                return rest;
              }),
              updatedAt: Date.now(),
            }
          : workspace,
      ),
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

/**
 * Whether two absolute paths name the same folder. Resolved through symlinks
 * only when the spellings differ: a CLI reports the folder it is in as the OS
 * resolved it, which can spell a scope chosen through a link differently.
 */
function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    // One of them is gone; a folder that no longer exists is not the other.
    return false;
  }
}
