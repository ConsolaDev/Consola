import type { WorkspaceIconValue } from './workspaceIcons';
import type { RemovedWorktree, WorkspaceWorktreeCleanup } from './worktreeCleanup';
import { BUILT_IN_HARNESS_ID } from './constants';
import { generateId } from './ids';
import type { InboxSection } from './inboxSections';
import type { GitProviderId } from './providers';
import {
  createDefaultActions,
  createDefaultSectionDefaults,
  defaultActionNameForType,
  type WorkItemAction,
} from './workItemActions';
import type { WorkItemRef } from './workItems';

/**
 * Workspace and session records, and the ladder that brings old ones forward.
 *
 * Shared rather than renderer-owned because the main process became the
 * authority on this state: it applies every mutation, and it runs every future
 * migration. One ladder is the only way it stays trustworthy.
 */

export interface Session {
  id: string;
  // Main's SessionNamer is the only automatic writer. A person's typed name
  // wins over automatic naming; only Regenerate title replaces it.
  name: string;
  // A name someone chose: typed, given inside the CLI, or set by a tool, the
  // Assistant, automation authoring or a harness switch's `keepName`. Never
  // set by automatic titling, which never overwrites such a name; only
  // Regenerate title replaces it.
  nameIsUserSet?: boolean;
  workspaceId: string; // Parent workspace
  instanceId: string; // Terminal instance ID
  claudeSessionId: string; // UUID passed to `claude --session-id`
  hasStarted: boolean; // Launched before, so resume instead of create
  // Harness this conversation runs on. Fixed for the conversation: the
  // transcript lives in that harness's config directory, so resuming under a
  // different one would lose it. Only a harness switch changes it, and only
  // together with `claudeSessionId` (`WorkspaceService.switchHarness`).
  harnessId: string;
  // Model this conversation runs on, as the CLI's own selector value. Fixed
  // for the conversation, like the harness, and replayed on every resume.
  // Absent means no `--model` flag at all, so the CLI picks its own default —
  // the same "pins nothing" behaviour the built-in harness relies on. A
  // harness switch clears it: a selector belongs to the harness that offered it.
  model?: string;
  // The conversations this session ran before a harness switch moved it on,
  // oldest first, each living on in its own harness's storage. Nothing
  // resumes them; the last one says how the current conversation began
  // (`switchOpening`). Written only by `switchHarness`.
  priorConversations?: ConversationLink[];
  // Where this session belongs: its home in the sidebar and the default
  // working directory. Fixed for the session's lifetime: a harness switch
  // keeps it, like everything else that says where the session belongs.
  scopeId: string;
  // Where it actually runs, when that differs from the scope's path — a
  // worktree session's cwd is the worktree, its scope is the repo it belongs
  // to. Rebased when its scope moves if it is inside the old folder.
  cwd?: string;
  // Where the agent has since moved itself, when its CLI says that differs
  // from where Consola launches it — Claude's EnterWorktree moves the whole
  // process into a worktree Consola never made. Written only by main, from
  // the CLI's own report (`WorkspaceService.recordAgentCwd`), and cleared when
  // the agent comes back, or by a harness switch, whose new process reports
  // for itself. Git state follows it; launching never does: every
  // spawn still starts in `cwd`, and the CLI reports again from there.
  agentCwd?: string;
  // Why it exists alongside others. Mutable: dragging a session between
  // groups is an organizational act, not an identity change.
  groupId?: string;
  // Filters this session carries (state v8). Any number, and never a place:
  // an id naming a deleted label is ignored on read.
  labelIds?: string[];
  // The session that spawned or conducts this one (state v8). Written at
  // creation and by the v7 -> v8 rung only: `allowedSessionUpdates` takes it
  // solely as a clear, so a session can leave a conductor but never be given
  // one. The migration infers this link from a shared group and can be wrong,
  // and a child settles and waits with its conductor — without the clear, a
  // mis-parented session could only be escaped by deleting it.
  parentSessionId?: string;
  // Opts the session out of settling on its own (the auto-settle sweep).
  autoSettle?: 'never';
  // Opts the session's worktree out of every automatic removal rule.
  autoRemoveWorktree?: 'never';
  // Set while a cleanup rule has removed this session's worktree and the
  // session stayed: opening it rebuilds the folder at `cwd`, on the recorded
  // commit (`WorktreeRebuilder`). `cwd` itself is never rewritten. Written
  // only by `WorkspaceService.recordWorktreesRemoved` and cleared by
  // `clearWorktreeRemoved`, which is why it is absent from
  // `allowedSessionUpdates`.
  removedWorktree?: RemovedWorktree;
  // What drives this session: a person, or a conductor orchestrating others.
  kind: 'interactive' | 'conductor';
  // The remote item this session is about. Mutable since v7: a hand-made
  // session can be linked to an item after the fact, or unlinked — the
  // relation says why the session exists, never where it runs.
  workItem?: WorkItemRef;
  // The action's NAME at launch — "Review", "Fix CI" — a label for the
  // sidebar and the strip. A name rather than an id so renaming or deleting
  // the action later never rewrites what a past session was. Absent for
  // sessions linked by hand.
  workItemAction?: string;
  // What this conversation's agent may do, beyond its CLI's own defaults.
  // Absent means nothing is pinned — every hand-made session. Fixed for the
  // session's lifetime, a harness switch included (a target that cannot
  // enforce it is refused), and replayed on every resume: a relaunch must
  // never lift a restriction mid-conversation.
  toolPolicy?: SessionToolPolicy;
  // The automation that started this session, when one did. Fixed: it says
  // where the session came from, not what it is doing now.
  automation?: SessionProvenance;
  createdAt: number;
  /** Creation-time seed only. Real activity lives in the attention ledger; read it through `activityOf`. */
  lastActiveAt: number;
}

