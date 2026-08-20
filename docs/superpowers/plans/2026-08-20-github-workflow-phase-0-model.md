# GitHub Workflow Phase 0 — Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a workspace an identity container — scopes replace `Workspace.path`, an optional GitHub account binding feeds `GH_TOKEN` into every PTY — with a v6 state migration that no existing user can lose a conversation to.

**Architecture:** The domain types and the v5→v6 migration land in `src/shared/workspace.ts` (one ladder, exhaustively tested). `WorkspaceService` (main, single writer) gains scope/group/binding CRUD behind new `workspace:*` IPC channels. A new `GhBroker` in `src/main/github/` wraps the `gh` CLI: `probe()` feeds the settings account picker, `token(login)` is borrowed at PTY spawn and never crosses IPC. Every renderer consumer of `workspace.path` moves to the active session's scope.

**Tech Stack:** Electron 28 (main/preload/renderer), TypeScript, Zustand, vitest (unit, co-located `src/**/*.test.ts`), Playwright (e2e), `gh` CLI as the only GitHub credential holder.

**Spec:** `docs/superpowers/specs/2026-08-20-github-workflow-design.md` (this plan implements the "Phase 0 — Model" row of its Phasing table; the spec travels with the plan — read both).

## Global Constraints

- **Main owns the records; renderers send intents** (`CLAUDE.md`). No renderer ever writes state, and every new mutation goes through `WorkspaceService.commit()` (persist → adopt → notify, in that order).
- **Bridge pattern is binding**: renderer code never touches `window.*API` directly — always through a service in `src/renderer/services/`.
- **All IPC channel names live in `src/shared/constants.ts`** under `IPC_CHANNELS`.
- **A migrated workspace behaves byte-for-byte as before until an account is bound.** The single migrated scope carries the old `path`/`isGitRepo`; no `github` key means no `GH_TOKEN`, no behavior change.
- **Tokens never appear in any IPC payload or renderer-bound object.** `GhProbeResult` carries logins only; `GhBroker.token()` is called exclusively from the main process.
- **Session identity fields are immutable by omission**: `scopeId`, `cwd`, `kind`, `workItem` stay OUT of `allowedSessionUpdates`, exactly like `harnessId` and `model`. `groupId` is allowed in (and clearable).
- **The built-in harness "pins nothing" rule, "terminals outlive their views", and "never type into a confirmation menu" are untouched** — nothing in this phase modifies prompt delivery, `CONFIRMATION_MARKERS`, or harness resolution.
- **Interface contract**: the exact names/shapes below (`Scope`, `Group`, `GhAccount`, `GhProbeResult`, `WorkItemRef`, `GhBroker.probe/token`, `addScope/removeScope/setGitHubBinding/createGroup/archiveGroup`, channel strings) are being consumed by Phase 1–3 plans written in parallel. Do not rename anything.
- **Test/verify commands**: `npm test` (vitest), `npm run typecheck`, `npm run test:e2e`.
- **Typecheck gating:** Task 1 removes `path`/`isGitRepo` from the `Workspace` type, which breaks renderer compilation until Tasks 9–11 migrate the consumers. Every task's gate is `npm test` (vitest transpiles per-file and stays green); `npx tsc -p tsconfig.main.json --noEmit` must pass from Task 5 onward; the full `npm run typecheck` must pass from Task 11 onward and is re-run in Task 13. This is expected and deliberate — do not "fix" intermediate renderer type errors ahead of their task.

## File Structure

**New files:**
- `src/shared/github.ts` — `GhAccount`, `GhProbeResult`, `WorkItemRef` (shared: both processes and the settings UI read these).
- `src/main/github/GhBroker.ts` — the `gh` wrapper: binary resolution, `probe()`, `token()`, token cache, `layerGhToken()`.
- `src/main/github/GhBroker.test.ts` — stub-`gh`-script tests.
- `src/renderer/services/githubBridge.ts` — bridge for `github:probe`.
- `src/renderer/components/GitHub/GitHubSection.tsx`, `index.ts`, `styles.css` — settings section for the account binding.

**Modified files:** `src/shared/workspace.ts` (+`.test.ts`), `src/shared/types.ts`, `src/shared/constants.ts`, `src/main/state/WorkspaceService.ts` (+`.test.ts`), `src/main/state/updateFilters.ts` (+`.test.ts`), `src/main/ipc-handlers.ts`, `src/main/TerminalService.ts`, `src/preload/preload.ts`, `src/renderer/services/workspaceBridge.ts`, `src/renderer/stores/workspaceStore.ts`, `src/renderer/components/Views/ContentView.tsx`, `src/renderer/components/Views/NewSessionView.tsx`, `src/renderer/components/GitReviewPanel/GitReviewPanel.tsx`, `src/renderer/components/CommandPalette/buildItems.ts`, `src/renderer/components/Layout/WorkspaceSwitcher.tsx`, `src/renderer/components/Sidebar/index.tsx` (+`styles.css`), `src/renderer/components/Terminal/TerminalPanel.tsx`, `src/renderer/components/Terminal/useTerminal.ts`, `src/renderer/utils/sessionActions.ts`, `src/renderer/components/Dialogs/SettingsModal.tsx`.

**Unchanged on purpose:** `HomeView.tsx`, the e2e seed helper, and every `createWorkspace(name, path, isGitRepo, defaultHarnessId?)` call — the IPC signature stays; main mints the single scope inside `createWorkspaceRecord`. `FileExplorer`, `GitChangesPanel`, `PathDisplay` read `gitStatusStore`, not `workspace.path`, and need no change.

## Cross-plan reconciliation (added at integration)

- `GhBroker` must resolve the `gh` binary from a `CONSOLA_GH_PATH` environment
  override before falling back to login-shell PATH resolution. Phase 1's unit
  and Playwright rigs depend on that seam; it also simplifies this plan's own
  stub-`gh` fixtures. Keep the no-hardcoded-fallback-paths decision otherwise.

---

### Task 1: v6 domain types, `src/shared/github.ts`, and record creators

**Files:**
- Create: `src/shared/github.ts`
- Modify: `src/shared/workspace.ts`
- Test: `src/shared/workspace.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by every later task):
  - `interface Scope { id: string; name: string; path: string; isGitRepo: boolean; createdAt: number }`
  - `interface Group { id: string; name: string; parentGroupId?: string; conductorSessionId?: string; createdAt: number; archivedAt?: number }`
  - `Session` gains `scopeId: string; cwd?: string; groupId?: string; kind: 'interactive' | 'conductor'; workItem?: WorkItemRef`
  - `Workspace` loses `path`/`isGitRepo`, gains `scopes: Scope[]; groups: Group[]; github?: { accountLogin: string; org?: string }`
  - `CURRENT_WORKSPACE_STATE_VERSION = 6`
  - `NewScopeFields`, `createScopeRecord(fields: NewScopeFields): Scope`
  - `NewGroupFields`, `createGroupRecord(fields: NewGroupFields): Group`
  - `NewSessionFields` gains required `scopeId` and optional `cwd`, `groupId`, `kind`, `workItem`
  - `createSessionRecord` defaults `kind` to `'interactive'`
  - `createWorkspaceRecord(name, path, isGitRepo, defaultHarnessId?)` — same signature, now mints the single scope
  - Helpers `primaryScope(workspace): Scope | undefined` and `scopeForSession(workspace, session?): Scope | undefined`
  - From `src/shared/github.ts`: `GhAccount`, `GhProbeResult`, `WorkItemRef`

- [ ] **Step 1: Write the failing tests** — append to `src/shared/workspace.test.ts`:

```ts
import {
  createSessionRecord,
  createWorkspaceRecord,
  primaryScope,
  scopeForSession,
  type Workspace,
} from './workspace';

describe('createWorkspaceRecord', () => {
  it('mints a single scope from the folder instead of a path field', () => {
    const workspace = createWorkspaceRecord('consola', '/code/consola', true);

    expect(workspace).not.toHaveProperty('path');
    expect(workspace).not.toHaveProperty('isGitRepo');
    expect(workspace.scopes).toHaveLength(1);
    expect(workspace.scopes[0].path).toBe('/code/consola');
    expect(workspace.scopes[0].isGitRepo).toBe(true);
    expect(workspace.scopes[0].name).toBe('consola');
    expect(workspace.groups).toEqual([]);
    expect(workspace.github).toBeUndefined();
  });
});

describe('createSessionRecord', () => {
  it('defaults kind to interactive and carries the scope', () => {
    const session = createSessionRecord({
      name: 'New Session',
      workspaceId: 'w1',
      instanceId: 'i1',
      harnessId: 'default',
      scopeId: 'scope-1',
    });

    expect(session.kind).toBe('interactive');
    expect(session.scopeId).toBe('scope-1');
    expect(session.cwd).toBeUndefined();
    expect(session.groupId).toBeUndefined();
    expect(session.workItem).toBeUndefined();
  });

  it('keeps an explicit kind', () => {
    const session = createSessionRecord({
      name: 'Conductor',
      workspaceId: 'w1',
      instanceId: 'i1',
      harnessId: 'default',
      scopeId: 'scope-1',
      kind: 'conductor',
    });

    expect(session.kind).toBe('conductor');
  });
});

