import type { SessionDeleteOutcome, SessionDeletePreview } from '../../shared/worktreeCleanup';
import type { HarnessSwitchPreview, HarnessSwitchResult } from '../../shared/harnessSwitch';
import type { SessionCheckout } from '../../shared/sessionCheckout';
import type {
  WorkspaceSnapshot,
  SessionFanOutIntent,
  SessionFanOutResult,
  ScopeRepo,
} from '../../shared/types';
import type { InboxSection } from '../../shared/inboxSections';
import type { WorkItemAction } from '../../shared/workItemActions';
import type {
  DeletedLabel,
  Group,
  Label,
  NewGroupFields,
  NewLabelFields,
  NewScopeFields,
  NewSessionFields,
  Scope,
  Session,
  SessionUpdates,
  Workspace,
  WorkspaceProvider,
  WorkspaceUpdates,
} from '../../shared/workspace';

/**
 * Bridge to the workspace records owned by the main process.
 *
 * Every call here is an intent, never a whole-state write: main applies it and
 * broadcasts the result, so two windows mutating at once cannot lose a record.
 */
export const workspaceBridge = {
  getSnapshot(): Promise<WorkspaceSnapshot> {
    return window.workspaceAPI.getSnapshot();
  },

  /** One-time handoff of the pre-main localStorage state. */
  importState(workspaces: Workspace[], version: number): Promise<boolean> {
    return window.workspaceAPI.importState(workspaces, version);
  },

  createWorkspace(
    name: string,
    path: string,
    isGitRepo: boolean,
    defaultHarnessId?: string,
  ): Promise<Workspace> {
    return window.workspaceAPI.createWorkspace(name, path, isGitRepo, defaultHarnessId);
  },

  updateWorkspace(id: string, updates: WorkspaceUpdates): Promise<void> {
    return window.workspaceAPI.updateWorkspace(id, updates);
  },

  deleteWorkspace(id: string): Promise<void> {
    return window.workspaceAPI.deleteWorkspace(id);
  },

  moveWorkspace(id: string, beforeId: string | null): Promise<void> {
    return window.workspaceAPI.moveWorkspace(id, beforeId);
  },

  createSession(
    workspaceId: string,
    fields: NewSessionFields,
    checkout?: SessionCheckout,
  ): Promise<Session | undefined> {
    return window.workspaceAPI.createSession(workspaceId, fields, checkout);
  },

  updateSession(workspaceId: string, sessionId: string, updates: SessionUpdates): Promise<void> {
    return window.workspaceAPI.updateSession(workspaceId, sessionId, updates);
  },

  /** Continue a read-only session's conversation in a new session with full tools. */
  forkSession(workspaceId: string, sessionId: string): Promise<Session> {
    return window.workspaceAPI.forkSession(workspaceId, sessionId);
  },

  /** What switching this session to each harness it could move to would do. */
  previewHarnessSwitch(workspaceId: string, sessionId: string): Promise<HarnessSwitchPreview[]> {
    return window.workspaceAPI.previewHarnessSwitch(workspaceId, sessionId);
  },

  /** Carry this session on in another harness, in the same tab. */
  switchHarness(
    workspaceId: string,
    sessionId: string,
    harnessId: string,
  ): Promise<HarnessSwitchResult> {
    return window.workspaceAPI.switchHarness(workspaceId, sessionId, harnessId);
  },

  /** Write a new title from this session's conversation; rejects with a message for the person. */
  regenerateSessionTitle(workspaceId: string, sessionId: string): Promise<void> {
    return window.workspaceAPI.regenerateSessionTitle(workspaceId, sessionId);
  },

  previewSessionDelete(workspaceId: string, sessionId: string): Promise<SessionDeletePreview> {
    return window.workspaceAPI.previewSessionDelete(workspaceId, sessionId);
  },

  deleteSession(workspaceId: string, sessionId: string): Promise<SessionDeleteOutcome | undefined> {
    return window.workspaceAPI.deleteSession(workspaceId, sessionId);
  },

  addScope(workspaceId: string, fields: NewScopeFields): Promise<Scope> {
    return window.workspaceAPI.addScope(workspaceId, fields);
  },

  updateScope(
    workspaceId: string,
    scopeId: string,
    updates: Partial<Pick<Scope, 'name' | 'path'>>,
  ): Promise<void> {
    return window.workspaceAPI.updateScope(workspaceId, scopeId, updates);
  },

  /** Rejects while any session still references the scope. */
  removeScope(workspaceId: string, scopeId: string): Promise<void> {
    return window.workspaceAPI.removeScope(workspaceId, scopeId);
  },

  setProviderBinding(workspaceId: string, binding: WorkspaceProvider | null): Promise<void> {
    return window.workspaceAPI.setProviderBinding(workspaceId, binding);
  },

  /** Replaces actions and section defaults in one validated write; rejects with the message. */
  setActions(
    workspaceId: string,
    actions: WorkItemAction[],
    sectionDefaults: Partial<Record<InboxSection, string>>,
  ): Promise<void> {
    return window.workspaceAPI.setActions(workspaceId, actions, sectionDefaults);
  },

  createGroup(workspaceId: string, fields: NewGroupFields): Promise<Group> {
    return window.workspaceAPI.createGroup(workspaceId, fields);
  },

  updateGroup(
    workspaceId: string,
    groupId: string,
    updates: Partial<Pick<Group, 'name' | 'emoji'>>,
  ): Promise<void> {
    return window.workspaceAPI.updateGroup(workspaceId, groupId, updates);
  },

  archiveGroup(workspaceId: string, groupId: string): Promise<void> {
    return window.workspaceAPI.archiveGroup(workspaceId, groupId);
  },

  restoreGroup(workspaceId: string, groupId: string): Promise<void> {
    return window.workspaceAPI.restoreGroup(workspaceId, groupId);
  },

  createLabel(workspaceId: string, fields: NewLabelFields): Promise<Label> {
    return window.workspaceAPI.createLabel(workspaceId, fields);
  },

  updateLabel(
    workspaceId: string,
    labelId: string,
    updates: Partial<Pick<Label, 'name' | 'emoji' | 'color'>>,
  ): Promise<void> {
    return window.workspaceAPI.updateLabel(workspaceId, labelId, updates);
  },

  /**
   * Removes the label from every session that carries it, and hands back
   * what it removed — the memento `restoreLabel` undoes it with. Null when
   * there was no such label.
   */
  deleteLabel(workspaceId: string, labelId: string): Promise<DeletedLabel | null> {
    return window.workspaceAPI.deleteLabel(workspaceId, labelId);
  },

  /** Puts a deleted label back where it was, on the sessions that had it. */
  restoreLabel(workspaceId: string, removed: DeletedLabel): Promise<void> {
    return window.workspaceAPI.restoreLabel(workspaceId, removed);
  },

  assignLabel(workspaceId: string, sessionId: string, labelId: string): Promise<void> {
    return window.workspaceAPI.assignLabel(workspaceId, sessionId, labelId);
  },

  unassignLabel(workspaceId: string, sessionId: string, labelId: string): Promise<void> {
    return window.workspaceAPI.unassignLabel(workspaceId, sessionId, labelId);
  },

  /** Fan one prompt out across target repos: N sessions in a fresh group. */
  fanOut(intent: SessionFanOutIntent): Promise<SessionFanOutResult> {
    return window.workspaceAPI.fanOut(intent);
  },

  /** The git repos a fan-out can target inside a scope. */
  listScopeRepos(workspaceId: string, scopeId: string): Promise<ScopeRepo[]> {
    return window.workspaceAPI.listScopeRepos(workspaceId, scopeId);
  },

  onChanged(callback: (workspaces: Workspace[]) => void): () => void {
    return window.workspaceAPI.onChanged(callback);
  },
};