/**
 * A conversation a session left behind when it switched harness, and how
 * what it said reached the next one.
 */
export interface ConversationLink {
  harnessId: string;
  claudeSessionId: string;
  /** The conversation that took over from it, on the next harness. */
  continuedAs: string;
  /** When the session moved on from it. */
  endedAt: number;
  /** `native`: the CLI forked it; `handoff`: the next agent read a transcript of it. */
  carried: 'native' | 'handoff';
  /** The handoff document, for `handoff`. */
  handoffPath?: string;
}

/** How many conversations a session remembers having switched away from. */
export const MAX_PRIOR_CONVERSATIONS = 8;

/** What a harness switch changes on a session record. */
export interface HarnessSwitchChange {
  harnessId: string;
  claudeSessionId: string;
  hasStarted: boolean;
  /** The conversation moved on from, when there was one to carry. */
  left?: ConversationLink;
  /** Pin the name: a summary of a conversation that opens with a handoff would describe the handoff. */
  keepName?: boolean;
}

/**
 * The record a harness switch leaves: the harness and the conversation it
 * names move together, the model goes with the harness that offered it, and
 * `agentCwd` with the process that reported it. Everything that makes the
 * session this session stays. Computed here once, so the record written and
 * the record a switch launches from can never differ.
 */
export function switchedSession(session: Session, change: HarnessSwitchChange): Session {
  const { model: _model, agentCwd: _agentCwd, ...kept } = session;
  const prior = change.left
    ? [...(session.priorConversations ?? []), change.left].slice(-MAX_PRIOR_CONVERSATIONS)
    : session.priorConversations;
  return {
    ...kept,
    harnessId: change.harnessId,
    claudeSessionId: change.claudeSessionId,
    hasStarted: change.hasStarted,
    ...(prior ? { priorConversations: prior } : {}),
    ...(change.keepName ? { nameIsUserSet: true } : {}),
  };
}

/**
 * How the session's current conversation began, when a harness switch began
 * it: forked from the one before, or opened with a handoff document. A
 * launch whose resume finds the conversation missing opens it this way again
 * rather than blank — Claude writes a forked conversation only once its first
 * message is sent, so one nobody has spoken in yet is not there to resume.
 */
export function switchOpening(
  session: Session,
): { forkFrom: string } | { handoffPath: string } | undefined {
  const links = session.priorConversations ?? [];
  for (let index = links.length - 1; index >= 0; index--) {
    const link = links[index];
    if (link.continuedAs !== session.claudeSessionId) continue;
    if (link.carried === 'native') return { forkFrom: link.claudeSessionId };
    return link.handoffPath ? { handoffPath: link.handoffPath } : undefined;
  }
  return undefined;
}

/**
 * `read-only`: the agent may read files and the change it is about, and run
 * nothing that could execute the item's code, load its hooks or act on the
 * provider as the person. What every automation-started session gets; each
 * harness driver maps it to its CLI's own enforcement, or refuses the launch.
 */