describe('scope helpers', () => {
  const workspace = {
    ...createWorkspaceRecord('consola', '/code/consola', true),
  } as Workspace;

  it('primaryScope is the first scope', () => {
    expect(primaryScope(workspace)?.path).toBe('/code/consola');
  });

  it('scopeForSession resolves the session scope and falls back to primary', () => {
    const scope = workspace.scopes[0];
    expect(scopeForSession(workspace, { scopeId: scope.id })?.id).toBe(scope.id);
    expect(scopeForSession(workspace, { scopeId: 'gone' })?.id).toBe(scope.id);
    expect(scopeForSession(workspace, undefined)?.id).toBe(scope.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/shared/workspace.test.ts`
Expected: FAIL — `primaryScope` / `scopeForSession` not exported; `scopes` property missing; `scopeId` not accepted in `NewSessionFields`.

- [ ] **Step 3: Create `src/shared/github.ts`** with exactly:

```ts
/**
 * GitHub-facing shapes shared by main and renderer.
 *
 * Deliberately token-free: a token is borrowed from `gh` inside the main
 * process at the moment it is needed and never crosses IPC. Anything defined
 * here may end up in a renderer, so nothing here may ever carry a credential.
 */

/** One account in the `gh` keyring, as `gh auth status` reports it. */
export interface GhAccount {
  login: string;
  /** Whether `gh` itself would use this account today (its active account). */
  active: boolean;
}

/** What probing the `gh` CLI found. Feeds the settings account picker. */
export interface GhProbeResult {
  /** The binary was found and runs. */
  available: boolean;
  /** Path actually resolved, when one was found. */
  resolvedBinary?: string;
  version?: string;
  /** Empty when nobody is signed in — the UI offers `gh auth login`. */
  accounts: GhAccount[];
  error?: string;
}

/**
 * A remote work item a session was launched from. Immutable on the session,
 * like `harnessId`: it names why the session exists.
 */
export interface WorkItemRef {
  provider: 'github';
  /** "owner/name", e.g. "sympower/controller-app". */
  repo: string;
  type: 'pr' | 'issue';
  number: number;
}
```

- [ ] **Step 4: Rewrite the type section of `src/shared/workspace.ts`**

Add the import at the top (below the existing `constants` import):

```ts
import type { WorkItemRef } from './github';
```

Replace the `Session` interface's closing fields (keep every existing field and comment) by adding, after `model?: string;`:

```ts
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
```

Replace the `Workspace` interface entirely with:

```ts
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
```

Bump the version:

```ts
/** Shape version of the persisted workspace list. */
export const CURRENT_WORKSPACE_STATE_VERSION = 6;
```

- [ ] **Step 5: Rewrite the record creators and add helpers** in `src/shared/workspace.ts`

Replace `createWorkspaceRecord` with:

```ts
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
```

Replace `NewSessionFields` and `createSessionRecord` with:

```ts
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
```

Add the helpers (below `createSessionRecord`):

```ts
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
```

- [ ] **Step 6: Update the already-current migration fixture to v6**

The pre-existing test `leaves an already-current state alone` uses a v5-shaped fixture, and `CURRENT_WORKSPACE_STATE_VERSION` just moved to 6. Replace that test's fixture wholesale so the suite is green at this task's commit (the v5→v6 ladder itself is Task 2):

```ts
  it('leaves an already-current state alone', () => {
    const session = {
      id: 's1',
      name: 'Current',
      workspaceId: 'w1',
      instanceId: 'i1',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      hasStarted: true,
      harnessId: 'work',
      scopeId: 'scope-1',
      kind: 'interactive',
      createdAt: 1,
      lastActiveAt: 2,
    };
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          defaultHarnessId: 'work',
          scopes: [
            { id: 'scope-1', name: 'consola', path: '/code/consola', isGitRepo: true, createdAt: 1 },
          ],
          groups: [],
          sessions: [session],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, CURRENT_WORKSPACE_STATE_VERSION) as {
      workspaces: any[];
    };

    expect(migrated.workspaces[0].sessions[0]).toEqual(session);
    expect(migrated.workspaces[0].defaultHarnessId).toBe('work');
    expect(migrated.workspaces[0].scopes).toHaveLength(1);
  });
```

- [ ] **Step 7: Run the full shared test file**

Run: `npm test -- src/shared/workspace.test.ts`
Expected: PASS (all tests, including the updated fixture).

- [ ] **Step 8: Commit**

```bash
git add src/shared/github.ts src/shared/workspace.ts src/shared/workspace.test.ts
git commit -m "feat: v6 workspace domain types — scopes, groups, github binding"
```

---

### Task 2: v5 → v6 migration, exhaustively tested

This is the one piece of Phase 0 whose failure costs people conversations. Every branch gets a test.

**Files:**
- Modify: `src/shared/workspace.ts` (the `migrateWorkspaceState` ladder)
- Test: `src/shared/workspace.test.ts`

**Interfaces:**
- Consumes: `Scope`, `generateId` (Task 1).
- Produces: `migrateWorkspaceState(persistedState, version)` now carries any `version < 6` state to v6. `WorkspaceService.load()` and `importState()` pick this up with zero changes (they already call the ladder).

**Migration rules (from the spec's Migration section):**
- Each workspace's `path`/`isGitRepo` becomes its single scope; both fields are removed from the workspace.
- Scope `name` = folder basename of `path` (the `Scope.name` default); falls back to the workspace name when `path` is empty (a shape the v3 branch can produce), then to `'workspace'`.
- Scope `createdAt` = the workspace's `createdAt` (the place has existed as long as the workspace), falling back to `Date.now()`.
- Every session gets that scope's id and `kind: 'interactive'`; no `groupId`, no `cwd`, no `workItem` keys are added.
- `groups: []`; **no** `github` key (absent = pure local workspace).
- Defensive like the v5 branch: pre-existing `scopes`/`scopeId`/`kind` values are kept if a hand-edited or future-shaped file already has them.

- [ ] **Step 1: Write the failing tests** — append to the `migrateWorkspaceState` describe block in `src/shared/workspace.test.ts`:

```ts
  it('folds path and isGitRepo into a single scope at v6', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'My Renamed Workspace',
          path: '/code/consola',
          isGitRepo: true,
          defaultHarnessId: 'work',
          sessions: [
            {
              id: 's1',
              name: 'Old',
              workspaceId: 'w1',
              instanceId: 'i1',
              claudeSessionId: '11111111-1111-4111-8111-111111111111',
              hasStarted: true,
              harnessId: 'work',
              model: 'sonnet',
              createdAt: 1,
              lastActiveAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    // path/isGitRepo die on the workspace…
    expect(workspace).not.toHaveProperty('path');
    expect(workspace).not.toHaveProperty('isGitRepo');

    // …and live on as the single scope.
    expect(workspace.scopes).toHaveLength(1);
    const scope = workspace.scopes[0];
    expect(scope.path).toBe('/code/consola');
    expect(scope.isGitRepo).toBe(true);
    expect(scope.name).toBe('consola'); // folder basename, not the renamed workspace
    expect(scope.createdAt).toBe(1);
    expect(typeof scope.id).toBe('string');
    expect(scope.id.length).toBeGreaterThan(0);

    expect(workspace.groups).toEqual([]);
    expect(workspace).not.toHaveProperty('github');

    // The session is bound to the scope and nothing else about it moved.
    const session = workspace.sessions[0];
    expect(session.scopeId).toBe(scope.id);
    expect(session.kind).toBe('interactive');
    expect(session).not.toHaveProperty('groupId');
    expect(session).not.toHaveProperty('cwd');
    expect(session).not.toHaveProperty('workItem');
    expect(session.harnessId).toBe('work');
    expect(session.model).toBe('sonnet');
    expect(session.claudeSessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(session.hasStarted).toBe(true);
  });

  it('gives every session in a workspace the same scope id', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [
            { id: 's1', name: 'A', workspaceId: 'w1', instanceId: 'i1', claudeSessionId: '11111111-1111-4111-8111-111111111111', hasStarted: true, harnessId: 'default', createdAt: 1, lastActiveAt: 1 },
            { id: 's2', name: 'B', workspaceId: 'w1', instanceId: 'i2', claudeSessionId: '22222222-2222-4222-8222-222222222222', hasStarted: false, harnessId: 'default', createdAt: 2, lastActiveAt: 2 },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    expect(workspace.sessions[0].scopeId).toBe(workspace.scopes[0].id);
    expect(workspace.sessions[1].scopeId).toBe(workspace.scopes[0].id);
  });

  it('names the scope after the workspace when the path is empty', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'orphan',
          path: '',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };
    const scope = migrated.workspaces[0].scopes[0];

    expect(scope.name).toBe('orphan');
    expect(scope.path).toBe('');
    expect(scope.isGitRepo).toBe(false);
  });

  it('migrates a workspace with no sessions', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'empty',
          path: '/code/empty',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };

    expect(migrated.workspaces[0].scopes).toHaveLength(1);
    expect(migrated.workspaces[0].sessions).toEqual([]);
    expect(migrated.workspaces[0].groups).toEqual([]);
  });

  it('carries a v2 workspace through the whole ladder to v6', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          projects: [{ path: '/code/consola', isGitRepo: true }],
          sessions: [
            { id: 's1', name: 'Old', workspaceId: 'w1', instanceId: 'i1', createdAt: 1, lastActiveAt: 2 },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 2) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];
    const session = workspace.sessions[0];

    // v3: lifted out of projects; v4: session UUID; v5: harness; v6: scope.
    expect(workspace).not.toHaveProperty('projects');
    expect(workspace).not.toHaveProperty('path');
    expect(workspace.defaultHarnessId).toBe('default');
    expect(workspace.scopes[0].path).toBe('/code/consola');
    expect(workspace.scopes[0].isGitRepo).toBe(true);
    expect(session.claudeSessionId).toMatch(UUID_V4);
    expect(session.harnessId).toBe('default');
    expect(session.scopeId).toBe(workspace.scopes[0].id);
    expect(session.kind).toBe('interactive');
  });

  it('carries a v4 workspace through harness backfill and scoping together', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          sessions: [
            {
              id: 's1',
              name: 'Old',
              workspaceId: 'w1',
              instanceId: 'i1',
              claudeSessionId: '11111111-1111-4111-8111-111111111111',
              hasStarted: true,
              createdAt: 1,
              lastActiveAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 4) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    expect(workspace.defaultHarnessId).toBe('default');
    expect(workspace.sessions[0].harnessId).toBe('default');
    expect(workspace.sessions[0].scopeId).toBe(workspace.scopes[0].id);
  });

  it('keeps pre-existing scopes and scopeIds if a file somehow already has them', () => {
    const existingScope = {
      id: 'scope-kept',
      name: 'kept',
      path: '/code/kept',
      isGitRepo: false,
      createdAt: 1,
    };
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          defaultHarnessId: 'default',
          scopes: [existingScope],
          sessions: [
            {
              id: 's1',
              name: 'Old',
              workspaceId: 'w1',
              instanceId: 'i1',
              claudeSessionId: '11111111-1111-4111-8111-111111111111',
              hasStarted: true,
              harnessId: 'default',
              scopeId: 'scope-kept',
              kind: 'conductor',
              createdAt: 1,
              lastActiveAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    expect(workspace.scopes).toEqual([existingScope]);
    expect(workspace.sessions[0].scopeId).toBe('scope-kept');
    expect(workspace.sessions[0].kind).toBe('conductor');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/shared/workspace.test.ts`
Expected: FAIL — the new v6 assertions (no `scopes` on migrated workspaces yet).

- [ ] **Step 3: Implement the v6 rung** — in `src/shared/workspace.ts`, after the `version < 5` block inside `migrateWorkspaceState`, add:

```ts
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
```

And add the helper (file-local, above `migrateWorkspaceState`):

```ts
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
```

Also update the ladder's doc comment to add the line: `v5 -> v6 folds the workspace folder into a single scope and binds sessions to it.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/shared/workspace.test.ts`
Expected: PASS — all migration tests, old and new.

- [ ] **Step 5: Run the whole suite** (the WorkspaceService tests exercise the ladder through `importState`)

Run: `npm test`
Expected: `src/main/state/WorkspaceService.test.ts` may now fail on fixtures that create sessions without `scopeId` — that is Task 4's work. If it fails **only** there, proceed; anything else failing means the ladder broke something and must be fixed now.

- [ ] **Step 6: Commit**

```bash
git add src/shared/workspace.ts src/shared/workspace.test.ts
git commit -m "feat: migrate workspace state v5 to v6 — path becomes the single scope"
```

---

### Task 3: `updateFilters` — `groupId` in, identity fields out

**Files:**
- Modify: `src/main/state/updateFilters.ts`
- Modify: `src/main/state/WorkspaceService.ts` (the `updateSession` parameter type only)
- Test: `src/main/state/updateFilters.test.ts`

**Interfaces:**
- Consumes: `Session` (Task 1).
- Produces: `SessionUpdates = Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted' | 'groupId'>>`; `allowedSessionUpdates` passes `groupId` through (presence-based, so an explicit `undefined` clears it) and silently drops `scopeId`, `cwd`, `kind`, `workItem`.

- [ ] **Step 1: Write the failing tests** — append to the `allowedSessionUpdates` describe in `src/main/state/updateFilters.test.ts`:

```ts
  it('passes groupId through — regrouping is organizational, not identity', () => {
    const result = allowedSessionUpdates({ groupId: 'g1' });

    expect(result).toEqual({ groupId: 'g1' });
  });

  it('preserves an explicit groupId: undefined as an own key, so leaving a group reaches the service', () => {
    const result = allowedSessionUpdates({ groupId: undefined });

    // Same mechanism as harness binaryPath: presence separates "clear this"
    // from "leave it alone".
    expect('groupId' in result).toBe(true);
    expect(result.groupId).toBeUndefined();
  });

  it('omits groupId entirely when the key is absent from the input', () => {
    const result = allowedSessionUpdates({ name: 'Renamed' });

    expect('groupId' in result).toBe(false);
  });

  it('drops scopeId, cwd, kind and workItem even alongside a legitimate field', () => {
    // The session's place, working directory, nature and origin are fixed at
    // creation, exactly like harnessId and model: immutable by omission.
    const payload = {
      scopeId: 'other-scope',
      cwd: '/somewhere/else',
      kind: 'conductor',
      workItem: { provider: 'github', repo: 'a/b', type: 'pr', number: 1 },
      name: 'Legit rename',
    } as unknown as SessionUpdates;

    const result = allowedSessionUpdates(payload);

    expect(result).not.toHaveProperty('scopeId');
    expect(result).not.toHaveProperty('cwd');
    expect(result).not.toHaveProperty('kind');
    expect(result).not.toHaveProperty('workItem');
    expect(result.name).toBe('Legit rename');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/state/updateFilters.test.ts`
Expected: FAIL — `groupId` is not in `SessionUpdates` / not passed through.

- [ ] **Step 3: Implement** — in `src/main/state/updateFilters.ts` replace the `SessionUpdates` type and `allowedSessionUpdates`:

```ts
export type SessionUpdates = Partial<
  Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted' | 'groupId'>
>;

/**
 * The ones that matter most: `harnessId` — and since v6 `scopeId`, `cwd`,
 * `kind` and `workItem` — are deliberately not on the list.
 *
 * A session's harness is fixed for its lifetime — the transcript lives inside
 * that harness's config directory and `--resume` only finds it there — so a
 * rewritten `harnessId` would silently orphan the conversation rather than
 * failing where anyone could see it. The scope, working directory, kind and
 * work item are the session's identity in the same way: where it belongs,
 * where it runs, what drives it, and why it exists. `groupId` alone is
 * mutable — regrouping is an organizational act, not an identity change.
 * `id`, `workspaceId`, `instanceId` and `claudeSessionId` name the session
 * and its terminal; `createdAt` is history.
 */
export function allowedSessionUpdates(updates: SessionUpdates): SessionUpdates {
    const allowed: SessionUpdates = {};
    // These three are required on the record and none is clearable, so
    // `undefined` can only ever be a bug: absence and explicit-undefined are
    // treated alike. Contrast groupId below, where `undefined` is a value.
    if (updates.name !== undefined) allowed.name = updates.name;
    if (updates.lastActiveAt !== undefined) allowed.lastActiveAt = updates.lastActiveAt;
    if (updates.hasStarted !== undefined) allowed.hasStarted = updates.hasStarted;
    // `undefined` IS the value here — it means "leave the group". Structured
    // clone preserves an explicitly-undefined key, so presence is what
    // separates "clear this" from "leave it alone".
    if ('groupId' in updates) allowed.groupId = updates.groupId;
    return allowed;
}
```

In `src/main/state/WorkspaceService.ts`, widen `updateSession`'s parameter type to match:

```ts
  public updateSession(
    workspaceId: string,
    sessionId: string,
    updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted' | 'groupId'>>
  ): void {
```

(The body is unchanged — it already spreads the filtered updates.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/state/updateFilters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/state/updateFilters.ts src/main/state/updateFilters.test.ts src/main/state/WorkspaceService.ts
git commit -m "feat: allow groupId session updates; scope, cwd, kind, workItem immutable by omission"
```

---

### Task 4: `WorkspaceService` — scope, group and github-binding CRUD

**Files:**
- Modify: `src/main/state/WorkspaceService.ts`
- Test: `src/main/state/WorkspaceService.test.ts`

**Interfaces:**
- Consumes: `createScopeRecord`, `createGroupRecord`, `NewScopeFields`, `NewGroupFields`, `Scope`, `Group` (Task 1).
- Produces (the exact shapes Phase 1–3 plans call):
  - `addScope(workspaceId: string, fields: { name: string; path: string; isGitRepo: boolean }): Scope`
  - `removeScope(workspaceId: string, scopeId: string): void` — **throws** while any session references the scope
  - `setGitHubBinding(workspaceId: string, binding: { accountLogin: string; org?: string } | null): void`
  - `createGroup(workspaceId: string, fields: { name: string; parentGroupId?: string; conductorSessionId?: string }): Group`
  - `archiveGroup(workspaceId: string, groupId: string): void`
  - `createSession` now returns `undefined` for an unknown `scopeId` as well as an unknown workspace.

- [ ] **Step 1: Update the existing fixtures** in `src/main/state/WorkspaceService.test.ts` so the file compiles and stays green against v6:

  1. Every `service.createSession(...)` call gains a `scopeId`. There are three call sites: in `gives a new session its own conversation id...` and `drops a workspace and its sessions together` add `scopeId: workspace.scopes[0].id`; in `returns undefined rather than throwing for a session in a missing workspace` add the literal `scopeId: 'nope'` (its workspace does not exist, so any value shows the workspace check fires first). Grep `createSession(` in the file to confirm none is missed.
  2. Every inline v5-shaped workspace literal passed to `importState(..., 5)` gets `as unknown as Workspace[]` (import `type Workspace` from `../../shared/workspace`) — they are deliberately old-shaped and the ladder migrates them; assertions on ids/names are unchanged. Add one assertion to the first import test: `expect(service.getAll()[0].scopes[0].path).toBe('/code/consola');`
  3. The `runs the migration ladder on imported state` test (already `as any`) gains: `expect(service.getAll()[0].sessions[0].scopeId).toBe(service.getAll()[0].scopes[0].id);`

- [ ] **Step 2: Write the failing tests for the new methods** — append inside the `WorkspaceService` describe:

```ts
  it('addScope appends a scope and persists it', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    const scope = service.addScope(workspace.id, {
      name: 'docs',
      path: '/code/consola/docs',
      isGitRepo: false,
    });

    expect(scope.id).not.toBe(workspace.scopes[0].id);
    const reloaded = build();
    expect(reloaded.getAll()[0].scopes.map((s) => s.path)).toEqual([
      '/code/consola',
      '/code/consola/docs',
    ]);
  });

  it('addScope throws for an unknown workspace', () => {
    expect(() =>
      service.addScope('nope', { name: 'x', path: '/x', isGitRepo: false })
    ).toThrow();
  });

  it('removeScope drops an unreferenced scope', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const scope = service.addScope(workspace.id, {
      name: 'docs',
      path: '/code/consola/docs',
      isGitRepo: false,
    });

    service.removeScope(workspace.id, scope.id);

    expect(service.getAll()[0].scopes).toHaveLength(1);
  });

  it('removeScope refuses while a session references the scope', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const scope = workspace.scopes[0];
    service.createSession(workspace.id, {
      name: 'New Session',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
      scopeId: scope.id,
    });

    // The pointer must outlive its referents: unlike harnesses there is no
    // archive tier — a scope is only a pointer.
    expect(() => service.removeScope(workspace.id, scope.id)).toThrow(/session/i);
    expect(service.getAll()[0].scopes).toHaveLength(1);
  });

  it('createSession returns undefined for an unknown scope', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    const session = service.createSession(workspace.id, {
      name: 'New Session',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
      scopeId: 'not-a-scope',
    });

    expect(session).toBeUndefined();
    expect(service.getAll()[0].sessions).toEqual([]);
  });

  it('setGitHubBinding sets, replaces and clears the binding', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    service.setGitHubBinding(workspace.id, { accountLogin: 'SymJavi', org: 'sympower' });
    expect(service.getAll()[0].github).toEqual({ accountLogin: 'SymJavi', org: 'sympower' });

    service.setGitHubBinding(workspace.id, { accountLogin: 'personal' });
    expect(service.getAll()[0].github).toEqual({ accountLogin: 'personal' });

    service.setGitHubBinding(workspace.id, null);
    // Absent, not null: absence is what "pure local workspace" means on disk.
    expect(service.getAll()[0]).not.toHaveProperty('github');

    const reloaded = build();
    expect(reloaded.getAll()[0]).not.toHaveProperty('github');
  });

  it('createGroup and archiveGroup manage the group list', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    const group = service.createGroup(workspace.id, { name: 'bump lodash' });
    expect(service.getAll()[0].groups[0].name).toBe('bump lodash');
    expect(service.getAll()[0].groups[0].archivedAt).toBeUndefined();

    service.archiveGroup(workspace.id, group.id);
    expect(service.getAll()[0].groups[0].archivedAt).toEqual(expect.any(Number));

    const reloaded = build();
    expect(reloaded.getAll()[0].groups[0].archivedAt).toEqual(expect.any(Number));
  });

  it('createGroup carries parent and conductor references', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const parent = service.createGroup(workspace.id, { name: 'parent' });

    const child = service.createGroup(workspace.id, {
      name: 'child',
      parentGroupId: parent.id,
      conductorSessionId: 'sess-1',
    });

    expect(child.parentGroupId).toBe(parent.id);
    expect(child.conductorSessionId).toBe('sess-1');
  });
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npm test -- src/main/state/WorkspaceService.test.ts`
Expected: Step 1's updated fixtures PASS; Step 2's new tests FAIL — `addScope` etc. do not exist.

- [ ] **Step 4: Implement** — in `src/main/state/WorkspaceService.ts`:

Extend the import from `../../shared/workspace` with `createScopeRecord`, `createGroupRecord`, `type NewScopeFields`, `type NewGroupFields`, `type Scope`, `type Group`.

Add after `updateWorkspace`:

```ts
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
```

And guard `createSession` (add one line after the existing workspace check):

```ts
  public createSession(workspaceId: string, fields: NewSessionFields): Session | undefined {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return undefined;
    // A session pointing at a scope that does not exist would render nowhere
    // and spawn nowhere; refuse the same quiet way an unknown workspace is.
    if (!workspace.scopes.some((scope) => scope.id === fields.scopeId)) return undefined;

    const session = createSessionRecord(fields);
    // ... (rest of the method unchanged)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/main/state/WorkspaceService.test.ts`
Expected: PASS, all of them.

- [ ] **Step 6: Commit**

```bash
git add src/main/state/WorkspaceService.ts src/main/state/WorkspaceService.test.ts
git commit -m "feat: scope, group and github-binding CRUD in WorkspaceService"
```

---

### Task 5: IPC channels, handlers, preload and bridges for the new intents

Pure wiring — the logic it exposes is tested in Tasks 3–4; the gate here is compilation plus the existing suite.

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/services/workspaceBridge.ts`
- Modify: `src/renderer/stores/workspaceStore.ts`

**Interfaces:**
- Consumes: `WorkspaceService.addScope/removeScope/setGitHubBinding/createGroup/archiveGroup` (Task 4), `NewScopeFields`, `NewGroupFields`, `Scope`, `Group` (Task 1).
- Produces (exact channel strings — Phase 1–3 plans reference these):
  - `WORKSPACE_ADD_SCOPE: 'workspace:add-scope'`
  - `WORKSPACE_REMOVE_SCOPE: 'workspace:remove-scope'`
  - `WORKSPACE_SET_GITHUB_BINDING: 'workspace:set-github-binding'`
  - `WORKSPACE_GROUP_CREATE: 'workspace:group-create'`
  - `WORKSPACE_GROUP_ARCHIVE: 'workspace:group-archive'`
  - `GH_PROBE: 'github:probe'` (constant only here; its handler lands in Task 7)
  - `WorkspaceAPI` and `workspaceBridge` gain the five matching methods; `useWorkspaceStore` gains `addScope`, `removeScope`, `setGitHubBinding`.

- [ ] **Step 1: Add the channel constants** — in `src/shared/constants.ts`, after `WORKSPACE_SESSION_DELETE`:

```ts
    WORKSPACE_ADD_SCOPE: 'workspace:add-scope',
    WORKSPACE_REMOVE_SCOPE: 'workspace:remove-scope',
    WORKSPACE_SET_GITHUB_BINDING: 'workspace:set-github-binding',
    WORKSPACE_GROUP_CREATE: 'workspace:group-create',
    WORKSPACE_GROUP_ARCHIVE: 'workspace:group-archive',
```

And a new section after the harness channels:

```ts
    // GitHub via the gh CLI (renderer -> main). Probes only: tokens are
    // borrowed inside main at spawn/call time and never cross this boundary.
    GH_PROBE: 'github:probe',
```

- [ ] **Step 2: Extend `WorkspaceAPI` in `src/shared/types.ts`**

Extend the import from `./workspace` with `Group`, `NewGroupFields`, `NewScopeFields`, `Scope`. In the `WorkspaceAPI` interface, widen `updateSession`'s updates type to `Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted' | 'groupId'>>` and add after `deleteSession`:

```ts
    addScope: (workspaceId: string, fields: NewScopeFields) => Promise<Scope>;
    /** Rejects while any session still references the scope. */
    removeScope: (workspaceId: string, scopeId: string) => Promise<void>;
    setGitHubBinding: (
        workspaceId: string,
        binding: { accountLogin: string; org?: string } | null
    ) => Promise<void>;
    createGroup: (workspaceId: string, fields: NewGroupFields) => Promise<Group>;
    archiveGroup: (workspaceId: string, groupId: string) => Promise<void>;
```

- [ ] **Step 3: Register the handlers** — in `src/main/ipc-handlers.ts`, after the `WORKSPACE_SESSION_DELETE` handler:

```ts
    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_ADD_SCOPE,
        (_event, workspaceId: string, fields: NewScopeFields) =>
            workspaces.addScope(workspaceId, fields)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE,
        (_event, workspaceId: string, scopeId: string) =>
            workspaces.removeScope(workspaceId, scopeId)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SET_GITHUB_BINDING,
        (_event, workspaceId: string, binding: { accountLogin: string; org?: string } | null) =>
            workspaces.setGitHubBinding(
                workspaceId,
                // Rebuilt from an allow-list, updateFilters-style: IPC can
                // deliver any shape, and this object is persisted verbatim.
                binding === null
                    ? null
                    : {
                          accountLogin: String(binding.accountLogin),
                          ...(binding.org ? { org: String(binding.org) } : {}),
                      }
            )
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_GROUP_CREATE,
        (_event, workspaceId: string, fields: NewGroupFields) =>
            workspaces.createGroup(workspaceId, fields)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE,
        (_event, workspaceId: string, groupId: string) =>
            workspaces.archiveGroup(workspaceId, groupId)
    );
```

Extend the `../shared/workspace` type import in this file with `NewGroupFields`, `NewScopeFields`. In `cleanupIpcHandlers()`, alongside the other workspace removals:

```ts
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_ADD_SCOPE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET_GITHUB_BINDING);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE);
```

- [ ] **Step 4: Expose in preload** — in `src/preload/preload.ts`, inside the `workspaceAPI` object after `deleteSession` (extend the `../shared/workspace` type import with `Group`, `NewGroupFields`, `NewScopeFields`, `Scope`, and widen the `updateSession` updates parameter type to match Step 2):

```ts
    addScope: (workspaceId: string, fields: NewScopeFields): Promise<Scope> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ADD_SCOPE, workspaceId, fields),

    removeScope: (workspaceId: string, scopeId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE, workspaceId, scopeId),

    setGitHubBinding: (
        workspaceId: string,
        binding: { accountLogin: string; org?: string } | null
    ): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET_GITHUB_BINDING, workspaceId, binding),

    createGroup: (workspaceId: string, fields: NewGroupFields): Promise<Group> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_CREATE, workspaceId, fields),

    archiveGroup: (workspaceId: string, groupId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE, workspaceId, groupId),
```

- [ ] **Step 5: Extend `workspaceBridge`** — in `src/renderer/services/workspaceBridge.ts` (extend the type import with `Group`, `NewGroupFields`, `NewScopeFields`, `Scope`, widen `updateSession` the same way):

```ts
    addScope(workspaceId: string, fields: NewScopeFields): Promise<Scope> {
        return window.workspaceAPI.addScope(workspaceId, fields);
    },

    /** Rejects while any session still references the scope. */
    removeScope(workspaceId: string, scopeId: string): Promise<void> {
        return window.workspaceAPI.removeScope(workspaceId, scopeId);
    },

    setGitHubBinding(
        workspaceId: string,
        binding: { accountLogin: string; org?: string } | null
    ): Promise<void> {
        return window.workspaceAPI.setGitHubBinding(workspaceId, binding);
    },

    createGroup(workspaceId: string, fields: NewGroupFields): Promise<Group> {
        return window.workspaceAPI.createGroup(workspaceId, fields);
    },

    archiveGroup(workspaceId: string, groupId: string): Promise<void> {
        return window.workspaceAPI.archiveGroup(workspaceId, groupId);
    },
```

- [ ] **Step 6: Extend the store** — in `src/renderer/stores/workspaceStore.ts`:

Re-export the new types for components: change the existing re-export line to

```ts
export type { Scope, Session, Workspace } from '../../shared/workspace';
```

Add to the `WorkspaceState` interface:

```ts
  addScope: (
    workspaceId: string,
    fields: { name: string; path: string; isGitRepo: boolean }
  ) => Promise<Scope>;
  removeScope: (workspaceId: string, scopeId: string) => Promise<void>;
  setGitHubBinding: (
    workspaceId: string,
    binding: { accountLogin: string; org?: string } | null
  ) => Promise<void>;
```

(import `type Scope` from `../../shared/workspace`), widen the store's `updateSession` updates type with `'groupId'` to match the bridge, and add to the store body:

```ts
  addScope: (workspaceId, fields) => workspaceBridge.addScope(workspaceId, fields),

  removeScope: (workspaceId, scopeId) => workspaceBridge.removeScope(workspaceId, scopeId),

  setGitHubBinding: (workspaceId, binding) =>
    workspaceBridge.setGitHubBinding(workspaceId, binding),
```

(Group intents stay bridge-level only in Phase 0 — no component calls them until the Phase 2 groups UI.)

- [ ] **Step 7: Verify main-process compilation and the suite**

Run: `npx tsc -p tsconfig.main.json --noEmit && npm test`
Expected: main typecheck PASS; vitest PASS. (`npm run typecheck` still fails in the renderer — expected until Tasks 9–11.)

- [ ] **Step 8: Commit**

```bash
git add src/shared/constants.ts src/shared/types.ts src/main/ipc-handlers.ts src/preload/preload.ts src/renderer/services/workspaceBridge.ts src/renderer/stores/workspaceStore.ts
git commit -m "feat: wire scope, group and github-binding intents over IPC"
```

---

### Task 6: `GhBroker` — probe `gh` and borrow per-account tokens

**Files:**
- Create: `src/main/github/GhBroker.ts`
- Test: `src/main/github/GhBroker.test.ts` (the stub `gh` script is a fixture the test writes itself)

**Interfaces:**
- Consumes: `GhAccount`, `GhProbeResult` (Task 1), `getLoginEnv` (existing).
- Produces (exact contract for Phase 1's `GitHubService` and Task 8):
  - `class GhBroker { probe(): Promise<GhProbeResult>; token(accountLogin: string): Promise<string> }`
  - constructor `(getEnv: () => NodeJS.ProcessEnv = getLoginEnv, tokenTtlMs: number = TOKEN_TTL_MS)` — injectable for tests only; production code uses the exported singleton
  - `export const ghBroker = new GhBroker()`
  - `export function layerGhToken(env: NodeJS.ProcessEnv, token: string | null): NodeJS.ProcessEnv` — pure, copy-returning
  - `probe()` resolves the binary through the login-shell PATH; `token()` runs `gh auth token --user <login>`, caches in memory for ~5 minutes, never persists, throws an `Error` carrying gh's stderr on failure. **Tokens never appear in any IPC payload or renderer-bound object** — `GhProbeResult` has no field that could carry one.

- [ ] **Step 1: Write the failing tests** — create `src/main/github/GhBroker.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GhBroker, layerGhToken } from './GhBroker';

/**
 * A stub `gh` on PATH returning canned output, so the broker is tested
 * end-to-end — real process spawn, real stdout/stderr/exit codes — without
 * network or a keyring. `GH_STUB_LOG` records every invocation, which is how
 * the cache tests count subprocess calls.
 */
const STUB_SCRIPT = `#!/bin/sh
echo "$@" >> "$GH_STUB_LOG"
case "$1" in
  --version)
    echo "gh version 2.63.1 (2026-01-15)"
    ;;
  auth)
    case "$2" in
      status)
        if [ "$GH_STUB_MODE" = "logged-out" ]; then
          echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2
          exit 1
        fi
        cat <<'STATUS'
