import { create } from 'zustand';
import { workspaceBridge } from '../services/workspaceBridge';
import {
  type NewSessionFields,
  type Scope,
  type Session,
  type Workspace,
} from '../../shared/workspace';

export type { Scope, Session, Workspace } from '../../shared/workspace';
export { migrateWorkspaceState } from '../../shared/workspace';

interface WorkspaceState {
  workspaces: Workspace[];
  createWorkspace: (
    name: string,
    path: string,
    isGitRepo: boolean,
    defaultHarnessId?: string
  ) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;
  updateWorkspace: (
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
  ) => Promise<void>;
  getWorkspace: (id: string) => Workspace | undefined;
  createSession: (workspaceId: string, fields: NewSessionFields) => Promise<Session | undefined>;
  updateSession: (
    workspaceId: string,
    sessionId: string,
    updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted' | 'groupId'>>
  ) => Promise<void>;
  deleteSession: (workspaceId: string, sessionId: string) => Promise<void>;
  getSession: (workspaceId: string, sessionId: string) => Session | undefined;
  getWorkspaceSessions: (workspaceId: string) => Session[];
  addScope: (
    workspaceId: string,
    fields: { name: string; path: string; isGitRepo: boolean }
  ) => Promise<Scope>;
  removeScope: (workspaceId: string, scopeId: string) => Promise<void>;
  setGitHubBinding: (
    workspaceId: string,
    binding: { accountLogin: string; org?: string } | null
  ) => Promise<void>;
}

/**
 * A read-through cache over the records the main process owns.
 *
 * Reads are synchronous against the last snapshot main pushed, so every
 * component that selects `workspaces` is unchanged. Writes are intents: main
 * applies them and broadcasts, and this store replaces its snapshot wholesale.
 * No renderer ever sends a snapshot back, which is what makes two windows safe.
 */
export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  workspaces: [],

  createWorkspace: (name, path, isGitRepo, defaultHarnessId) =>
    workspaceBridge.createWorkspace(name, path, isGitRepo, defaultHarnessId),

  deleteWorkspace: (id) => workspaceBridge.deleteWorkspace(id),

  updateWorkspace: (id, updates) => workspaceBridge.updateWorkspace(id, updates),

  getWorkspace: (id) => get().workspaces.find((workspace) => workspace.id === id),

  createSession: (workspaceId, fields) => workspaceBridge.createSession(workspaceId, fields),

  updateSession: (workspaceId, sessionId, updates) =>
    workspaceBridge.updateSession(workspaceId, sessionId, updates),

  deleteSession: (workspaceId, sessionId) =>
    workspaceBridge.deleteSession(workspaceId, sessionId),

  getSession: (workspaceId, sessionId) =>
    get()
      .workspaces.find((workspace) => workspace.id === workspaceId)
      ?.sessions.find((session) => session.id === sessionId),

  getWorkspaceSessions: (workspaceId) =>
    get().workspaces.find((workspace) => workspace.id === workspaceId)?.sessions ?? [],

  addScope: (workspaceId, fields) => workspaceBridge.addScope(workspaceId, fields),

  removeScope: (workspaceId, scopeId) => workspaceBridge.removeScope(workspaceId, scopeId),

  setGitHubBinding: (workspaceId, binding) =>
    workspaceBridge.setGitHubBinding(workspaceId, binding),
}));

const LEGACY_STORAGE_KEY = 'consola-workspaces';

/**
 * The records as zustand's persist middleware left them.
 *
 * Read raw rather than through the middleware because the middleware is gone:
 * this is an archaeology function, and it runs once.
 */
function readLegacyState(): { workspaces: Workspace[]; version: number } | null {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return null;

  try {
    const envelope = JSON.parse(raw) as {
      state?: { workspaces?: Workspace[] };
      version?: number;
    };
    const workspaces = envelope.state?.workspaces;
    if (!Array.isArray(workspaces)) return null;
    return { workspaces, version: envelope.version ?? 0 };
  } catch {
    // A localStorage blob we cannot parse is not worth failing launch over:
    // main starts empty, and the raw value stays on disk to look at.
    return null;
  }
}

/**
 * Load the records from main, importing localStorage the first time.
 *
 * Called before the first render so no component ever sees an empty list it
 * would mistake for "no workspaces yet". The localStorage copy is deliberately
 * left in place after a successful import — it is the fallback for one release.
 */
export async function hydrateWorkspaceStore(): Promise<void> {
  let snapshot = await workspaceBridge.getSnapshot();

  if (snapshot.needsImport) {
    const legacy = readLegacyState();
    if (legacy) {
      await workspaceBridge.importState(legacy.workspaces, legacy.version);
      snapshot = await workspaceBridge.getSnapshot();
    }
  }

  useWorkspaceStore.setState({ workspaces: snapshot.workspaces });

  workspaceBridge.onChanged((workspaces) => {
    useWorkspaceStore.setState({ workspaces });
  });
}