export type SessionToolPolicy = 'read-only';

export interface SessionProvenance {
  /** The automation's name in its workspace's factory.yml. */
  name: string;
  /** The run that launched it. */
  runId: string;
}

/** A durable *place* sessions run in. Few per workspace; nesting is allowed. */
export interface Scope {
  id: string;
  name: string; // Defaults to the folder basename
  path: string; // Absolute; overlap between scopes is fine
  isGitRepo: boolean; // Cached when the folder is selected
  createdAt: number;
}

/** A plain container for sessions that belong together. */
export interface Group {
  /** Optional native emoji; absent uses the default group icon. */
  emoji?: string;
  id: string;
  name: string;
  parentGroupId?: string; // Nesting
  conductorSessionId?: string; // Set only by the orchestration door
  createdAt: number;
  archivedAt?: number; // Done groups collapse out of the sidebar
}

/**
 * A filter a person puts on sessions. Unlike a Group it never decides where a
 * row is drawn: a session has any number of labels, and a label only hides
 * rows. A session's `labelIds` may name a label that no longer exists; readers
 * ignore it rather than anyone cleaning it up.
 */
export interface Label {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
}

/** Which provider a workspace acts on, and as whom. */
export interface WorkspaceProvider {
  id: GitProviderId;
  accountLogin: string; // Which keyring account of the provider CLI
  org?: string; // Scopes the Inbox query; absent = all repos
}

/** Name a session carries until something better is known. */
export const NEW_SESSION_NAME = 'New Session';

/** Which harness writes a workspace's session titles, and how. */
export interface SessionTitleSettings {
  source: 'off' | 'default-harness' | 'pinned';
  /** Only for `pinned`. */
  harnessId?: string;
  /** Only for `pinned`; otherwise the harness driver's default title model. */
  model?: string;
  /** Absent means the default effort; `'default'` means send no effort flag. */
  effort?: string;
  fast?: boolean;
  instructions?: string;
}

export interface Workspace {
  /** Absent means `{ source: 'default-harness' }`; no migration needed. */
  sessionTitles?: SessionTitleSettings;
  /** Absent uses the neutral workspace icon, including on older records. */
  icon?: WorkspaceIconValue;
  id: string;
  name: string; // From folder name
  defaultHarnessId: string; // Preselected when starting a conversation here
  scopes: Scope[]; // Replaces path + isGitRepo (state v6)
  groups: Group[];
  labels: Label[]; // Filters over sessions (state v8)
  // Absent = pure local workspace, exactly today's behavior. Present = every
  // session PTY in this workspace gets the provider's token for this account.
  provider?: WorkspaceProvider;
  // Ordered; [] for an unbound workspace. Seeded with the defaults when a
  // provider is bound, and edited as one validated write (set-actions).
  actions: WorkItemAction[];
  // Which action the Inbox pane highlights per section, by action id.
  sectionDefaults: Partial<Record<InboxSection, string>>;
  sessions: Session[];
  // How this workspace's worktrees are cleaned up: its own rules, off, or —
  // absent — the global rules in Preferences. Optional, so no migration.
  worktreeCleanup?: WorkspaceWorktreeCleanup;
  createdAt: number;
  updatedAt: number;
}

/** Shape version of the persisted workspace list. */
export const CURRENT_WORKSPACE_STATE_VERSION = 8;

/**
 * Terminal instance id for a new session in a workspace.
 *
 * Shared because both sides mint sessions: the renderer when starting a session, and the main process when fan-out creates a fleet. One format, or
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

export interface NewLabelFields {
  /** Only a label born with a group passes one: it shares the group's id, as the v7 -> v8 migration gives it. */
  id?: string;
  name: string;
  emoji?: string;
  color?: string;
}

export function createLabelRecord(fields: NewLabelFields): Label {
  const label: Label = { id: fields.id ?? generateId(), name: fields.name };
  if (fields.emoji !== undefined) label.emoji = fields.emoji;
  if (fields.color !== undefined) label.color = fields.color;
  return label;
}

/** The labels a session carries that still exist: a dangling id is ignored, never cleaned up. */
export function labelsForSession(workspace: Workspace, session: Session): Label[] {
  const ids = new Set(session.labelIds ?? []);
  return workspace.labels.filter((label) => ids.has(label.id));
}

export interface NewGroupFields {
  emoji?: string;
  name: string;
  parentGroupId?: string;
  conductorSessionId?: string;
}

