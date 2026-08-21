import { BUILT_IN_HARNESS_ID } from './constants';
import type { WorkItemRef } from './github';

/**
 * Workspace and session records, and the ladder that brings old ones forward.
 *
 * Shared rather than renderer-owned because the main process became the
 * authority on this state: it applies every mutation, and it runs every future
 * migration. One ladder is the only way it stays trustworthy.
 */

export interface Session {
  id: string;
  name: string;                    // From Claude's session summary, or user-provided
  // A human typed this name, so it wins permanently: the CLI-summary poll
  // never runs for a session whose name is user-set. Set, never cleared.
  nameIsUserSet?: boolean;
  workspaceId: string;             // Parent workspace
  instanceId: string;              // Terminal instance ID
  claudeSessionId: string;         // UUID passed to `claude --session-id`
  hasStarted: boolean;             // Launched before, so resume instead of create
  // Harness this conversation runs on. Fixed for the session's lifetime: the
  // transcript lives in that harness's config directory, so resuming under a
  // different one would lose the conversation.
  harnessId: string;
  // Model this conversation runs on, as the CLI's own selector value. Fixed
  // for the session's lifetime like the harness, and replayed on every resume.
  // Absent means no `--model` flag at all, so the CLI picks its own default —
  // the same "pins nothing" behaviour the built-in harness relies on.
  model?: string;
  // Where this session belongs: its home in the sidebar and the default
  // working directory. Fixed for the session's lifetime, like the harness.
  scopeId: string;
  // Where it actually runs, when that differs from the scope's path — a
  // worktree session's cwd is the worktree, its scope is the repo it belongs
  // to. Fixed for the session's lifetime.
  cwd?: string;
  // Why it exists alongside others. Mutable: dragging a session between
  // groups is an organizational act, not an identity change.
  groupId?: string;
  // What drives this session: a person, or a conductor orchestrating others.
  kind: 'interactive' | 'conductor';
  // The remote item this session was launched from, when it was. Immutable.
  workItem?: WorkItemRef;
  createdAt: number;
  lastActiveAt: number;
}

/** A durable *place* sessions run in. Few per workspace; nesting is allowed. */
export interface Scope {
  id: string;
  name: string;                    // Defaults to the folder basename
  path: string;                    // Absolute; overlap between scopes is fine
  isGitRepo: boolean;              // Cached at add time
  createdAt: number;
}

/** A plain container for sessions that belong together. */
export interface Group {
  id: string;
  name: string;
  parentGroupId?: string;          // Nesting
  conductorSessionId?: string;     // Set only by the orchestration door
  createdAt: number;
  archivedAt?: number;             // Done groups collapse out of the sidebar
}

export interface Workspace {
  id: string;
  name: string;                    // From folder name
  defaultHarnessId: string;        // Preselected when starting a conversation here
  scopes: Scope[];                 // Replaces path + isGitRepo (state v6)
  groups: Group[];
  // Absent = pure local workspace, exactly today's behavior. Present = every
  // session PTY in this workspace gets GH_TOKEN for this account.
  github?: {
    accountLogin: string;          // Which `gh` keyring account
    org?: string;                  // Scopes the Inbox query; absent = all repos
  };
  sessions: Session[];
  createdAt: number;
  updatedAt: number;
}

/** Shape version of the persisted workspace list. */
export const CURRENT_WORKSPACE_STATE_VERSION = 6;

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

/**
 * Terminal instance id for a new session in a workspace.
 *
 * Shared because both sides mint sessions: the renderer on the new-session
 * screen, and the main process when fan-out creates a fleet. One format, or
 * the "every terminal message carries instanceId" contract quietly forks.
 */
export function generateSessionInstanceId(workspaceId: string): string {
  return `workspace-${workspaceId}-session-${generateId()}`;
}

/**
 * A session ID for `claude --session-id`, which requires a valid UUID.
 *
 * Assigning it here — rather than discovering it after the fact — is what lets a
 * tab reconnect to its conversation with `--resume` on the next launch.
 */
export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for contexts where randomUUID is unavailable.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export interface NewScopeFields {
  name: string;
  path: string;
  isGitRepo: boolean;
}

/** Fields are picked, never spread: an IPC payload cannot ride extra keys in. */
export function createScopeRecord(fields: NewScopeFields): Scope {
  return {
    id: generateId(),
    name: fields.name,
    path: fields.path,
    isGitRepo: fields.isGitRepo,
    createdAt: Date.now(),
  };
}

export interface NewGroupFields {
  name: string;
  parentGroupId?: string;
  conductorSessionId?: string;
}

export function createGroupRecord(fields: NewGroupFields): Group {
  const group: Group = { id: generateId(), name: fields.name, createdAt: Date.now() };
  if (fields.parentGroupId !== undefined) group.parentGroupId = fields.parentGroupId;
  if (fields.conductorSessionId !== undefined) {
    group.conductorSessionId = fields.conductorSessionId;
  }
  return group;
}

/**
 * Same signature as before v6 on purpose: creation flows still start from one
 * chosen folder, which becomes the workspace's first scope.
 */