github.com
  ✓ Logged in to github.com account SymJavi (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account javier-tarazaga (keyring)
  - Active account: false
  - Git operations protocol: https
STATUS
        ;;
      token)
        if [ "$4" = "SymJavi" ]; then
          echo "gho_stub_token_symjavi"
        else
          echo "no oauth token found for account $4" >&2
          exit 1
        fi
        ;;
    esac
    ;;
esac
`;

let dir: string;
let logPath: string;

function stubEnv(extra: Record<string, string> = {}): () => NodeJS.ProcessEnv {
  // The stub dir comes first so the stub shadows any real gh; /bin and
  // /usr/bin let the stub script itself find `cat` and `sh` builtins' helpers.
  return () => ({ PATH: `${dir}:/bin:/usr/bin`, GH_STUB_LOG: logPath, ...extra });
}

function invocations(): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-gh-'));
  logPath = path.join(dir, 'invocations.log');
  const stubPath = path.join(dir, 'gh');
  fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GhBroker.probe', () => {
  it('reports the binary, version and keyring accounts', async () => {
    const broker = new GhBroker(stubEnv());

    const result = await broker.probe();

    expect(result.available).toBe(true);
    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
    expect(result.version).toBe('2.63.1');
    expect(result.accounts).toEqual([
      { login: 'SymJavi', active: true },
      { login: 'javier-tarazaga', active: false },
    ]);
    expect(result.error).toBeUndefined();
  });

  it('degrades to unavailable when gh is not on PATH', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-nogh-'));
    const broker = new GhBroker(() => ({ PATH: empty }));

    const result = await broker.probe();

    expect(result.available).toBe(false);
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/not installed|not on PATH/i);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('is available with zero accounts when nobody is signed in', async () => {
    const broker = new GhBroker(stubEnv({ GH_STUB_MODE: 'logged-out' }));

    const result = await broker.probe();

    expect(result.available).toBe(true);
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/not logged in/i);
  });

  it('never carries a token in its result', async () => {
    // This result crosses IPC to the settings UI: the masked token line in
    // `gh auth status` output must not survive parsing in any field.
    const broker = new GhBroker(stubEnv());

    const flat = JSON.stringify(await broker.probe());

    expect(flat).not.toContain('gho_');
  });
});

describe('GhBroker.token', () => {
  it('returns the token gh prints for the account', async () => {
    const broker = new GhBroker(stubEnv());

    await expect(broker.token('SymJavi')).resolves.toBe('gho_stub_token_symjavi');
  });

  it("throws with gh's stderr for an unknown account", async () => {
    const broker = new GhBroker(stubEnv());

    await expect(broker.token('nobody')).rejects.toThrow(/no oauth token found/i);
  });

  it('caches per account within the TTL', async () => {
    const broker = new GhBroker(stubEnv());

    await broker.token('SymJavi');
    await broker.token('SymJavi');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('re-fetches once the TTL has passed', async () => {
    const broker = new GhBroker(stubEnv(), 0);

    await broker.token('SymJavi');
    await broker.token('SymJavi');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(2);
  });
});

describe('layerGhToken', () => {
  it('adds GH_TOKEN on top of a copy of the env', () => {
    const base = { PATH: '/usr/bin' };

    const layered = layerGhToken(base, 'gho_x');

    expect(layered).toEqual({ PATH: '/usr/bin', GH_TOKEN: 'gho_x' });
    expect(base).not.toHaveProperty('GH_TOKEN');
  });

  it('returns a token-free copy for null', () => {
    const base = { PATH: '/usr/bin' };

    const layered = layerGhToken(base, null);

    expect(layered).toEqual({ PATH: '/usr/bin' });
    expect(layered).not.toBe(base);
  });
});
```