export function createGroupRecord(fields: NewGroupFields): Group {
  const group: Group = { id: generateId(), name: fields.name, createdAt: Date.now() };
  if (fields.emoji !== undefined) group.emoji = fields.emoji;
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
  defaultHarnessId: string = BUILT_IN_HARNESS_ID,
): Workspace {
  const now = Date.now();
  return {
    id: generateId(),
    name,
    defaultHarnessId,
    scopes: [createScopeRecord({ name, path, isGitRepo })],
    groups: [],
    labels: [],
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export type NewSessionFields = Pick<
  Session,
  'name' | 'workspaceId' | 'instanceId' | 'harnessId' | 'model' | 'scopeId'
> &
  Partial<
    Pick<
      Session,
      | 'cwd'
      | 'groupId'
      | 'labelIds'
      | 'parentSessionId'
      | 'kind'
      | 'workItem'
      | 'workItemAction'
      | 'toolPolicy'
      | 'automation'
      | 'nameIsUserSet'
    >
  >;

/**
 * What deleting a label took away: enough to put it back exactly, including
 * where it sat in the list and which sessions carried it. A label is
 * user-authored organisation, and deleting one rewrites every session that
 * had it in a single commit, so the undo has to be a memento rather than a
 * second guess at what was there.
 */
export interface DeletedLabel {
  label: Label;
  /** Where in the workspace's list it sat, so Undo does not reorder the menu. */
  index: number;
  /** The sessions that carried it, in list order. */
  sessionIds: string[];
}

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
 * What a session update may carry across IPC.
 *
 * The shared definition: `src/main/state/updateFilters.ts` re-exports this
 * one, and every other layer (the service, the API types, preload, the
 * bridge, the store) imports it from here too — six copies had drifted apart.
 * `workItem` is the mutable link, with presence semantics: an explicitly
 * undefined key means unlink. Everything that fixes a session's identity
 * (`scopeId`, `cwd`, `kind`, `harnessId`, `model`, `toolPolicy`,
 * `automation`) is absent on purpose, and so is `agentCwd`: only the CLI
 * knows where its agent went. `priorConversations` is too: only a harness
 * switch knows what it left behind.
 */
export type SessionUpdates = Partial<
  Pick<
    Session,
    | 'name'
    | 'nameIsUserSet'
    | 'lastActiveAt'
    | 'hasStarted'
    | 'groupId'
    | 'workItem'
    | 'labelIds'
    | 'autoSettle'
    | 'autoRemoveWorktree'
  >
> & {
  /**
   * Only ever `undefined`, and only with the key present: detach from the
   * conductor. `allowedSessionUpdates` drops any other value.
   */
  parentSessionId?: undefined;
};

/** The workspace fields a window may change; the filter in main enforces it. */
export type WorkspaceUpdates = Partial<
  Pick<Workspace, 'name' | 'defaultHarnessId' | 'icon' | 'sessionTitles' | 'worktreeCleanup'>
>;

/**
 * The workspace's first scope — what every pre-v6 flow implicitly meant by
 * "the workspace folder". Undefined after the last scope is deleted; add a
 * scope before starting another session.
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
  session: Pick<Session, 'scopeId'> | undefined,
): Scope | undefined {
  if (!session) return primaryScope(workspace);
  return workspace.scopes.find((scope) => scope.id === session.scopeId) ?? primaryScope(workspace);
}

/**
 * The folder a session's agent works in — wherever it moved itself (a
 * worktree its CLI entered), else its own checkout when it has one (a
 * worktree Consola made), else its scope's. Git state is read from here,
 * never from the scope: a worktree has its own branch, index and changes, so
 * the scope's path would describe a different checkout than the one the agent
 * is editing. Undefined while a cleanup rule has the session's worktree removed.
 */
export function checkoutPathForSession(
  workspace: Workspace,
  session: Pick<Session, 'scopeId' | 'cwd' | 'agentCwd' | 'removedWorktree'> | undefined,
): string | undefined {
  // A worktree a cleanup rule removed has no git state to read until the
  // session is opened and it is rebuilt: undefined, rather than a folder
  // every git view would fail on.
  if (session?.removedWorktree) return undefined;
  return session?.agentCwd ?? session?.cwd ?? scopeForSession(workspace, session)?.path;
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
 * v5 -> v6 folds the workspace folder into a single scope and binds sessions to it;
 * v6 -> v7 turns the github binding into a provider binding, seeds actions, and
 *          labels every work-item session with the action it amounted to;
 * v7 -> v8 turns every group into a label (same id) and records each
 *          conductor's group members as its children. Groups, `groupId` and
 *          `conductorSessionId` stay, unread by anything new, until a later rung.
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

  if (state.workspaces && version < 7) {
    // v6 -> v7: the GitHub-shaped binding becomes a provider binding, and a
    // bound workspace receives the default actions so the Inbox has verbs to
    // offer on first paint. A session launched from a work item gets the
    // action name today's hardcoded prompt amounted to — the role it was
    // launched under was never persisted, so the item type is the best this
    // rung can do. A local-only workspace gains only the two empty fields,
    // and gains them in place, so it round-trips byte-for-byte otherwise.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.workspaces = state.workspaces.map((ws: any) => {
      const { github, ...rest } = ws;
      const provider: WorkspaceProvider | undefined =
        ws.provider ??
        (github
          ? {
              id: 'github',
              accountLogin: github.accountLogin,
              ...(github.org ? { org: github.org } : {}),
            }
          : undefined);
      const actions: WorkItemAction[] = ws.actions ?? (provider ? createDefaultActions() : []);
      const migrated = {
        ...rest,
        ...(provider ? { provider } : {}),
        actions,
        sectionDefaults:
          ws.sectionDefaults ?? (provider ? createDefaultSectionDefaults(actions) : {}),
      };
      // Set separately, after the object literal above, purely so the
      // multi-line backfill ternary below doesn't have to live inside it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrated.sessions = (ws.sessions ?? []).map((s: any) =>
        s.workItem && s.workItemAction === undefined
          ? { ...s, workItemAction: defaultActionNameForType(s.workItem.type) }
          : s,
      );
      return migrated;
    });
  }

  if (state.workspaces && version < 8) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.workspaces = state.workspaces.map((ws: any) => groupsToLabels(ws));
  }

  return state;
}