export function createWorkspaceRecord(
  name: string,
  path: string,
  isGitRepo: boolean,
  defaultHarnessId: string = BUILT_IN_HARNESS_ID
): Workspace {
  const now = Date.now();
  return {
    id: generateId(),
    name,
    defaultHarnessId,
    scopes: [createScopeRecord({ name, path, isGitRepo })],
    groups: [],
    sessions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export type NewSessionFields = Pick<
  Session,
  'name' | 'workspaceId' | 'instanceId' | 'harnessId' | 'model' | 'scopeId'
> &
  Partial<Pick<Session, 'cwd' | 'groupId' | 'kind' | 'workItem'>>;

export function createSessionRecord(fields: NewSessionFields): Session {
  const now = Date.now();
  return {
    ...fields,
    kind: fields.kind ?? 'interactive',
    id: generateId(),
    claudeSessionId: generateUuid(),
    hasStarted: false,
    createdAt: now,
    lastActiveAt: now,
  };
}

/**
 * The workspace's first scope — what every pre-v6 flow implicitly meant by
 * "the workspace folder". A workspace always has at least one scope: the
 * migration mints it and the UI refuses to remove the last one.
 */
export function primaryScope(workspace: Workspace): Scope | undefined {
  return workspace.scopes[0];
}

/**
 * The scope a session belongs to, falling back to the primary scope so a
 * dangling scopeId degrades to pre-v6 behavior instead of a blank pane.
 */
export function scopeForSession(
  workspace: Workspace,
  session: Pick<Session, 'scopeId'> | undefined
): Scope | undefined {
  if (!session) return primaryScope(workspace);
  return (
    workspace.scopes.find((scope) => scope.id === session.scopeId) ?? primaryScope(workspace)
  );
}

/**
 * The last path segment, or undefined for an empty path.
 *
 * Hand-rolled rather than node's `path.basename` because this module is
 * shared with the renderer, where node builtins are unavailable.
 */
function scopeNameFromPath(target: unknown): string | undefined {
  if (typeof target !== 'string' || target === '') return undefined;
  const segments = target.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

/**
 * Bring persisted state forward to the current shape.
 *
 * v2 -> v3 removes projects and adds path to workspace;
 * v3 -> v4 gives every session a Claude session UUID;
 * v4 -> v5 binds every workspace and session to a harness;
 * v5 -> v6 folds the workspace folder into a single scope and binds sessions to it.
 *
 * Exported so the migration can be exercised on its own — it is the one piece
 * of this state whose failure would cost people conversations.
 */
export function migrateWorkspaceState(persistedState: unknown, version: number): unknown {
  const state = persistedState as { workspaces: unknown[] };

  if (state.workspaces && version < 4) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.workspaces = state.workspaces.map((ws: any) => {
      // If workspace has no path, try to get it from first project
      if (!ws.path && ws.projects && ws.projects.length > 0) {
        const firstProject = ws.projects[0];
        return {
          id: ws.id,
          name: ws.name,
          path: firstProject.path,
          isGitRepo: firstProject.isGitRepo ?? false,
          sessions: (ws.sessions ?? []).map((s: Record<string, unknown>) => ({
            id: s.id,
            name: s.name,
            workspaceId: s.workspaceId,
            instanceId: s.instanceId,
            claudeSessionId: (s.claudeSessionId as string) ?? generateUuid(),
            hasStarted: (s.hasStarted as boolean) ?? false,
            createdAt: s.createdAt,
            lastActiveAt: s.lastActiveAt,
          })),
          createdAt: ws.createdAt,
          updatedAt: ws.updatedAt,
        };
      }
      // Workspace already has path or no projects - ensure correct shape
      return {
        id: ws.id,
        name: ws.name,
        path: ws.path ?? '',
        isGitRepo: ws.isGitRepo ?? false,
        sessions: (ws.sessions ?? []).map((s: Record<string, unknown>) => ({
          id: s.id,
          name: s.name,
          workspaceId: s.workspaceId,
          instanceId: s.instanceId,
          // Pre-v4 sessions have no Claude conversation of their own:
          // their history lived in Consola's database. They get a fresh
          // session ID and start a new conversation.
          claudeSessionId: (s.claudeSessionId as string) ?? generateUuid(),
          hasStarted: (s.hasStarted as boolean) ?? false,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
        })),
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
      };
    });
  }

  if (state.workspaces && version < 5) {
    // Everything that existed before harnesses ran against the single ambient
    // environment, which is exactly what the built-in harness describes — so
    // backfilling it preserves current behavior and leaves every transcript
    // resolvable where it already lives.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.workspaces = state.workspaces.map((ws: any) => ({
      ...ws,
      defaultHarnessId: ws.defaultHarnessId ?? BUILT_IN_HARNESS_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessions: (ws.sessions ?? []).map((s: any) => ({
        ...s,
        harnessId: s.harnessId ?? BUILT_IN_HARNESS_ID,
      })),
    }));
  }

  if (state.workspaces && version < 6) {
    // v5 -> v6: the workspace's single folder becomes its single scope, and
    // every session is bound to it. A migrated workspace behaves byte-for-byte
    // as before: same path, same isGitRepo, no github binding — the GitHub
    // organs only switch on when the user binds an account.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.workspaces = state.workspaces.map((ws: any) => {
      const { path: wsPath, isGitRepo, ...rest } = ws;
      const scope: Scope = ws.scopes?.[0] ?? {
        id: generateId(),
        name: scopeNameFromPath(wsPath) ?? ws.name ?? 'workspace',
        path: typeof wsPath === 'string' ? wsPath : '',
        isGitRepo: isGitRepo ?? false,
        createdAt: ws.createdAt ?? Date.now(),
      };
      return {
        ...rest,
        scopes: ws.scopes ?? [scope],
        groups: ws.groups ?? [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessions: (ws.sessions ?? []).map((s: any) => ({
          ...s,
          scopeId: s.scopeId ?? scope.id,
          kind: s.kind ?? 'interactive',
        })),
      };
    });
  }

  return state;
}