Note: the stub's status block mirrors real `gh auth status` output verbatim (including the ✓ marks and masked-token lines); the parser only needs the "Logged in to … account <login>" and "Active account:" lines, and the masked-token lines are there precisely so the no-token-leak test means something.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/github/GhBroker.test.ts`
Expected: FAIL — module `./GhBroker` does not exist.

- [ ] **Step 3: Implement `src/main/github/GhBroker.ts`**:

```ts
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLoginEnv } from '../LoginEnvironment';
import type { GhAccount, GhProbeResult } from '../../shared/github';

/**
 * The `gh` CLI as Consola's GitHub credential broker.
 *
 * Consola stores zero GitHub credentials: `gh` owns the keyring, and this
 * broker borrows a per-account token at the moment it is needed. Tokens live
 * in memory for minutes — only so an account change is picked up promptly;
 * the tokens themselves are long-lived — and are never persisted and never
 * put on an IPC channel. There is deliberately no `gh auth switch` anywhere:
 * two workspaces on two accounts must be able to run at the same time.
 */

const BINARY_NAME = 'gh';
const RUN_TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 5 * 60 * 1000;

interface RunResult {
    stdout: string;
    stderr: string;
    failed: boolean;
    errorMessage?: string;
}

function isExecutable(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Trim `gh version 2.63.1 (2026-01-15)` down to the version itself. */
function parseVersion(stdout: string): string | undefined {
    const match = stdout.match(/gh version (\S+)/);
    return match?.[1];
}

/**
 * The accounts `gh auth status` lists, with their active flags.
 *
 * Parsed line-by-line: an account line opens an entry and the following
 * `Active account:` line closes it. The masked token lines are deliberately
 * never captured — this result crosses IPC.
 */
function parseAccounts(text: string): GhAccount[] {
    const accounts: GhAccount[] = [];
    for (const line of text.split('\n')) {
        const login = line.match(/Logged in to \S+ account (\S+)/);
        if (login) {
            accounts.push({ login: login[1], active: false });
            continue;
        }
        const active = line.match(/Active account:\s*(true|false)/);
        if (active && accounts.length > 0) {
            accounts[accounts.length - 1].active = active[1] === 'true';
        }
    }
    return accounts;
}

/**
 * A copy of `env` with GH_TOKEN layered on, or a plain copy for null.
 *
 * Always a copy: the base environment is shared (getLoginEnv caches it), and
 * mutating it would leak one workspace's token into every other spawn.
 */
export function layerGhToken(env: NodeJS.ProcessEnv, token: string | null): NodeJS.ProcessEnv {
    return token ? { ...env, GH_TOKEN: token } : { ...env };
}

export class GhBroker {
    private readonly tokenCache = new Map<string, { token: string; fetchedAt: number }>();

    constructor(
        private readonly getEnv: () => NodeJS.ProcessEnv = getLoginEnv,
        private readonly tokenTtlMs: number = TOKEN_TTL_MS
    ) {}

    /**
     * Whether `gh` is installed, its version, and the keyring accounts.
     *
     * Feeds the workspace settings account picker and the "install gh" empty
     * state. Deliberately uncached: it runs when the settings section opens,
     * and installing `gh` or running `gh auth login` must take effect without
     * an app restart.
     */
    public async probe(): Promise<GhProbeResult> {
        const binary = this.resolveBinary();
        if (!binary) {
            return {
                available: false,
                accounts: [],
                error: '`gh` is not installed or not on PATH.',
            };
        }

        const version = await this.run(binary, ['--version']);
        if (version.failed) {
            return {
                available: false,
                resolvedBinary: binary,
                accounts: [],
                error: version.stderr.trim() || version.errorMessage || `\`${binary}\` did not run.`,
            };
        }

        // `gh auth status` exits non-zero and writes to stderr when nobody is
        // signed in (and historically wrote its report to stderr even on
        // success), so both streams are parsed and a failure is not fatal.
        const status = await this.run(binary, ['auth', 'status']);
        const accounts = parseAccounts(`${status.stdout}\n${status.stderr}`);

        return {
            available: true,
            resolvedBinary: binary,
            version: parseVersion(version.stdout),
            accounts,
            ...(accounts.length === 0
                ? {
                      error:
                          status.stderr.trim() ||
                          status.stdout.trim() ||
                          'No GitHub accounts are signed in. Run `gh auth login`.',
                  }
                : {}),
        };
    }

    /**
     * A token for one keyring account, via `gh auth token --user <login>`.
     *
     * Cached in memory for a few minutes and nowhere else. Throws with gh's
     * own stderr on failure — the caller decides how to degrade.
     */
    public async token(accountLogin: string): Promise<string> {
        const cached = this.tokenCache.get(accountLogin);
        if (cached && Date.now() - cached.fetchedAt < this.tokenTtlMs) {
            return cached.token;
        }

        const binary = this.resolveBinary();
        if (!binary) {
            throw new Error('`gh` is not installed or not on PATH.');
        }

        const result = await this.run(binary, ['auth', 'token', '--user', accountLogin]);
        if (result.failed) {
            throw new Error(
                result.stderr.trim() ||
                    result.errorMessage ||
                    `gh auth token failed for ${accountLogin}.`
            );
        }

        const token = result.stdout.trim();
        if (!token) {
            throw new Error(`gh returned an empty token for ${accountLogin}.`);
        }

        this.tokenCache.set(accountLogin, { token, fetchedAt: Date.now() });
        return token;
    }

    /**
     * Absolute path to `gh`, or null when nothing was found.
     *
     * Searched through the login-shell PATH like every binary Consola drives:
     * a Dock-launched app inherits a minimal environment, and getLoginEnv
     * restores whatever the user's shell profile puts on PATH — including
     * Homebrew. Deliberately uncached so installing `gh` takes effect
     * without a restart.
     */
    private resolveBinary(): string | null {
        // The login-shell PATH only, with no hardcoded fallback locations
        // (unlike ClaudeDriver): getLoginEnv already reproduces the user's
        // real PATH, and machine-wide fallbacks would make "gh is absent"
        // untestable — and would ignore an intentional PATH override.
        const searchPath = this.getEnv().PATH ?? '';
        for (const dir of searchPath.split(path.delimiter)) {
            if (!dir) continue;
            const candidate = path.join(dir, BINARY_NAME);
            if (isExecutable(candidate)) return candidate;
        }
        return null;
    }

    private run(binary: string, args: string[]): Promise<RunResult> {
        return new Promise((resolve) => {
            execFile(
                binary,
                args,
                {
                    env: this.getEnv() as { [key: string]: string },
                    timeout: RUN_TIMEOUT_MS,
                    maxBuffer: 1024 * 1024,
                },
                (error, stdout, stderr) =>
                    resolve({
                        stdout,
                        stderr,
                        failed: error !== null,
                        errorMessage: error?.message,
                    })
            );
        });
    }
}

