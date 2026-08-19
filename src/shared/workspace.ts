import { BUILT_IN_HARNESS_ID } from './constants';

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
  workspaceId: string;             // Parent workspace
  instanceId: string;              // Terminal instance ID
  claudeSessionId: string;         // UUID passed to `claude --session-id`
  hasStarted: boolean;             // Launched before, so resume instead of create
  // Harness this conversation runs on. Fixed for the session's lifetime: the
  // transcript lives in that harness's config directory, so resuming under a
  // different one would lose the conversation.
  harnessId: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface Workspace {
  id: string;
  name: string;                    // From folder name
  path: string;                    // Absolute folder path (1:1 relationship)
  isGitRepo: boolean;              // Whether .git folder exists
  defaultHarnessId: string;        // Preselected when starting a conversation here
  sessions: Session[];
  createdAt: number;
  updatedAt: number;
}

/** Shape version of the persisted workspace list. */
export const CURRENT_WORKSPACE_STATE_VERSION = 5;

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
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
    path,
    isGitRepo,
    defaultHarnessId,
    sessions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export type NewSessionFields = Pick<Session, 'name' | 'workspaceId' | 'instanceId' | 'harnessId'>;

export function createSessionRecord(fields: NewSessionFields): Session {
  const now = Date.now();
  return {
    ...fields,
    id: generateId(),
    claudeSessionId: generateUuid(),
    hasStarted: false,
    createdAt: now,
    lastActiveAt: now,
  };
}

/**
 * Bring persisted state forward to the current shape.
 *
 * v2 -> v3 removes projects and adds path to workspace;
 * v3 -> v4 gives every session a Claude session UUID;
 * v4 -> v5 binds every workspace and session to a harness.
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

  return state;
}