/**
 * v7 -> v8 for one workspace. Idempotent: labels reuse the group's id and are
 * merged by id, label ids are unioned, and a parent already set is kept, so a
 * second run changes nothing. Nothing is removed — only added.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function groupsToLabels(ws: any): any {
  const groups: Group[] = ws.groups ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessions: any[] = ws.sessions ?? [];
  const byId = new Map(groups.map((group) => [group.id, group]));

  /** The group and its ancestors, nearest first. A dangling parent or a cycle ends the walk. */
  const lineage = (group: Group): Group[] => {
    const chain: Group[] = [];
    const seen = new Set<string>();
    let current: Group | undefined = group;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current = current.parentGroupId ? byId.get(current.parentGroupId) : undefined;
    }
    return chain;
  };

  // A group an archived-but-populated session still reaches (directly or as
  // an ancestor) must stay a label, or its session would name nothing.
  const reached = new Set<string>();
  for (const session of sessions) {
    const group = session.groupId ? byId.get(session.groupId) : undefined;
    if (group) for (const member of lineage(group)) reached.add(member.id);
  }

  const labels: Label[] = [...(ws.labels ?? [])];
  const knownLabelIds = new Set(labels.map((label) => label.id));
  for (const group of groups) {
    if ((group.archivedAt && !reached.has(group.id)) || knownLabelIds.has(group.id)) continue;
    const path = lineage(group)
      .reverse()
      .map((member) => member.name)
      .join(' / ');
    labels.push({ id: group.id, name: path, ...(group.emoji ? { emoji: group.emoji } : {}) });
  }

  const sessionIds = new Set(sessions.map((session) => session.id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const migratedSessions = sessions.map((session: any) => {
    const group = session.groupId ? byId.get(session.groupId) : undefined;
    if (!group) return session;
    const labelIds: string[] = [...(session.labelIds ?? [])];
    for (const member of lineage(group)) {
      if (!labelIds.includes(member.id)) labelIds.push(member.id);
    }
    const next = { ...session, labelIds };
    // A conductor that no longer exists leaves its members parentless rather
    // than pointing at nothing.
    const conductorId = group.conductorSessionId;
    if (
      conductorId &&
      sessionIds.has(conductorId) &&
      session.id !== conductorId &&
      next.parentSessionId === undefined
    ) {
      next.parentSessionId = conductorId;
    }
    return next;
  });

  return { ...ws, labels, sessions: migratedSessions };
}