/** The app-wide broker. Tests construct their own with a stubbed environment. */
export const ghBroker = new GhBroker();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/github/GhBroker.test.ts`
Expected: PASS — all probe, token, cache and layering tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/GhBroker.ts src/main/github/GhBroker.test.ts
git commit -m "feat: GhBroker probes gh and borrows per-account tokens"
```

---

### Task 7: `github:probe` over IPC and the `githubBridge`

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/preload.ts`
- Create: `src/renderer/services/githubBridge.ts`

**Interfaces:**
- Consumes: `ghBroker` (Task 6), `GH_PROBE` constant (Task 5), `GhProbeResult` (Task 1).
- Produces: `githubBridge.probe(): Promise<GhProbeResult>` (used by Task 12's settings UI and Phase 1's Inbox empty states); `window.githubAPI` typed as `GitHubAPI`.

- [ ] **Step 1: Type the API** — in `src/shared/types.ts`, add near `HarnessAPI` (import `type { GhProbeResult }` from `./github`):

```ts
/**
 * GitHub probing exposed to the renderer.
 *
 * Probe only: whether `gh` exists and which accounts its keyring holds.
 * Tokens are borrowed inside the main process at spawn/call time and have no
 * representation on this API at all.
 */
export interface GitHubAPI {
    probe: () => Promise<GhProbeResult>;
}
```

And add `githubAPI: GitHubAPI;` to the `declare global { interface Window }` block.

- [ ] **Step 2: Register the handler** — in `src/main/ipc-handlers.ts`, after the harness query handlers (import `{ ghBroker }` from `'./github/GhBroker'`):

```ts
    // === GitHub queries ===

    // Is `gh` installed, and which accounts does its keyring hold? Tokens are
    // deliberately not reachable over IPC — see GhBroker.
    ipcMain.handle(IPC_CHANNELS.GH_PROBE, () => ghBroker.probe());
```

And in `cleanupIpcHandlers()`:

```ts
    ipcMain.removeHandler(IPC_CHANNELS.GH_PROBE);
```

- [ ] **Step 3: Expose in preload** — in `src/preload/preload.ts` (import `GhProbeResult` from `../shared/github`), after the `harnessAPI` block:

```ts
// Expose GitHub probing to the renderer. Probe only: tokens never cross this
// bridge — they are borrowed and consumed entirely inside the main process.
contextBridge.exposeInMainWorld('githubAPI', {
    probe: (): Promise<GhProbeResult> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GH_PROBE);
    },
});
```

- [ ] **Step 4: Create `src/renderer/services/githubBridge.ts`**:

```ts
import type { GhProbeResult } from '../../shared/github';

/**
 * Bridge to GitHub probing in the main process.
 *
 * Consola stores no GitHub credentials: the `gh` CLI owns the keyring, and
 * this bridge only ever learns which accounts exist — never their tokens.
 */
export const githubBridge = {
    /** Whether `gh` is installed, its version, and the keyring accounts. */
    probe(): Promise<GhProbeResult> {
        return window.githubAPI.probe();
    },
};
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc -p tsconfig.main.json --noEmit && npx tsc -p tsconfig.preload.json --noEmit && npm test`
Expected: PASS (renderer typecheck still pending, as before).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/ipc-handlers.ts src/preload/preload.ts src/renderer/services/githubBridge.ts
git commit -m "feat: expose gh probe to the renderer"
```

---

### Task 8: `GH_TOKEN` into the PTY of every github-bound workspace

**Files:**
- Modify: `src/shared/types.ts` (`TerminalCreateOptions`)
- Modify: `src/main/TerminalService.ts`
- Modify: `src/main/ipc-handlers.ts` (the `TERMINAL_CREATE` handler)
- Modify: `src/renderer/components/Terminal/useTerminal.ts`
- Modify: `src/renderer/components/Terminal/TerminalPanel.tsx`
- Modify: `src/renderer/components/Views/ContentView.tsx` (pass `workspaceId` down — the scope/cwd rework of this file is Task 9)

**Interfaces:**
- Consumes: `ghBroker.token`, `layerGhToken` (Task 6), `Workspace.github` (Task 1).
- Produces: `TerminalCreateOptions` gains `workspaceId: string` (required — the contract other phases build against). `TerminalServiceOptions` gains `githubAccountLogin?: string`, resolved main-side from the workspace; the renderer only ever names the workspace. Sessions in workspaces without a binding get no `GH_TOKEN` and behave exactly as today.

**Design notes:**
- The renderer sends `workspaceId`; the `TERMINAL_CREATE` handler (which owns `workspaceService`) resolves it to `workspace.github?.accountLogin`; `TerminalService` resolves the login to a token via `ghBroker.token()` and layers it with `layerGhToken()`. The token exists only inside main, between `token()` and `pty.spawn()`.
- `initClaude` becomes `async` so the token fetch can happen per launch — a restart or resume-retry re-borrows (served from the 5-minute cache when fresh, refreshed after a re-login). All three callers already ignore its return value; they become `void this.initClaude(...)`.
- Token failure must not take the terminal down: the session launches without `GH_TOKEN` and a red notice (existing `writeNotice`) names the account and gh's error. The spec's Inbox-header error surface is Phase 1; the notice keeps the failure visible until then, because silently acting as `gh`'s ambient active account is the exact bug this feature exists to kill.
- A binding added *after* a session's terminal was created applies on the next terminal creation (same rule as harness edits: "applies to the next launch").

- [ ] **Step 1: Add `workspaceId` to `TerminalCreateOptions`** — in `src/shared/types.ts`:

```ts
export interface TerminalCreateOptions extends HarnessLaunchFields {
    instanceId: string;
    /**
     * Workspace this session belongs to. Main resolves it to the workspace's
     * GitHub account binding (if any) and borrows GH_TOKEN itself — the
     * renderer names the workspace precisely so it never has to see a token.
     */
    workspaceId: string;
    cwd: string;
    // ... (every existing field unchanged)
```

- [ ] **Step 2: Teach `TerminalService` to borrow the token** — in `src/main/TerminalService.ts`:

Add to the imports:

```ts
import { ghBroker, layerGhToken } from './github/GhBroker';
```

Add to `TerminalServiceOptions` (after `model?: string;`):

```ts
    /**
     * GitHub account whose token this session's PTY gets as GH_TOKEN.
     * Resolved from the workspace's binding by the create handler; absent for
     * workspaces without a binding, which then spawn exactly as before.
     */
    githubAccountLogin?: string;
```

Make `initClaude` async and re-borrow per launch. The method keeps its exact body except for three edits:

1. Signature: `private async initClaude(resume: boolean): Promise<void> {`
2. After the `cwdProblem` early-return block, insert:

```ts
        const ghToken = await this.borrowGhToken();
        // The await yields; the session may have been closed or restarted in
        // the meantime, and spawning now would leak an untracked PTY.
        if (this.isDestroyed || this.claudePty) return;
```

3. The spawn's `env` line becomes:

```ts
                env: layerGhToken(
                    this.driver.composeEnv(this.harness, getLoginEnv()),
                    ghToken
                ) as { [key: string]: string },
```

Update the three call sites to `void this.initClaude(...)`: in `start()` (`void this.initClaude(this.options.resume);`), in `restartClaude()` (`void this.initClaude(true);`), and in the resume-retry branch inside `onExit` (`void this.initClaude(false);`).

Add the borrow method next to `describeCwdProblem`:

```ts
    /**
     * GH_TOKEN for this session's workspace account, or null.
     *
     * Null is the whole degradation story: no binding means no token and a
     * spawn identical to pre-v6 Consola. A binding whose token cannot be
     * borrowed also launches — but with a visible notice, because an agent
     * silently running `gh` as whatever account happens to be active in the
     * keyring is exactly the cross-account accident bindings exist to prevent.
     */
    private async borrowGhToken(): Promise<string | null> {
        const login = this.options.githubAccountLogin;
        if (!login) return null;
        try {
            return await ghBroker.token(login);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeNotice(
                `Could not borrow a GitHub token for ${login}: ${message} ` +
                    'This session runs without GH_TOKEN — check `gh auth status`.'
            );
            return null;
        }
    }
```

- [ ] **Step 3: Resolve the binding in the create handler** — in `src/main/ipc-handlers.ts`, the `TERMINAL_CREATE` handler: add `workspaceId` to the destructuring of `options`, and pass the resolved login into `manager.ensure`:

```ts
    ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, (event, options: TerminalCreateOptions) => {
        const {
            instanceId,
            workspaceId,
            cwd,
            claudeSessionId,
            resume,
            cols,
            rows,
            initialPrompt,
            model,
            driverId,
            binaryOverride,
            configDirOverride,
            extraArgs,
        } = options;

        // The workspace's GitHub binding, resolved here because this file owns
        // the workspace records. TerminalService turns the login into a token
        // at spawn time; the renderer never sees either step.
        const workspace = workspaces
            .getAll()
            .find((candidate) => candidate.id === workspaceId);
        const githubAccountLogin = workspace?.github?.accountLogin;

        return manager.ensure(instanceId, {
            cwd,
            claudeSessionId,
            // (existing comments and fields unchanged)
            resume,
            cols,
            rows,
            initialPrompt,
            model,
            driverId,
            binaryOverride,
            configDirOverride,
            extraArgs,
            githubAccountLogin,
        }, event.sender);
    });
```

- [ ] **Step 4: Thread `workspaceId` from the renderer** —

In `src/renderer/components/Terminal/useTerminal.ts`: add `workspaceId: string;` to `UseTerminalOptions` (with the comment `/** Workspace this session belongs to; main resolves its GitHub binding. */`), accept it in the destructured hook parameters, pass `workspaceId,` as the first property of the `terminalBridge.create({ ... })` payload, and add `workspaceId` to the create-effect's dependency array (alongside `instanceId, cwd, ...`).

In `src/renderer/components/Terminal/TerminalPanel.tsx`: add `workspaceId: string;` to `TerminalPanelProps`, accept it, and forward it into `useTerminal({ ... })`.

In `src/renderer/components/Views/ContentView.tsx`: pass `workspaceId={workspaceId}` to `<TerminalPanel ...>` (the prop already exists in scope as the component's own prop).

- [ ] **Step 5: Verify**

Run: `npx tsc -p tsconfig.main.json --noEmit && npx tsc -p tsconfig.preload.json --noEmit && npm test`
Expected: PASS. Behavior check to reason through (no automated harness for spawn): without a binding `githubAccountLogin` is `undefined`, `borrowGhToken` returns null on the fast path, and `layerGhToken(env, null)` is a plain copy — byte-for-byte today's env.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/TerminalService.ts src/main/ipc-handlers.ts src/renderer/components/Terminal/useTerminal.ts src/renderer/components/Terminal/TerminalPanel.tsx src/renderer/components/Views/ContentView.tsx
git commit -m "feat: inject GH_TOKEN into PTYs of github-bound workspaces"
```

---

### Task 9: Renderer reads move from `workspace.path` to the session's scope

**Files:**
- Modify: `src/renderer/components/Views/ContentView.tsx`
- Modify: `src/renderer/components/GitReviewPanel/GitReviewPanel.tsx`
- Modify: `src/renderer/components/CommandPalette/buildItems.ts`
- Modify: `src/renderer/components/Layout/WorkspaceSwitcher.tsx`

**Interfaces:**
- Consumes: `scopeForSession`, `primaryScope` (Task 1), `Scope` re-export from `workspaceStore` (Task 5).
- Produces: `ContentView` cwd = `session.cwd ?? scope.path`; git status root = the active session's scope; palette git items and workspace rows read scopes. `HomeView` needs no change (it only calls `createWorkspace`, whose signature is unchanged).

**Behavioral invariant:** after migration every workspace has exactly one scope carrying the old `path`/`isGitRepo`, and no session has a `cwd` override — so every expression below resolves to the same values as before, byte-for-byte.

- [ ] **Step 1: `ContentView.tsx`** — replace the cwd/refresh/PathDisplay reads:

Import the helpers:

```ts
import { scopeForSession } from '../../../shared/workspace';
```

Replace `const cwd = workspace?.path ?? '';` with:

```ts
  // The session's home scope decides where it runs, unless the session
  // carries a cwd override (worktrees, from Phase 1 on).
  const scope = workspace ? scopeForSession(workspace, session) : undefined;
  const cwd = session?.cwd ?? scope?.path ?? '';
```

Replace the auto-refresh line with:

```ts
  // Enable auto-refresh of git status on window focus, rooted at the scope —
  // not the cwd: a worktree session's changes belong to its repo's scope.
  useGitStatusAutoRefresh(scope?.isGitRepo ? scope.path : null);
```

Replace the header's `{workspace.path && (<PathDisplay path={workspace.path} ...` with `{cwd && (<PathDisplay path={cwd} ...` (other props unchanged).

- [ ] **Step 2: `GitReviewPanel.tsx`** — root the panel at the active session's scope:

Add the import and selector:

```ts
import { scopeForSession } from '../../../shared/workspace';
```

```ts
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);

  const workspace = activeWorkspaceId ? getWorkspace(activeWorkspaceId) : null;
  // The active session's scope is the repo under review; with no session the
  // primary scope keeps the panel meaningful, exactly as workspace.path did.
  const session = workspace
    ? workspace.sessions.find((candidate) => candidate.id === activeSessionId)
    : undefined;
  const rootPath = workspace ? scopeForSession(workspace, session)?.path ?? null : null;
```

(Everything below `rootPath` in the component is unchanged — the `isGitRepo` empty state already comes from `gitStatusStore` after `refresh(rootPath)` runs.)

- [ ] **Step 3: `buildItems.ts`** — scope-aware context:

Add `Scope` to the workspace-store type import: `import type { Scope, Session, Workspace } from '../../stores/workspaceStore';` and import the helpers: `import { primaryScope, scopeForSession } from '../../../shared/workspace';`

Add above `hasFreshGitStatus`:

```ts
/**
 * The scope the palette should treat as "here": the active session's, or the
 * workspace's primary scope when no session is open. Git items act on this.
 */
function activeScope(ctx: PaletteContext): Scope | null {
  if (!ctx.activeWorkspace) return null;
  return scopeForSession(ctx.activeWorkspace, ctx.activeSession ?? undefined) ?? null;
}
```

Rewrite `hasFreshGitStatus`:

```ts
function hasFreshGitStatus(ctx: PaletteContext): boolean {
  const scope = activeScope(ctx);
  return scope !== null && scope.isGitRepo && ctx.gitStatusRootPath === scope.path;
}
```

In `buildActionItems`, replace the git section's opening:

```ts
  // --- git ----------------------------------------------------------------
  const scope = activeScope(ctx);
  if (scope?.isGitRepo) {
    const rootPath = scope.path;
```

(body unchanged; closing brace unchanged).

In `buildWorkspaceItems`, replace the two workspace-field reads:

```ts
    context: primaryScope(workspace)?.path ?? '',
    ...
    isGitRepo: primaryScope(workspace)?.isGitRepo ?? false,
```

In `buildFileItems`, replace the guard and root:

```ts
export function buildFileItems(ctx: PaletteContext): FilePaletteItem[] {
  const scope = activeScope(ctx);
  if (!ctx.activeSession || !hasFreshGitStatus(ctx) || !scope) return [];

  const rootPath = scope.path;
```

- [ ] **Step 4: `WorkspaceSwitcher.tsx`** — icons read the primary scope:

Import `primaryScope` from `'../../../shared/workspace'`. Replace the two icon conditions:

```ts
            {active && primaryScope(active)?.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
```

and in the list rows:

```ts
                  {primaryScope(workspace)?.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
```

(`handleAddWorkspace` is untouched — `createWorkspace(folder.name, folder.path, folder.isGitRepo)` still stands.)

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: PASS. Renderer typecheck is still red only for `NewSessionView.tsx` / `sessionActions.ts` (missing `scopeId` — Task 10) and nothing else; confirm with:

```bash
npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | grep -v -E "NewSessionView|sessionActions" | grep "error TS" ; echo "remaining errors above (want: none)"
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Views/ContentView.tsx src/renderer/components/GitReviewPanel/GitReviewPanel.tsx src/renderer/components/CommandPalette/buildItems.ts src/renderer/components/Layout/WorkspaceSwitcher.tsx
git commit -m "refactor: read cwd and git roots from the session's scope"
```

---

### Task 10: Scope picker on the new-session screen, scoped quick-create

**Files:**
- Modify: `src/renderer/components/Views/NewSessionView.tsx`
- Modify: `src/renderer/utils/sessionActions.ts`

**Interfaces:**
- Consumes: `NewSessionFields.scopeId` (Task 1), `primaryScope` (Task 1), store `createSession` (unchanged shape, now carrying `scopeId`).
- Produces: `createQuickSession(workspaceId: string, scopeId?: string)` — the Sidebar (Task 11) calls the two-argument form; every existing one-argument caller keeps compiling and gets the primary scope.

The picker replaces the *implicit* `workspace.path` cwd: the session record now names its scope explicitly, and mockup scene 4's "New session" door says "pick a scope — the picker lists scopes, not a folder browser". With a single scope the picker row is omitted (same rule as the harness picker) and the sole scope is used.

- [ ] **Step 1: `sessionActions.ts`** — replace `createQuickSession`:

```ts
import { primaryScope } from '../../shared/workspace';
```

```ts
/**
 * Create a session in a scope with the workspace's default harness, and open it.
 *
 * The quick path used by the sidebar's `+`. With no scope named it lands in
 * the primary scope — which is exactly where every session landed before
 * scopes existed. Choosing a harness or starting with a prompt happens on the
 * new-session screen instead.
 */
export async function createQuickSession(
  workspaceId: string,
  scopeId?: string
): Promise<Session | undefined> {
  const workspace = useWorkspaceStore.getState().getWorkspace(workspaceId);
  if (!workspace) return undefined;

  const scope =
    (scopeId
      ? workspace.scopes.find((candidate) => candidate.id === scopeId)
      : undefined) ?? primaryScope(workspace);
  if (!scope) return undefined;

  const session = await useWorkspaceStore.getState().createSession(workspaceId, {
    name: 'New Session',
    workspaceId,
    instanceId: generateSessionInstanceId(workspaceId),
    harnessId: workspace.defaultHarnessId,
    scopeId: scope.id,
  });

  if (session) {
    activateSession(workspaceId, session.id);
  }
  return session;
}
```

- [ ] **Step 2: `NewSessionView.tsx`** — add the scope picker:

Add state and selection (after the harness selection block):

```ts
  // Which scope this conversation will run in. Follows the workspace's
  // primary scope whenever the workspace changes, like the harness default.
  const [selectedScopeId, setSelectedScopeId] = useState<string | undefined>(
    workspace.scopes[0]?.id
  );
  const selectedScope =
    workspace.scopes.find((scope) => scope.id === selectedScopeId) ?? workspace.scopes[0];

  useEffect(() => {
    setSelectedScopeId(workspace.scopes[0]?.id);
  }, [workspace.id]);
```

In `handleSubmit`, guard and carry the scope — after the existing `if (!trimmedPrompt || isSubmitting) return;` add:

```ts
    if (!selectedScope) return;
```

and add to the `createSession` fields object, after `model: selectedModel,`:

```ts
        // Fixed now like the harness and model: the scope is the session's
        // home in the sidebar and its default working directory.
        scopeId: selectedScope.id,
```

Render the picker between the workspace dropdown and the harness dropdown (same dropdown classes as the harness picker; import `Folder` and `GitBranch` from `lucide-react`):

```tsx
          {workspace.scopes.length > 1 && selectedScope && (
            <>
              <span>in</span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="workspace-dropdown-trigger">
                    {selectedScope.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
                    <span>{selectedScope.name}</span>
                    <ChevronDown size={14} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="dropdown-content workspace-dropdown-content"
                    sideOffset={4}
                  >
                    {workspace.scopes.map((scope) => (
                      <DropdownMenu.Item
                        key={scope.id}
                        className={`dropdown-item ${
                          scope.id === selectedScope.id ? 'active' : ''
                        }`}
                        onSelect={() => setSelectedScopeId(scope.id)}
                        title={scope.path}
                      >
                        {scope.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
                        {scope.name}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          )}
```

- [ ] **Step 3: Verify — renderer nearly compiles**

Run: `npm test` then:

```bash
npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | grep "error TS" ; echo "errors above (want: none)"
```

Expected: `npm test` PASS; renderer typecheck now clean (Sidebar still compiles — it calls `createQuickSession(workspace.id)`, which is still valid). If any stray `workspace.path` consumer surfaces here, it belongs to Task 9's scope and must be fixed the same way before committing.

- [ ] **Step 4: Full typecheck**

Run: `npm run typecheck`
Expected: PASS — first task at which all three projects compile.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Views/NewSessionView.tsx src/renderer/utils/sessionActions.ts
git commit -m "feat: scope picker on the new-session screen"
```

---

### Task 11: Sidebar Scopes section — sessions nested under their scope, add/remove

Mockup: `.superpowers/brainstorm/87378-1787218296/content/scopes-sidebar.html`, **option 1** ("Scopes as a section, sessions nested under them") — the tree the design chose for the sidebar; the section replaces the flat "Sessions" list and the implicit single root.

**Files:**
- Modify: `src/renderer/components/Sidebar/index.tsx`
- Modify: `src/renderer/components/Sidebar/styles.css`

**Interfaces:**
- Consumes: `createQuickSession(workspaceId, scopeId)` (Task 10), `useWorkspaceStore.addScope/removeScope` (Task 5), `dialogBridge.selectFolder` (existing).
- Produces: UI only; nothing downstream consumes it.

**Rules baked into the UI:**
- Section title becomes **Scopes**; the header `+` adds a *scope* (folder picker); each scope row has a hover `+` that quick-creates a session in that scope.
- A scope row shows a remove button only when it has no sessions **and** it is not the last scope — the service throw (Task 4) stays as the race guard, and a workspace can never end up scope-less from this UI.
- Sessions render under the scope their `scopeId` names; the unnamed-session filter stays; a session whose scope is somehow gone renders in a trailing flat list rather than disappearing.

- [ ] **Step 1: Rewrite `src/renderer/components/Sidebar/index.tsx`**:

```tsx
import { Folder, GitBranch, Plus, Settings, X } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore, type Scope } from '../../stores/workspaceStore';
import { useSettings } from '../../contexts/SettingsContext';
import { dialogBridge } from '../../services/dialogBridge';
import { SessionNavItem } from './SessionNavItem';
import { activateSession, createQuickSession } from '../../utils/sessionActions';
import './styles.css';

/**
 * The scopes of the workspace this window holds, with each session nested
 * under the scope it runs in.
 *
 * Scopes are the one level of structure the sidebar carries: a window shows
 * one workspace, a workspace holds a few durable places, and every session
 * has exactly one home among them. Which workspace this is lives in the top
 * bar.
 */
export function Sidebar() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const addScope = useWorkspaceStore((state) => state.addScope);
  const removeScope = useWorkspaceStore((state) => state.removeScope);
  const { openSettings } = useSettings();

  if (isSidebarHidden) {
    return null;
  }

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;
  // Sessions appear once Claude has named them, so an unnamed one is a session
  // whose first turn has not landed yet.
  const sessions = workspace?.sessions.filter((session) => session.name.length > 0) ?? [];
  const scopeIds = new Set(workspace?.scopes.map((scope) => scope.id) ?? []);
  // A session whose scope is gone still renders — losing a row over a broken
  // pointer would look like data loss.
  const orphanSessions = sessions.filter((session) => !scopeIds.has(session.scopeId));

  const handleAddScope = async () => {
    if (!workspace) return;
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    try {
      await addScope(workspace.id, {
        name: folder.name,
        path: folder.path,
        isGitRepo: folder.isGitRepo,
      });
    } catch (error) {
      console.error('Failed to add scope', error);
    }
  };

  const handleRemoveScope = async (scope: Scope) => {
    if (!workspace) return;
    if (!window.confirm(`Remove scope "${scope.name}"? The folder itself is untouched.`)) {
      return;
    }
    try {
      await removeScope(workspace.id, scope.id);
    } catch (error) {
      // The service refuses while sessions reference the scope; the button is
      // hidden in that case, so this only fires on a race. The scope visibly
      // staying put is the signal.
      console.error('Failed to remove scope', error);
    }
  };

  const addScopeButton = (
    <button
      className="sidebar-section-button"
      onClick={() => void handleAddScope()}
      disabled={!workspace}
    >
      <Plus size={14} />
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">Scopes</span>
          <Tooltip.Provider delayDuration={200}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>{addScopeButton}</Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
                  Add scope
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
        <nav className="session-list">
          {workspace &&
            workspace.scopes.map((scope) => {
              const scopeSessions = sessions.filter(
                (session) => session.scopeId === scope.id
              );
              const removable =
                workspace.scopes.length > 1 &&
                workspace.sessions.every((session) => session.scopeId !== scope.id);
              return (
                <div key={scope.id} className="scope-group">
                  <div className="scope-row" title={scope.path}>
                    <span className="scope-row-icon">
                      {scope.isGitRepo ? <GitBranch size={12} /> : <Folder size={12} />}
                    </span>
                    <span className="scope-row-name">{scope.name}</span>
                    <button
                      className="scope-row-action"
                      onClick={() => void createQuickSession(workspace.id, scope.id)}
                      aria-label={`New session in ${scope.name}`}
                    >
                      <Plus size={12} />
                    </button>
                    {removable && (
                      <button
                        className="scope-row-action"
                        onClick={() => void handleRemoveScope(scope)}
                        aria-label={`Remove scope ${scope.name}`}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  {scopeSessions.map((session) => (
                    <SessionNavItem
                      key={session.id}
                      session={session}
                      workspaceId={workspace.id}
                      isActive={activeSessionId === session.id}
                      onClick={() => activateSession(workspace.id, session.id)}
                    />
                  ))}
                </div>
              );
            })}
          {workspace &&
            orphanSessions.map((session) => (
              <SessionNavItem
                key={session.id}
                session={session}
                workspaceId={workspace.id}
                isActive={activeSessionId === session.id}
                onClick={() => activateSession(workspace.id, session.id)}
              />
            ))}
        </nav>
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-settings-button" onClick={openSettings}>
          <Settings size={16} />
          <span>Settings</span>
          <span className="sidebar-settings-shortcut">⌘,</span>
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Add the scope-row styles** — append to `src/renderer/components/Sidebar/styles.css` (follow the file's existing custom-property palette; these names are additive):

```css
/* --- Scopes tree ------------------------------------------------------- */

.scope-group {
  display: flex;
  flex-direction: column;
}

.scope-group + .scope-group {
  margin-top: 6px;
}

.scope-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  color: var(--text-secondary, #8b8b8b);
  font-size: 11px;
  text-transform: none;
  user-select: none;
}

.scope-row-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.scope-row-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scope-row-action {
  display: none;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
}

.scope-row:hover .scope-row-action {
  display: inline-flex;
}

.scope-row-action:hover {
  background: var(--bg-hover, rgba(128, 128, 128, 0.15));
}

/* Sessions sit one step in from their scope's label. */
.scope-group .session-nav-item {
  margin-left: 12px;
}
```

(If `styles.css` does not define `--text-secondary`/`--bg-hover`, keep the fallback values above — they are legible in both themes; check the file's real variable names while editing and prefer them.)

- [ ] **Step 3: Verify visually and by types**

Run: `npm run typecheck && npm test`
Expected: PASS.

Then: `npm run dev` — confirm by hand: (1) an existing (migrated) workspace shows one scope row named after its folder with its sessions beneath; (2) header `+` opens the folder picker and the chosen folder appears as a second scope; (3) the second scope's `×` appears on hover and removes it; (4) the first scope shows no `×` while its sessions exist; (5) the scope row's `+` opens a session in that scope (check the terminal's cwd via `pwd` typed into the shell… the CLI's own cwd display, or the header path).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Sidebar/index.tsx src/renderer/components/Sidebar/styles.css
git commit -m "feat: scopes section in the sidebar with add and remove"
```

---

### Task 12: GitHub settings section — bind an account to the active workspace

Follows the Harnesses settings pattern (`src/renderer/components/Harnesses/HarnessesSection.tsx`): a `settings-modal-section` component that probes on open, plus the "install gh" empty state the spec requires. Mockup reference: the workspace header chip `SymJavi · sympower` in scene 1 of `full-flow.html` is what this section's binding feeds (the chip itself is Phase 1).

**Files:**
- Create: `src/renderer/components/GitHub/GitHubSection.tsx`
- Create: `src/renderer/components/GitHub/index.ts`
- Create: `src/renderer/components/GitHub/styles.css`
- Modify: `src/renderer/components/Dialogs/SettingsModal.tsx`

**Interfaces:**
- Consumes: `githubBridge.probe()` (Task 7), `useWorkspaceStore.setGitHubBinding` (Task 5), `GhProbeResult`/`GhAccount` (Task 1).
- Produces: UI only.

- [ ] **Step 1: Create `src/renderer/components/GitHub/GitHubSection.tsx`**:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import type { GhProbeResult } from '../../../shared/github';
import { githubBridge } from '../../services/githubBridge';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import './styles.css';

/**
 * The GitHub settings section: bind the active workspace to one `gh` keyring
 * account.
 *
 * Consola stores zero GitHub credentials. The `gh` CLI is the broker: this
 * section only learns which accounts exist (via a main-process probe) and
 * records a login name on the workspace. Tokens are borrowed main-side at
 * spawn time and never reach this component.
 */
export function GitHubSection() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const setGitHubBinding = useWorkspaceStore((state) => state.setGitHubBinding);

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;

  const [probe, setProbe] = useState<GhProbeResult | null>(null);
  const [selectedLogin, setSelectedLogin] = useState<string | null>(null);
  const [org, setOrg] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Availability is a live fact about the machine, so check when the section
  // is opened rather than polling in the background — same as harness health.
  const runProbe = useCallback(() => {
    setProbe(null);
    void githubBridge.probe().then(setProbe);
  }, []);

  useEffect(() => {
    runProbe();
  }, [runProbe]);

  // Follow the workspace's stored binding whenever the workspace changes.
  useEffect(() => {
    setSelectedLogin(workspace?.github?.accountLogin ?? null);
    setOrg(workspace?.github?.org ?? '');
  }, [workspace?.id, workspace?.github?.accountLogin, workspace?.github?.org]);

  const handleSave = async () => {
    if (!workspace || !selectedLogin) return;
    setIsSaving(true);
    try {
      await setGitHubBinding(workspace.id, {
        accountLogin: selectedLogin,
        org: org.trim() || undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnbind = async () => {
    if (!workspace) return;
    setIsSaving(true);
    try {
      await setGitHubBinding(workspace.id, null);
    } finally {
      setIsSaving(false);
    }
  };

  const bound = workspace?.github;
  const isDirty =
    selectedLogin !== (bound?.accountLogin ?? null) || org.trim() !== (bound?.org ?? '');

  return (
    <div className="settings-modal-section">
      <div className="github-section-header">
        <h2 className="settings-modal-section-title">GitHub</h2>
        <button
          type="button"
          className="github-icon-button"
          onClick={runProbe}
          aria-label="Re-check gh"
          title="Re-check gh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <p className="github-section-description">
        Bind a workspace to one <code>gh</code> account and every session in it
        runs <code>gh</code> as that account — no global account switching.
        Consola stores no credentials; the <code>gh</code> CLI holds them.
      </p>

      {probe === null && <p className="github-section-status">Checking for the gh CLI…</p>}

      {probe !== null && !probe.available && (
        <div className="github-empty-state">
          <p>
            GitHub features need the <code>gh</code> CLI, which was not found.
          </p>
          {probe.error && <p className="github-section-error">{probe.error}</p>}
          <p>
            Install it with <code>brew install gh</code> (or see{' '}
            <code>cli.github.com</code>), sign in with <code>gh auth login</code>,
            then re-check. Everything else in Consola works without it.
          </p>
        </div>
      )}

      {probe !== null && probe.available && probe.accounts.length === 0 && (
        <div className="github-empty-state">
          <p>
            <code>gh</code> {probe.version ? `${probe.version} ` : ''}is installed, but no
            accounts are signed in.
          </p>
          {probe.error && <p className="github-section-error">{probe.error}</p>}
          <p>
            Run <code>gh auth login</code> in a terminal (once per account), then re-check.
          </p>
        </div>
      )}

      {probe !== null && probe.available && probe.accounts.length > 0 && !workspace && (
        <p className="github-section-status">Open a workspace to bind an account to it.</p>
      )}

      {probe !== null && probe.available && probe.accounts.length > 0 && workspace && (
        <>
          <h3 className="github-subheading">
            Account for “{workspace.name}”
            {bound && <span className="github-bound-tag">bound: {bound.accountLogin}</span>}
          </h3>
          <div className="github-account-list" role="radiogroup" aria-label="GitHub account">
            {probe.accounts.map((account) => (
              <button
                key={account.login}
                type="button"
                role="radio"
                aria-checked={selectedLogin === account.login}
                className={`github-account-row ${
                  selectedLogin === account.login ? 'selected' : ''
                }`}
                onClick={() => setSelectedLogin(account.login)}
              >
                <span className="github-account-login">{account.login}</span>
                {account.active && (
                  <span className="github-account-hint">gh’s active account</span>
                )}
                {selectedLogin === account.login && <Check size={14} />}
              </button>
            ))}
          </div>

          <label className="github-org-field">
            <span>Organization (optional — narrows the future Inbox)</span>
            <input
              type="text"
              value={org}
              onChange={(event) => setOrg(event.target.value)}
              placeholder="e.g. sympower"
              spellCheck={false}
            />
          </label>

          <div className="github-section-actions">
            <button
              type="button"
              className="dialog-button-primary"
              onClick={() => void handleSave()}
              disabled={!selectedLogin || !isDirty || isSaving}
            >
              {bound ? 'Update binding' : 'Bind account'}
            </button>
            {bound && (
              <button
                type="button"
                className="github-unbind-button"
                onClick={() => void handleUnbind()}
                disabled={isSaving}
              >
                Unbind
              </button>
            )}
          </div>
          <p className="github-section-footnote">
            Applies to sessions the next time their terminal starts. Already-running
            terminals keep the environment they launched with.
          </p>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/renderer/components/GitHub/index.ts`**:

```ts
export { GitHubSection } from './GitHubSection';
```

- [ ] **Step 3: Create `src/renderer/components/GitHub/styles.css`**:

```css
/* GitHub settings section. Follows the Harnesses section's structure. */

.github-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.github-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  opacity: 0.7;
}

.github-icon-button:hover {
  opacity: 1;
}

.github-section-description,
.github-section-status,
.github-section-footnote {
  font-size: 12px;
  opacity: 0.75;
  line-height: 1.5;
  margin: 4px 0 12px;
}

.github-section-error {
  font-size: 12px;
  color: #e5484d;
  white-space: pre-wrap;
  margin: 8px 0;
}

.github-empty-state {
  border: 1px dashed rgba(128, 128, 128, 0.4);
  border-radius: 8px;
  padding: 14px;
  font-size: 13px;
  line-height: 1.6;
}

.github-subheading {
  font-size: 13px;
  font-weight: 600;
  margin: 16px 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.github-bound-tag {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.7;
}

.github-account-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.github-account-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}

.github-account-row.selected {
  border-color: rgba(59, 130, 246, 0.8);
}

.github-account-login {
  flex: 1;
  font-weight: 500;
}

.github-account-hint {
  font-size: 11px;
  opacity: 0.6;
}

.github-org-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 14px 0;
  font-size: 12px;
}

.github-org-field input {
  padding: 6px 8px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 13px;
}

.github-section-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.github-unbind-button {
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  font-size: 12px;
  text-decoration: underline;
}

.github-unbind-button:hover {
  opacity: 1;
}
```

- [ ] **Step 4: Register the section** — in `src/renderer/components/Dialogs/SettingsModal.tsx`:

1. Import: add `Github` to the `lucide-react` import list, and `import { GitHubSection } from '../GitHub';` below the `HarnessesSection` import.
2. `type SettingsSection = 'appearance' | 'harnesses' | 'github' | 'shortcuts';`
3. In `sections`, after the harnesses entry: `{ id: 'github', label: 'GitHub', icon: Github },`
4. In the body, after the harnesses line: `{activeSection === 'github' && <GitHubSection />}`

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

Then `npm run dev`, open Settings → GitHub, and check by hand: (1) with `gh` installed and signed in, accounts list with the active one hinted; (2) bind the active workspace to an account, reopen settings — the binding shows; (3) start a **new** session in that workspace and run `echo $GH_TOKEN`-equivalent through the agent (e.g. ask it to run `gh api user -q .login`) — it acts as the bound account; (4) unbind — the next new session has no `GH_TOKEN`; (5) rename `gh` temporarily (`PATH` without it) — the section shows the install empty state and nothing else in the app changes.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/GitHub src/renderer/components/Dialogs/SettingsModal.tsx
git commit -m "feat: GitHub account binding in workspace settings"
```

---

### Task 13: Full verification sweep

**Files:** none created — this task only runs and reads.

- [ ] **Step 1: No `workspace.path` / `workspace.isGitRepo` stragglers**

```bash
grep -rn "workspace\.path\|workspace\.isGitRepo\|activeWorkspace\.path\|activeWorkspace\.isGitRepo\|\bws\.path\b" src/renderer src/main --include='*.ts' --include='*.tsx' | grep -v test | grep -v "shared/workspace.ts"
```

Expected: no output (the migration ladder in `shared/workspace.ts` is the one legitimate reader of the old fields).

- [ ] **Step 2: Unit suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, zero errors.

- [ ] **Step 3: E2E regression**

Run: `npm run build && npm run test:e2e`
Expected: PASS — the windows spec seeds workspaces through `workspaceAPI.createWorkspace(name, path, false)`, whose signature this phase deliberately kept.

- [ ] **Step 4: Migration smoke test against a copy of real state**

```bash
cp "$HOME/Library/Application Support/consola/workspaces.json" /tmp/workspaces.v5.backup.json 2>/dev/null || echo "no real state on this machine — skip"
```

Launch the dev app (`npm run dev`) against real state and confirm: every workspace opens, every existing session resumes its conversation, the sidebar shows one scope per workspace named after its folder, and the git review panel still shows the same repo as before. (If anything is wrong, the `.bak` written by `JsonStateFile` plus the copy above make the state recoverable — restore and fix the ladder before shipping.) Verify on disk that `workspaces.json` now says `"version": 6` and each workspace has `scopes`/`groups` and no `path`.

- [ ] **Step 5: Invariant walk-through (read, don't run)**

Confirm each against the diff:
- No new code path writes into a PTY except the untouched guarded prompt delivery. (`git diff feature/agent-output-rendering... -- src/main/TerminalService.ts` shows only the async signature, the token borrow, and the env layering.)
- `GhProbeResult` is the only GitHub type that crosses IPC, and it has no token field; `token()` callers all live under `src/main/`.
- `allowedSessionUpdates` still drops `harnessId` and `model` (existing tests), now plus `scopeId`/`cwd`/`kind`/`workItem` (Task 3 tests).
- The built-in harness path is untouched: no changes under `src/main/drivers/`.

---

## Deviations & resolved ambiguities (for the reviewer)

- **Token resolution seam.** The interface contract says "TerminalService resolves workspace → github.accountLogin → GhBroker.token". `TerminalService` has no access to workspace records (by design — it knows one PTY), so the workspace→login step runs in the `TERMINAL_CREATE` handler, which owns `workspaceService`; `TerminalService` does login→token→env. Observable contract unchanged: the renderer sends only `workspaceId`, and no token exists outside main.
- **Token failure at spawn** degrades to a launch without `GH_TOKEN` plus a red in-pane notice. The spec's designated error surface (Inbox header) is Phase 1; silence was rejected because acting as the keyring's ambient account is the bug bindings exist to fix.
- **Migrated scope name** = folder basename (per `Scope.name`'s documented default), falling back to the workspace name when the stored path is empty; scope `createdAt` = workspace `createdAt`.
- **`removeScope`** enforces only the contract's session-reference guard; the *UI* additionally never offers removal of the last scope, so a workspace cannot become scope-less interactively while the service stays exactly as contracted.
- **`archiveGroup`** only stamps `archivedAt`; clearing member `groupId`s is the Phase 2 delete-vs-archive semantics and would be untestable UI-less guesswork now.
- **`gh auth status` parsing** reads stdout *and* stderr (gh historically reported on stderr and exits non-zero when logged out) and never captures the masked token lines — asserted by a test.

## Self-review (performed against the spec before hand-off)

- **Spec coverage (Phase 0 row):** v6 migration → Tasks 1–2; scopes replace `path` → Tasks 1, 4, 9; scope CRUD + picker → Tasks 4, 5, 10, 11; `github` binding UI → Tasks 5, 12; `GhBroker` probe → Tasks 6, 7; `GH_TOKEN` into PTYs → Task 8. Out-of-scope items (Inbox, GitHubService, worktrees, groups UI, fan-out, conductors, headless start) appear nowhere except as group *model* CRUD, which the contract explicitly pulls into Phase 0.
- **Placeholder scan:** every code step carries the actual code; the only prose-driven steps are mechanical threading (Task 8 Step 4) and fixture updates (Task 4 Step 1), each naming exact files, properties and call sites.
- **Type consistency:** `NewScopeFields`/`NewGroupFields` (Task 1) are the parameter types used in Tasks 4, 5; `layerGhToken`/`ghBroker` (Task 6) match Task 8's imports; `scopeForSession`/`primaryScope` (Task 1) match Tasks 9–10; channel constants (Task 5) match handlers (Tasks 5, 7); `createQuickSession(workspaceId, scopeId?)` (Task 10) matches the Sidebar call (Task 11).
