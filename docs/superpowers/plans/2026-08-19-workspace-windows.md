# One Workspace Per Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope each Consola window to a single workspace, move the workspace picker to the top bar, and let a second window hold a second workspace — without ever losing a session record.

**Architecture:** The main process becomes the owner of workspace and harness state, exposed to renderers as intents rather than whole-state writes, so N windows cannot clobber each other. `window-manager.ts` becomes a registry that enforces one workspace per window and arbitrates every switch. `TerminalManager` routes per channel: PTY bytes go to the window rendering the pane, status flags broadcast to every window so any of them can show that another workspace needs attention.

**Tech Stack:** Electron 28, React 19, Zustand 5, TypeScript 5.3, Vite 7, Vitest (added by Task 1), Playwright, node-pty, `@radix-ui/react-dropdown-menu` (already a dependency).

**Spec:** `docs/superpowers/specs/2026-08-19-workspace-windows-design.md`

## Global Constraints

- **Never boot with empty state.** A failed read of `workspaces.json` must load `.bak`; if both fail *and the file existed*, throw. Zero workspaces is indistinguishable from total data loss and silently orphans every transcript.
- **A session's harness is fixed for its lifetime.** No task may add a path that rewrites `Session.harnessId`.
- **A workspace lives in at most one window.** Main arbitrates; the renderer obeys the returned verdict and never assigns a workspace to itself.
- **Never type into a confirmation menu.** No task may change prompt-delivery gating in `TerminalService`/`ScreenModel`.
- **Bridge services only.** Renderer code reaches Electron through `src/renderer/services/*Bridge.ts`, never `window.*API` directly.
- **Channel names live in `src/shared/constants.ts`.** No string literals at call sites.
- **Terminals outlive their views.** Closing a window must not kill a PTY. Only `terminal:destroy` (session close) and `before-quit` may.
- Existing `dist/` layout is unchanged: main builds to `dist/main/main/index.js`, preload to `dist/preload/preload/preload.js`.
- Run `npm run build` before any Playwright task — E2E launches the built main bundle.

## Phase Map

| Phase | Tasks | End state |
|---|---|---|
| 1 — Foundations | 1 | Vitest runs; migration ladder is shared and tested. No behaviour change. |
| 2 — Main owns workspaces | 2–6 | Single window, workspace state in `workspaces.json`, localStorage imported. Shippable. |
| 3 — Main owns harnesses | 7 | Same for harnesses. Shippable. |
| 4 — Multi-window plumbing | 8–10 | Two windows work; no UI to open one yet except a shortcut. Shippable. |
| 5 — Renderer shape | 11–13 | Top-bar switcher, flat sidebar. Shippable. |
| 6 — Polish and proof | 14–15 | Dock badge, window restore, E2E coverage. |

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `vitest.config.ts` | Test runner config, node environment, `src/**/*.test.ts` |
| `src/shared/workspace.ts` | `Workspace`/`Session` types, id generators, `migrateWorkspaceState` — the one migration ladder both processes use |
| `src/shared/workspace.test.ts` | Migration ladder tests |
| `src/main/state/JsonStateFile.ts` | Durable JSON: atomic write, `.bak` rotation, corrupt-read recovery |
| `src/main/state/JsonStateFile.test.ts` | Durability tests |
| `src/main/state/WorkspaceService.ts` | Owns workspaces, applies intents, emits change |
| `src/main/state/WorkspaceService.test.ts` | Intent + import-idempotency tests |
| `src/main/state/HarnessService.ts` | Owns harnesses, same shape |
| `src/main/state/HarnessService.test.ts` | Harness intent tests |
| `src/renderer/services/workspaceBridge.ts` | Renderer → workspace intents |
| `src/renderer/services/harnessBridgeState.ts` | Renderer → harness intents (health probes stay in `harnessBridge.ts`) |
| `src/renderer/services/windowBridge.ts` | Window identity, workspace activation, open-window |
| `src/renderer/components/Layout/WorkspaceSwitcher.tsx` | Top-bar switcher button + dropdown |
| `tests/e2e/windows.spec.ts` | Multi-window E2E |

**Modified**

| File | Change |
|---|---|
| `src/shared/constants.ts` | New `workspace:*` and `window:*` channels |
| `src/shared/types.ts` | `WindowContext`, `ActivateWorkspaceResult` |
| `src/main/window-manager.ts` | Singleton → registry with unique-binding lookup |
| `src/main/index.ts` | `setupIpcHandlers()` once; teardown re-scoped to `before-quit` |
| `src/main/ipc-handlers.ts` | Window-free; hosts workspace/harness/window handlers |
| `src/main/TerminalManager.ts` | Per-instance owner; per-channel routing |
| `src/preload/preload.ts` | `workspaceAPI`, `harnessStateAPI`, `windowAPI` |
| `src/renderer/stores/workspaceStore.ts` | Read-through cache over the bridge |
| `src/renderer/stores/harnessStore.ts` | Same for harnesses |
| `src/renderer/stores/navigationStore.ts` | Workspace/session identity per window; `expandedWorkspaces` deleted |
| `src/renderer/utils/sessionActions.ts` | Mutations become async intents |
| `src/renderer/components/Layout/AppHeader.tsx` | Renders the switcher |
| `src/renderer/components/Sidebar/index.tsx` | Flat session list |
| `src/renderer/components/Views/HomeView.tsx` | Copy no longer names the sidebar |
| `src/renderer/components/Views/NewSessionView.tsx` | Awaits `createSession` |
| `src/renderer/components/Views/ContentView.tsx` | Awaits `updateSession` |
| `src/renderer/components/CommandPalette/buildItems.ts` | Workspace items carry status; activation via `windowBridge` |
| `src/renderer/components/CommandPalette/CommandPalette.tsx` | Awaits harness-default intent |
| `src/renderer/hooks/useKeyboardShortcuts.ts` | `⌘⇧N` opens a window |
| `package.json` | `vitest` devDependency, `test` script |

**Deleted**

| File | Why |
|---|---|
| `src/renderer/components/Sidebar/WorkspaceNavItem.tsx` | The tree it rendered no longer exists |
| `src/renderer/components/Sidebar/WorkspaceActionsMenu.tsx` | Its items move into the switcher dropdown |

---

# Phase 1 — Foundations

## Task 1: Vitest, and one migration ladder in `src/shared`

The migration is the piece whose failure costs conversations, and it currently has no runner at all. Both processes are about to need it, so it moves to `src/shared` and gets tests before anything else is built on top.

**Files:**
- Create: `vitest.config.ts`
- Create: `src/shared/workspace.ts`
- Create: `src/shared/workspace.test.ts`
- Modify: `package.json` (devDependency + `test` script)
- Modify: `src/renderer/stores/workspaceStore.ts` (import from shared, re-export types)

**Interfaces:**
- Consumes: `BUILT_IN_HARNESS_ID` from `src/shared/constants.ts`
- Produces: `Workspace`, `Session`, `generateId(): string`, `generateUuid(): string`, `migrateWorkspaceState(persistedState: unknown, version: number): unknown`, `CURRENT_WORKSPACE_STATE_VERSION: number` (value `5`), `createWorkspaceRecord(...)`, `createSessionRecord(...)`

- [ ] **Step 1: Install Vitest and add the script**

```bash
npm install --save-dev vitest@^3
```

Add to `package.json` `scripts`, directly after `"test:e2e"`:

```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 2: Add the Vitest config**

`vite.config.ts` roots itself at `src/renderer`, which would hide every main-process test. Vitest gets its own config rather than inheriting that root.

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

// Deliberately not extending vite.config.ts: that config roots itself at
// src/renderer, which would make main-process and shared tests invisible.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Write the failing test**

Create `src/shared/workspace.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  generateUuid,
  migrateWorkspaceState,
} from './workspace';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuid', () => {
  it('produces a v4 UUID, which is what `claude --session-id` requires', () => {
    expect(generateUuid()).toMatch(UUID_V4);
  });
});

describe('migrateWorkspaceState', () => {
  it('lifts a v2 workspace out of its first project', () => {
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

    expect(workspace.path).toBe('/code/consola');
    expect(workspace.isGitRepo).toBe(true);
    expect(workspace.projects).toBeUndefined();
  });

  it('mints a session UUID for pre-v4 sessions, which had no conversation of their own', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          sessions: [
            { id: 's1', name: 'Old', workspaceId: 'w1', instanceId: 'i1', createdAt: 1, lastActiveAt: 2 },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 3) as { workspaces: any[] };
    const session = migrated.workspaces[0].sessions[0];

    expect(session.claudeSessionId).toMatch(UUID_V4);
    expect(session.hasStarted).toBe(false);
  });

  it('backfills the built-in harness so pre-v5 transcripts stay resolvable', () => {
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

    expect(migrated.workspaces[0].defaultHarnessId).toBe('default');
    expect(migrated.workspaces[0].sessions[0].harnessId).toBe('default');
  });

  it('leaves an already-current state alone', () => {
    const session = {
      id: 's1',
      name: 'Current',
      workspaceId: 'w1',
      instanceId: 'i1',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      hasStarted: true,
      harnessId: 'work',
      createdAt: 1,
      lastActiveAt: 2,
    };
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          defaultHarnessId: 'work',
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
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./workspace"`.

- [ ] **Step 5: Create the shared module**

Create `src/shared/workspace.ts`. The bodies of `generateId`, `generateUuid`, and `migrateWorkspaceState` move verbatim from `src/renderer/stores/workspaceStore.ts` — this is a move, not a rewrite, because it is the ladder every existing installation has already walked. `createWorkspaceRecord` and `createSessionRecord` are lifted out of the store's actions so main can build records with the same shape.

```typescript
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
```

Note the one deliberate change from the original: the v2 branch now also fills `claudeSessionId`/`hasStarted`, which the original left to the second branch. Both branches produced the same result before because the v2 branch was unreachable for states that already had a path; making it explicit means each branch is correct on its own and the test above pins it.

- [ ] **Step 6: Point the store at the shared module**

In `src/renderer/stores/workspaceStore.ts`, delete the local `Session` interface, `Workspace` interface, `generateId`, `generateUuid`, and `migrateWorkspaceState`. Replace the top of the file with:

```typescript
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { BUILT_IN_HARNESS_ID } from '../../shared/constants';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  createSessionRecord,
  createWorkspaceRecord,
  migrateWorkspaceState,
} from '../../shared/workspace';

// Fifteen files import these from here. Re-exported rather than relocated so
// this task stays a move, not a rename sweep.
export type { Session, Workspace } from '../../shared/workspace';
export { migrateWorkspaceState } from '../../shared/workspace';
```

Then replace the two record-building sites to use the shared helpers:

```typescript
      createWorkspace: (name, path, isGitRepo, defaultHarnessId = BUILT_IN_HARNESS_ID) => {
        const workspace = createWorkspaceRecord(name, path, isGitRepo, defaultHarnessId);
        set((state) => ({ workspaces: [...state.workspaces, workspace] }));
        return workspace;
      },
```

```typescript
      createSession: (workspaceId, sessionData) => {
        const session = createSessionRecord(sessionData);
        const now = session.createdAt;
        let createdSession: Session | undefined;
        set((state) => ({
          workspaces: state.workspaces.map((ws) => {
            if (ws.id === workspaceId) {
              createdSession = session;
              return { ...ws, sessions: [...ws.sessions, session], updatedAt: now };
            }
            return ws;
          }),
        }));
        return createdSession;
      },
```

And in the `persist` options, replace the literal `version: 5` with `version: CURRENT_WORKSPACE_STATE_VERSION`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 5 tests.

- [ ] **Step 8: Verify nothing else broke**

Run: `npm run build`
Expected: all three builds succeed with no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add vitest.config.ts package.json package-lock.json src/shared/workspace.ts src/shared/workspace.test.ts src/renderer/stores/workspaceStore.ts
git commit -m "test: Give the workspace migration a runner and a home in shared"
```

---

# Phase 2 — Main owns workspace state

## Task 2: `JsonStateFile` — durable JSON with a real recovery path

Everything in Phase 2 rests on this file never half-writing and never coming back empty after a bad read.

**Files:**
- Create: `src/main/state/JsonStateFile.ts`
- Create: `src/main/state/JsonStateFile.test.ts`

**Interfaces:**
- Produces: `class JsonStateFile<T>` with `exists(): boolean`, `read(): T | null`, `write(value: T): void`. `read()` returns `null` only when nothing has ever been written, and throws `StateFileCorruptError` when both the primary and the backup fail to parse.

- [ ] **Step 1: Write the failing test**

Create `src/main/state/JsonStateFile.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile, StateFileCorruptError } from './JsonStateFile';

interface Shape {
  version: number;
  items: string[];
}

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-state-'));
  filePath = path.join(dir, 'nested', 'state.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('JsonStateFile', () => {
  it('reports nothing written as null rather than as empty state', () => {
    const file = new JsonStateFile<Shape>(filePath);

    expect(file.exists()).toBe(false);
    expect(file.read()).toBeNull();
  });

  it('creates missing directories and round-trips a value', () => {
    const file = new JsonStateFile<Shape>(filePath);

    file.write({ version: 5, items: ['a'] });

    expect(file.exists()).toBe(true);
    expect(file.read()).toEqual({ version: 5, items: ['a'] });
  });

  it('leaves no temp file behind', () => {
    const file = new JsonStateFile<Shape>(filePath);

    file.write({ version: 5, items: ['a'] });

    const leftovers = fs.readdirSync(path.dirname(filePath)).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('falls back to the backup when the primary is corrupt', () => {
    const file = new JsonStateFile<Shape>(filePath);
    file.write({ version: 5, items: ['first'] });
    file.write({ version: 5, items: ['second'] });

    fs.writeFileSync(filePath, '{ this is not json');

    expect(file.read()).toEqual({ version: 5, items: ['first'] });
  });

  it('throws rather than returning empty state when both copies are corrupt', () => {
    const file = new JsonStateFile<Shape>(filePath);
    file.write({ version: 5, items: ['first'] });
    file.write({ version: 5, items: ['second'] });

    fs.writeFileSync(filePath, '{ broken');
    fs.writeFileSync(`${filePath}.bak`, '{ also broken');

    expect(() => file.read()).toThrow(StateFileCorruptError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- JsonStateFile`
Expected: FAIL — `Failed to resolve import "./JsonStateFile"`.

- [ ] **Step 3: Implement `JsonStateFile`**

Create `src/main/state/JsonStateFile.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

/**
 * Raised when neither the primary file nor its backup can be parsed.
 *
 * Deliberately not recoverable into empty state: zero workspaces is
 * indistinguishable from total data loss to the person looking at it, and it
 * would silently orphan every transcript on disk.
 */
export class StateFileCorruptError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Could not read ${filePath} or its backup: ${String(cause)}`);
    this.name = 'StateFileCorruptError';
  }
}

/**
 * A JSON file that survives a crash mid-write.
 *
 * Writes go to a temp file, are flushed, and are renamed into place, so the
 * primary is either the old value or the new one and never a truncated mix.
 * The previous value is kept alongside as `.bak`, which is what makes a bad
 * primary recoverable instead of fatal.
 */
export class JsonStateFile<T> {
  private readonly backupPath: string;
  private readonly tempPath: string;

  constructor(private readonly filePath: string) {
    this.backupPath = `${filePath}.bak`;
    this.tempPath = `${filePath}.tmp`;
  }

  public exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * @returns The stored value, or null when nothing has ever been written.
   * @throws StateFileCorruptError when a file exists but nothing parses.
   */
  public read(): T | null {
    if (!fs.existsSync(this.filePath) && !fs.existsSync(this.backupPath)) {
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as T;
    } catch (primaryError) {
      try {
        return JSON.parse(fs.readFileSync(this.backupPath, 'utf8')) as T;
      } catch {
        throw new StateFileCorruptError(this.filePath, primaryError);
      }
    }
  }

  public write(value: T): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath);
    }

    const handle = fs.openSync(this.tempPath, 'w');
    try {
      fs.writeFileSync(handle, JSON.stringify(value, null, 2), 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }

    fs.renameSync(this.tempPath, this.filePath);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- JsonStateFile`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/state/JsonStateFile.ts src/main/state/JsonStateFile.test.ts
git commit -m "feat: Add a JSON state file that survives a crash mid-write"
```

---

## Task 3: `WorkspaceService` — the single writer

**Files:**
- Create: `src/main/state/WorkspaceService.ts`
- Create: `src/main/state/WorkspaceService.test.ts`

**Interfaces:**
- Consumes: `JsonStateFile` (Task 2); `Workspace`, `Session`, `NewSessionFields`, `createWorkspaceRecord`, `createSessionRecord`, `migrateWorkspaceState`, `CURRENT_WORKSPACE_STATE_VERSION` (Task 1)
- Produces:
  ```typescript
  interface WorkspaceStateFile { version: number; workspaces: Workspace[] }
  class WorkspaceService {
    load(): void
    hasState(): boolean
    getAll(): Workspace[]
    importState(workspaces: Workspace[], version: number): boolean
    createWorkspace(name: string, path: string, isGitRepo: boolean, defaultHarnessId?: string): Workspace
    deleteWorkspace(id: string): void
    updateWorkspace(id: string, updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>): void
    createSession(workspaceId: string, fields: NewSessionFields): Session | undefined
    updateSession(workspaceId: string, sessionId: string, updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>): void
    deleteSession(workspaceId: string, sessionId: string): void
    onChange(listener: (workspaces: Workspace[]) => void): () => void
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/main/state/WorkspaceService.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile } from './JsonStateFile';
import { WorkspaceService, type WorkspaceStateFile } from './WorkspaceService';

let dir: string;
let service: WorkspaceService;

function build(): WorkspaceService {
  const file = new JsonStateFile<WorkspaceStateFile>(path.join(dir, 'workspaces.json'));
  const built = new WorkspaceService(file);
  built.load();
  return built;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-ws-'));
  service = build();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkspaceService', () => {
  it('starts empty and reports that nothing has been imported yet', () => {
    expect(service.hasState()).toBe(false);
    expect(service.getAll()).toEqual([]);
  });

  it('persists a created workspace across a reload', () => {
    service.createWorkspace('consola', '/code/consola', true);

    const reloaded = build();

    expect(reloaded.getAll()).toHaveLength(1);
    expect(reloaded.getAll()[0].name).toBe('consola');
    expect(reloaded.hasState()).toBe(true);
  });

  it('notifies listeners on every mutation', () => {
    const listener = vi.fn();
    service.onChange(listener);

    const workspace = service.createWorkspace('consola', '/code/consola', true);
    service.updateWorkspace(workspace.id, { name: 'renamed' });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0][0].name).toBe('renamed');
  });

  it('gives a new session its own conversation id and marks it unstarted', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    const session = service.createSession(workspace.id, {
      name: 'New Session',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
    });

    expect(session?.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session?.hasStarted).toBe(false);
    expect(service.getAll()[0].sessions).toHaveLength(1);
  });

  it('returns undefined rather than throwing for a session in a missing workspace', () => {
    const session = service.createSession('nope', {
      name: 'New Session',
      workspaceId: 'nope',
      instanceId: 'instance-1',
      harnessId: 'default',
    });

    expect(session).toBeUndefined();
  });

  it('drops a workspace and its sessions together', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    service.createSession(workspace.id, {
      name: 'New Session',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
    });

    service.deleteWorkspace(workspace.id);

    expect(service.getAll()).toEqual([]);
  });

  it('accepts an import once and ignores every later one', () => {
    const imported = service.importState(
      [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      5
    );

    expect(imported).toBe(true);
    expect(service.getAll()).toHaveLength(1);

    const second = service.importState(
      [
        {
          id: 'w2',
          name: 'other',
          path: '/code/other',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      5
    );

    expect(second).toBe(false);
    expect(service.getAll()).toHaveLength(1);
    expect(service.getAll()[0].id).toBe('w1');
  });

  it('runs the migration ladder on imported state', () => {
    service.importState(
      [
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
              lastActiveAt: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      4
    );

    expect(service.getAll()[0].defaultHarnessId).toBe('default');
    expect(service.getAll()[0].sessions[0].harnessId).toBe('default');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- WorkspaceService`
Expected: FAIL — `Failed to resolve import "./WorkspaceService"`.

- [ ] **Step 3: Implement `WorkspaceService`**

Create `src/main/state/WorkspaceService.ts`:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- WorkspaceService`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/state/WorkspaceService.ts src/main/state/WorkspaceService.test.ts
git commit -m "feat: Make the main process the single writer for workspaces"
```

---

## Task 4: Wire the workspace intents across the bridge

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/preload.ts`
- Create: `src/renderer/services/workspaceBridge.ts`

**Interfaces:**
- Consumes: `WorkspaceService` (Task 3)
- Produces: `workspaceBridge` with `getSnapshot()`, `importState(workspaces, version)`, `createWorkspace(...)`, `deleteWorkspace(id)`, `updateWorkspace(id, updates)`, `createSession(workspaceId, fields)`, `updateSession(workspaceId, sessionId, updates)`, `deleteSession(workspaceId, sessionId)`, `onChanged(cb)`. Also the type `WorkspaceSnapshot { workspaces: Workspace[]; needsImport: boolean }`.

- [ ] **Step 1: Add the channels**

In `src/shared/constants.ts`, insert after the `HARNESS_SESSION_NAME` line:

```typescript
    // Workspace state (renderer -> main; main owns the records)
    WORKSPACE_GET_SNAPSHOT: 'workspace:get-snapshot',   // Current list + whether an import is due
    WORKSPACE_IMPORT: 'workspace:import',               // One-time handoff from localStorage
    WORKSPACE_CREATE: 'workspace:create',
    WORKSPACE_UPDATE: 'workspace:update',
    WORKSPACE_DELETE: 'workspace:delete',
    WORKSPACE_SESSION_CREATE: 'workspace:session-create',
    WORKSPACE_SESSION_UPDATE: 'workspace:session-update',
    WORKSPACE_SESSION_DELETE: 'workspace:session-delete',

    // Workspace state (main -> every renderer)
    WORKSPACE_CHANGED: 'workspace:changed',
```

- [ ] **Step 2: Add the snapshot type**

Append to `src/shared/types.ts`:

```typescript
import type { Workspace } from './workspace';

/**
 * What a renderer gets when it asks main for the workspace list.
 *
 * `needsImport` is true only on the first launch after workspaces moved into
 * the main process, when the records still live in the renderer's localStorage.
 */
export interface WorkspaceSnapshot {
    workspaces: Workspace[];
    needsImport: boolean;
}
```

- [ ] **Step 3: Register the handlers**

In `src/main/ipc-handlers.ts`, add the imports:

```typescript
import { app } from 'electron';
import { JsonStateFile } from './state/JsonStateFile';
import { WorkspaceService, type WorkspaceStateFile } from './state/WorkspaceService';
import type { NewSessionFields, Session, Workspace } from '../shared/workspace';
```

Add the module-level holder beside `terminalManager`:

```typescript
let workspaceService: WorkspaceService | null = null;
```

Inside `setupIpcHandlers`, before the terminal handlers:

```typescript
    const workspaceFile = new JsonStateFile<WorkspaceStateFile>(
        path.join(app.getPath('userData'), 'workspaces.json')
    );
    const workspaces = new WorkspaceService(workspaceFile);
    workspaces.load();
    workspaceService = workspaces;

    // Every window renders the same records, so a change goes to all of them
    // rather than to whoever asked for it.
    workspaces.onChange((all) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(IPC_CHANNELS.WORKSPACE_CHANGED, all);
            }
        }
    });

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_SNAPSHOT, () => ({
        workspaces: workspaces.getAll(),
        needsImport: !workspaces.hasState(),
    }));

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_IMPORT,
        (_event, incoming: Workspace[], version: number) => workspaces.importState(incoming, version)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_CREATE,
        (_event, name: string, workspacePath: string, isGitRepo: boolean, defaultHarnessId?: string) =>
            workspaces.createWorkspace(name, workspacePath, isGitRepo, defaultHarnessId)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_UPDATE,
        (_event, id: string, updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>) =>
            workspaces.updateWorkspace(id, updates)
    );

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, (_event, id: string) =>
        workspaces.deleteWorkspace(id)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_CREATE,
        (_event, workspaceId: string, fields: NewSessionFields) =>
            workspaces.createSession(workspaceId, fields)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_UPDATE,
        (
            _event,
            workspaceId: string,
            sessionId: string,
            updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
        ) => workspaces.updateSession(workspaceId, sessionId, updates)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_DELETE,
        (_event, workspaceId: string, sessionId: string) =>
            workspaces.deleteSession(workspaceId, sessionId)
    );
```

In `cleanupIpcHandlers`, add:

```typescript
    workspaceService = null;
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GET_SNAPSHOT);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_IMPORT);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_UPDATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_DELETE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_UPDATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_DELETE);
```

- [ ] **Step 4: Expose it in preload**

In `src/preload/preload.ts`, add `WorkspaceSnapshot` to the `../shared/types` import, add `import type { NewSessionFields, Session, Workspace } from '../shared/workspace';`, and append a new bridge after `harnessAPI`:

```typescript
// Expose workspace state to the renderer. Main owns the records; the renderer
// sends intents and listens for the result.
contextBridge.exposeInMainWorld('workspaceAPI', {
    getSnapshot: (): Promise<WorkspaceSnapshot> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_SNAPSHOT),

    importState: (workspaces: Workspace[], version: number): Promise<boolean> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_IMPORT, workspaces, version),

    createWorkspace: (
        name: string,
        path: string,
        isGitRepo: boolean,
        defaultHarnessId?: string
    ): Promise<Workspace> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, name, path, isGitRepo, defaultHarnessId),

    updateWorkspace: (
        id: string,
        updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
    ): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE, id, updates),

    deleteWorkspace: (id: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, id),

    createSession: (workspaceId: string, fields: NewSessionFields): Promise<Session | undefined> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_CREATE, workspaceId, fields),

    updateSession: (
        workspaceId: string,
        sessionId: string,
        updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
    ): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_UPDATE, workspaceId, sessionId, updates),

    deleteSession: (workspaceId: string, sessionId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_DELETE, workspaceId, sessionId),

    onChanged: (callback: (workspaces: Workspace[]) => void) =>
        subscribe<Workspace[]>(IPC_CHANNELS.WORKSPACE_CHANGED, callback),
});
```

Declare it on the window type. In `src/renderer/types/` find the existing global declaration file (the one declaring `terminalAPI`) and add:

```typescript
    workspaceAPI: {
        getSnapshot: () => Promise<WorkspaceSnapshot>;
        importState: (workspaces: Workspace[], version: number) => Promise<boolean>;
        createWorkspace: (
            name: string,
            path: string,
            isGitRepo: boolean,
            defaultHarnessId?: string
        ) => Promise<Workspace>;
        updateWorkspace: (
            id: string,
            updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
        ) => Promise<void>;
        deleteWorkspace: (id: string) => Promise<void>;
        createSession: (workspaceId: string, fields: NewSessionFields) => Promise<Session | undefined>;
        updateSession: (
            workspaceId: string,
            sessionId: string,
            updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
        ) => Promise<void>;
        deleteSession: (workspaceId: string, sessionId: string) => Promise<void>;
        onChanged: (callback: (workspaces: Workspace[]) => void) => () => void;
    };
```

- [ ] **Step 5: Add the renderer bridge**

Create `src/renderer/services/workspaceBridge.ts`:

```typescript
import type { WorkspaceSnapshot } from '../../shared/types';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';

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
        defaultHarnessId?: string
    ): Promise<Workspace> {
        return window.workspaceAPI.createWorkspace(name, path, isGitRepo, defaultHarnessId);
    },

    updateWorkspace(
        id: string,
        updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
    ): Promise<void> {
        return window.workspaceAPI.updateWorkspace(id, updates);
    },

    deleteWorkspace(id: string): Promise<void> {
        return window.workspaceAPI.deleteWorkspace(id);
    },

    createSession(workspaceId: string, fields: NewSessionFields): Promise<Session | undefined> {
        return window.workspaceAPI.createSession(workspaceId, fields);
    },

    updateSession(
        workspaceId: string,
        sessionId: string,
        updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
    ): Promise<void> {
        return window.workspaceAPI.updateSession(workspaceId, sessionId, updates);
    },

    deleteSession(workspaceId: string, sessionId: string): Promise<void> {
        return window.workspaceAPI.deleteSession(workspaceId, sessionId);
    },

    onChanged(callback: (workspaces: Workspace[]) => void): () => void {
        return window.workspaceAPI.onChanged(callback);
    },
};
```

- [ ] **Step 6: Verify it compiles**

Run: `npm run build`
Expected: all three builds succeed. Nothing calls the bridge yet — that is Task 5.

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.ts src/shared/types.ts src/main/ipc-handlers.ts src/preload/preload.ts src/renderer/services/workspaceBridge.ts src/renderer/types
git commit -m "feat: Carry workspace intents from the renderer to the main process"
```

---

## Task 5: Turn the store into a read-through cache, and hand off localStorage

The 27 read sites keep working untouched. Only the store's internals change: reads come from a snapshot main pushed, writes go out as intents.

**Files:**
- Modify: `src/renderer/stores/workspaceStore.ts`
- Modify: `src/renderer/main.tsx`

**Interfaces:**
- Consumes: `workspaceBridge` (Task 4), `CURRENT_WORKSPACE_STATE_VERSION` (Task 1)
- Produces: `hydrateWorkspaceStore(): Promise<void>`; the store's mutating actions now return `Promise`. `createWorkspace` resolves to `Workspace`, `createSession` resolves to `Session | undefined`, the rest resolve to `void`. `getWorkspace`, `getSession`, `getWorkspaceSessions`, and the `workspaces` array stay synchronous.

- [ ] **Step 1: Rewrite the store**

Replace the whole body of `src/renderer/stores/workspaceStore.ts` (keeping the type re-exports added in Task 1) with:

```typescript
import { create } from 'zustand';
import { workspaceBridge } from '../services/workspaceBridge';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  type NewSessionFields,
  type Session,
  type Workspace,
} from '../../shared/workspace';

export type { Session, Workspace } from '../../shared/workspace';
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
    updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
  ) => Promise<void>;
  deleteSession: (workspaceId: string, sessionId: string) => Promise<void>;
  getSession: (workspaceId: string, sessionId: string) => Session | undefined;
  getWorkspaceSessions: (workspaceId: string) => Session[];
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
      await workspaceBridge.importState(
        legacy.workspaces,
        legacy.version || CURRENT_WORKSPACE_STATE_VERSION
      );
      snapshot = await workspaceBridge.getSnapshot();
    }
  }

  useWorkspaceStore.setState({ workspaces: snapshot.workspaces });

  workspaceBridge.onChanged((workspaces) => {
    useWorkspaceStore.setState({ workspaces });
  });
}
```

- [ ] **Step 2: Hydrate before the first render**

Replace the render call at the bottom of `src/renderer/main.tsx`:

```typescript
async function bootstrap() {
  // Records live in the main process now, so they have to arrive before the
  // first render — an empty list on screen is indistinguishable from having no
  // workspaces at all.
  await hydrateWorkspaceStore();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}

void bootstrap();
```

And add the import at the top:

```typescript
import { hydrateWorkspaceStore } from './stores/workspaceStore';
```

- [ ] **Step 3: Build and check the type errors are exactly the mutation sites**

Run: `npm run build`
Expected: FAIL, with errors only in these files — they are the 12 mutation sites Task 6 converts:
`sessionActions.ts`, `Sidebar/index.tsx`, `Sidebar/WorkspaceNavItem.tsx`, `Sidebar/WorkspaceActionsMenu.tsx`, `Sidebar/SessionNavItem.tsx`, `Views/HomeView.tsx`, `Views/NewSessionView.tsx`, `Views/ContentView.tsx`, `CommandPalette/buildItems.ts`, `CommandPalette/CommandPalette.tsx`.

If any *other* file errors, a read site was not as read-only as assumed — fix it in Task 6 and note it.

- [ ] **Step 4: Commit the work-in-progress**

The build is red until Task 6. Commit anyway so the store change is reviewable on its own.

```bash
git add src/renderer/stores/workspaceStore.ts src/renderer/main.tsx
git commit -m "refactor: Read workspaces through main instead of localStorage"
```

---

## Task 6: Convert the twelve mutation sites

**Files:**
- Modify: `src/renderer/utils/sessionActions.ts:46,80,102`
- Modify: `src/renderer/components/Sidebar/index.tsx:15`
- Modify: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx:20`
- Modify: `src/renderer/components/Sidebar/WorkspaceActionsMenu.tsx:14`
- Modify: `src/renderer/components/Sidebar/SessionNavItem.tsx:37`
- Modify: `src/renderer/components/Views/HomeView.tsx:9`
- Modify: `src/renderer/components/Views/NewSessionView.tsx:21`
- Modify: `src/renderer/components/Views/ContentView.tsx:33`
- Modify: `src/renderer/components/CommandPalette/buildItems.ts:124`
- Modify: `src/renderer/components/CommandPalette/CommandPalette.tsx:228`

**Interfaces:**
- Consumes: the async store actions from Task 5
- Produces: `createQuickSession(workspaceId: string): Promise<Session | undefined>`, `deleteSessionCompletely(workspaceId: string, session: Session): Promise<void>`, `renameSession(workspaceId: string, session: Session, name: string): Promise<void>`. `activateSession`, `openNewSessionComposer`, `restartSession`, and `generateSessionInstanceId` stay synchronous.

- [ ] **Step 1: Convert `sessionActions.ts`**

Three functions become async. Replace them:

```typescript
export async function createQuickSession(workspaceId: string): Promise<Session | undefined> {
  const workspace = useWorkspaceStore.getState().getWorkspace(workspaceId);
  if (!workspace) return undefined;

  const session = await useWorkspaceStore.getState().createSession(workspaceId, {
    name: 'New Session',
    workspaceId,
    instanceId: generateSessionInstanceId(workspaceId),
    harnessId: workspace.defaultHarnessId,
  });

  if (session) {
    activateSession(workspaceId, session.id);
  }
  return session;
}
```

```typescript
export async function deleteSessionCompletely(
  workspaceId: string,
  session: Session
): Promise<void> {
  // The PTY dies first: if the record went away and this threw, the terminal
  // would keep running with nothing left to reattach it to.
  terminalBridge.destroy(session.instanceId);
  useTerminalStore.getState().removeInstance(session.instanceId);
  await useWorkspaceStore.getState().deleteSession(workspaceId, session.id);

  if (useNavigationStore.getState().activeSessionId === session.id) {
    useNavigationStore.getState().setActiveSession(null);
  }
}
```

```typescript
export async function renameSession(
  workspaceId: string,
  session: Session,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed === session.name) return;
  await useWorkspaceStore.getState().updateSession(workspaceId, session.id, { name: trimmed });
}
```

- [ ] **Step 2: Convert the component handlers**

Each of these is an event handler, so the change is `async` plus `await`. In `src/renderer/components/Sidebar/index.tsx`:

```typescript
  const handleNewWorkspace = async () => {
    const result = await dialogBridge.selectFolder();
    if (result) {
      const workspace = await createWorkspace(result.name, result.path, result.isGitRepo);
      setActiveWorkspace(workspace.id);
    }
  };
```

In `src/renderer/components/Views/HomeView.tsx`:

```typescript
  const handleCreateWorkspace = async () => {
    const result = await dialogBridge.selectFolder();
    if (result) {
      const workspace = await createWorkspace(result.name, result.path, result.isGitRepo);
      setActiveWorkspace(workspace.id);
    }
  };
```

In `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`:

```typescript
  const handleDelete = async () => {
    // Clear the selection first: deleting the active workspace would otherwise
    // leave the content area pointed at a record that no longer exists.
    if (activeWorkspaceId === workspace.id) {
      setActiveWorkspace(null);
    }
    await deleteWorkspace(workspace.id);
  };

  const handleAddSession = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void createQuickSession(workspace.id);
  };
```

In `src/renderer/components/Sidebar/SessionNavItem.tsx`, `handleRename` and `handleDelete`:

```typescript
  const handleRename = async () => {
    const trimmedName = newName.trim();
    if (trimmedName && trimmedName !== session.name) {
      await updateSession(workspaceId, session.id, { name: trimmedName });
    } else {
      setNewName(session.name);
    }
    setIsRenaming(false);
  };

  const handleDelete = () => {
    void deleteSessionCompletely(workspaceId, session);
  };
```

`handleKeyDown` calls `handleRename()`; change its `Enter` branch to `void handleRename();`.

In `src/renderer/components/Sidebar/WorkspaceActionsMenu.tsx`, every `updateWorkspace(...)` call gains `void` if its result is discarded, or `await` inside an `async` handler if the handler does anything afterwards.

In `src/renderer/components/Views/NewSessionView.tsx`, the submit handler awaits `createSession` and only navigates on a defined result:

```typescript
    const session = await createSession(workspace.id, {
      name: '',
      workspaceId: workspace.id,
      instanceId: generateSessionInstanceId(workspace.id),
      harnessId: selectedHarnessId,
    });
    if (!session) return;
```

In `src/renderer/components/Views/ContentView.tsx`, the `updateSession` calls that record a generated name or `hasStarted` become `void updateSession(...)` — nothing reads their result, and the broadcast will refresh the list.

In `src/renderer/components/CommandPalette/buildItems.ts:124`:

```typescript
        const workspace = await useWorkspaceStore
          .getState()
          .createWorkspace(folder.name, folder.path, folder.isGitRepo);
        useNavigationStore.getState().setActiveWorkspace(workspace.id);
```

Its enclosing `run` callback becomes `async`. Check `types.ts` in the same folder: if `PaletteItem.run` is typed `() => void`, widen it to `() => void | Promise<void>`.

In `src/renderer/components/CommandPalette/CommandPalette.tsx:228`:

```typescript
              void useWorkspaceStore
                .getState()
                .updateWorkspace(mode.workspaceId, { defaultHarnessId: item.harnessId });
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS, no TypeScript errors.

- [ ] **Step 4: Run the unit tests**

Run: `npm test`
Expected: PASS — 13 tests.

- [ ] **Step 5: Verify the import by hand**

Run: `npm run dev`

Check, in order:
1. Every workspace and session that existed before is on screen.
2. `~/Library/Application Support/Consola Dev/workspaces.json` exists and contains them.
3. `localStorage.getItem('consola-workspaces')` in devtools still returns the old blob — it is the fallback and must not have been cleared.
4. Create a workspace, quit, relaunch: it is still there.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: Send workspace mutations as intents"
```

---

# Phase 3 — Main owns harness state

## Task 7: `HarnessService`

Harnesses move for the same reason workspaces did: a lost harness record orphans every transcript written under it. Health probes stay where they are — a probe is a live fact, never persisted, and `harnessBridge.ts` already owns that.

**Files:**
- Create: `src/main/state/HarnessService.ts`
- Create: `src/main/state/HarnessService.test.ts`
- Create: `src/renderer/services/harnessBridgeState.ts`
- Modify: `src/shared/constants.ts`, `src/main/ipc-handlers.ts`, `src/preload/preload.ts`
- Modify: `src/renderer/stores/harnessStore.ts`
- Move: `Harness`, `HarnessHealthState`, `HarnessStatus`, `HARNESS_ACCENT_COLORS`, `DEFAULT_ACCENT_COLOR`, `HARNESS_ID_PATTERN`, `createBuiltInHarness` from `harnessStore.ts` into `src/shared/harness.ts`

**Interfaces:**
- Consumes: `JsonStateFile` (Task 2)
- Produces:
  ```typescript
  interface HarnessStateFile { version: number; harnesses: Harness[] }
  class HarnessService {
    load(): void
    hasState(): boolean
    getAll(): Harness[]
    importState(harnesses: Harness[]): boolean
    addHarness(input: NewHarnessFields): Harness
    updateHarness(id: string, updates: HarnessUpdates): void
    archiveHarness(id: string): void
    restoreHarness(id: string): void
    onChange(listener: (harnesses: Harness[]) => void): () => void
  }
  ```
  where `NewHarnessFields = Pick<Harness, 'id' | 'driverId' | 'name' | 'accentColor'> & Partial<Pick<Harness, 'binaryPath' | 'configDir' | 'extraArgs' | 'enabled'>>` and `HarnessUpdates = Partial<Pick<Harness, 'name' | 'accentColor' | 'enabled' | 'binaryPath' | 'configDir' | 'extraArgs'>>`.

- [ ] **Step 1: Write the failing test**

Create `src/main/state/HarnessService.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile } from './JsonStateFile';
import { HarnessService, type HarnessStateFile } from './HarnessService';

let dir: string;
let service: HarnessService;

function build(): HarnessService {
  const file = new JsonStateFile<HarnessStateFile>(path.join(dir, 'harnesses.json'));
  const built = new HarnessService(file);
  built.load();
  return built;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-harness-'));
  service = build();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('HarnessService', () => {
  it('seeds the built-in harness, which pins nothing', () => {
    const builtIn = service.getAll().find((harness) => harness.isBuiltIn);

    expect(builtIn?.id).toBe('default');
    expect(builtIn?.binaryPath).toBeUndefined();
    expect(builtIn?.configDir).toBeUndefined();
    expect(builtIn?.extraArgs).toEqual([]);
  });

  it('persists an added harness across a reload', () => {
    service.addHarness({ id: 'work', driverId: 'claude', name: 'Work', accentColor: '#3b82f6' });

    expect(build().getAll().map((harness) => harness.id)).toContain('work');
  });

  it('archives rather than deletes, so sessions can still resume', () => {
    service.addHarness({ id: 'work', driverId: 'claude', name: 'Work', accentColor: '#3b82f6' });

    service.archiveHarness('work');

    const archived = service.getAll().find((harness) => harness.id === 'work');
    expect(archived).toBeDefined();
    expect(archived?.archived).toBe(true);
  });

  it('refuses to archive the built-in harness', () => {
    service.archiveHarness('default');

    expect(service.getAll().find((harness) => harness.id === 'default')?.archived).toBe(false);
  });

  it('accepts an import once and ignores every later one', () => {
    const first = service.importState([
      {
        id: 'imported',
        driverId: 'claude',
        name: 'Imported',
        accentColor: '#22c55e',
        enabled: true,
        archived: false,
        isBuiltIn: false,
        extraArgs: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(first).toBe(true);
    expect(service.importState([])).toBe(false);
    expect(service.getAll().map((harness) => harness.id)).toContain('imported');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- HarnessService`
Expected: FAIL — `Failed to resolve import "./HarnessService"`.

- [ ] **Step 3: Move the harness types into `src/shared/harness.ts`**

Cut `HARNESS_ACCENT_COLORS`, `DEFAULT_ACCENT_COLOR`, `Harness`, `HarnessHealthState`, `HarnessStatus`, `HARNESS_ID_PATTERN`, and `createBuiltInHarness` out of `src/renderer/stores/harnessStore.ts` into a new `src/shared/harness.ts`, verbatim including their doc comments. Add at the top of the new file:

```typescript
import { BUILT_IN_HARNESS_ID } from './constants';
import type { HarnessDriverId } from './types';

export type NewHarnessFields = Pick<Harness, 'id' | 'driverId' | 'name' | 'accentColor'> &
    Partial<Pick<Harness, 'binaryPath' | 'configDir' | 'extraArgs' | 'enabled'>>;

export type HarnessUpdates = Partial<
    Pick<Harness, 'name' | 'accentColor' | 'enabled' | 'binaryPath' | 'configDir' | 'extraArgs'>
>;
```

Re-export from `harnessStore.ts` so its consumers are untouched:

```typescript
export type { Harness, HarnessHealthState, HarnessStatus } from '../../shared/harness';
export { HARNESS_ACCENT_COLORS, DEFAULT_ACCENT_COLOR, HARNESS_ID_PATTERN } from '../../shared/harness';
```

- [ ] **Step 4: Implement `HarnessService`**

Create `src/main/state/HarnessService.ts`:

```typescript
import { JsonStateFile } from './JsonStateFile';
import { BUILT_IN_HARNESS_ID } from '../../shared/constants';
import {
    createBuiltInHarness,
    type Harness,
    type HarnessUpdates,
    type NewHarnessFields,
} from '../../shared/harness';

export interface HarnessStateFile {
    version: number;
    harnesses: Harness[];
}

const HARNESS_STATE_VERSION = 1;

/**
 * The single writer for harness records.
 *
 * A harness never holds a credential — it is a launch description — but the
 * record still has to outlive its own removal, because a session's transcript
 * lives in the config directory the harness names and `--resume` only finds it
 * there. That is why archiving exists and deletion does not.
 */
export class HarnessService {
    private harnesses: Harness[] = [];
    private hadFileAtLoad = false;
    private readonly listeners = new Set<(harnesses: Harness[]) => void>();

    constructor(private readonly file: JsonStateFile<HarnessStateFile>) {}

    public load(): void {
        const stored = this.file.read();
        this.hadFileAtLoad = stored !== null;
        this.harnesses = stored ? this.withBuiltIn(stored.harnesses) : [createBuiltInHarness()];
    }

    public hasState(): boolean {
        return this.hadFileAtLoad;
    }

    public getAll(): Harness[] {
        return this.harnesses;
    }

    public importState(harnesses: Harness[]): boolean {
        if (this.hasState()) return false;
        this.harnesses = this.withBuiltIn(harnesses);
        this.hadFileAtLoad = true;
        this.commit();
        return true;
    }

    public addHarness(input: NewHarnessFields): Harness {
        const now = Date.now();
        const harness: Harness = {
            enabled: true,
            extraArgs: [],
            ...input,
            archived: false,
            isBuiltIn: false,
            createdAt: now,
            updatedAt: now,
        };
        this.harnesses = [...this.harnesses, harness];
        this.commit();
        return harness;
    }

    public updateHarness(id: string, updates: HarnessUpdates): void {
        this.harnesses = this.harnesses.map((harness) =>
            harness.id === id ? { ...harness, ...updates, updatedAt: Date.now() } : harness
        );
        this.commit();
    }

    /**
     * Take a harness out of circulation without stranding its sessions.
     *
     * The built-in is exempt: it is what every session falls back to, and a
     * session whose harness resolves to nothing cannot launch at all.
     */
    public archiveHarness(id: string): void {
        if (id === BUILT_IN_HARNESS_ID) return;
        this.setArchived(id, true);
    }

    public restoreHarness(id: string): void {
        this.setArchived(id, false);
    }

    public onChange(listener: (harnesses: Harness[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private setArchived(id: string, archived: boolean): void {
        this.harnesses = this.harnesses.map((harness) =>
            harness.id === id ? { ...harness, archived, updatedAt: Date.now() } : harness
        );
        this.commit();
    }

    /** The built-in is always present, however the stored list arrived. */
    private withBuiltIn(harnesses: Harness[]): Harness[] {
        return harnesses.some((harness) => harness.id === BUILT_IN_HARNESS_ID)
            ? harnesses
            : [createBuiltInHarness(), ...harnesses];
    }

    private commit(): void {
        this.file.write({ version: HARNESS_STATE_VERSION, harnesses: this.harnesses });
        for (const listener of this.listeners) listener(this.harnesses);
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- HarnessService`
Expected: PASS — 5 tests.

- [ ] **Step 6: Wire the channels, preload entry, and bridge**

Add to `src/shared/constants.ts`, after the workspace channels:

```typescript
    // Harness records (renderer -> main). Health probes stay on harness:probe.
    HARNESS_GET_SNAPSHOT: 'harness:get-snapshot',
    HARNESS_IMPORT: 'harness:import',
    HARNESS_ADD: 'harness:add',
    HARNESS_UPDATE: 'harness:update',
    HARNESS_ARCHIVE: 'harness:archive',
    HARNESS_RESTORE: 'harness:restore',

    // Harness records (main -> every renderer)
    HARNESS_CHANGED: 'harness:changed',
```

In `src/main/ipc-handlers.ts`, construct the service beside `WorkspaceService` and register:

```typescript
    const harnessFile = new JsonStateFile<HarnessStateFile>(
        path.join(app.getPath('userData'), 'harnesses.json')
    );
    const harnesses = new HarnessService(harnessFile);
    harnesses.load();

    harnesses.onChange((all) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(IPC_CHANNELS.HARNESS_CHANGED, all);
            }
        }
    });

    ipcMain.handle(IPC_CHANNELS.HARNESS_GET_SNAPSHOT, () => ({
        harnesses: harnesses.getAll(),
        needsImport: !harnesses.hasState(),
    }));

    ipcMain.handle(IPC_CHANNELS.HARNESS_IMPORT, (_event, incoming: Harness[]) =>
        harnesses.importState(incoming)
    );

    ipcMain.handle(IPC_CHANNELS.HARNESS_ADD, (_event, input: NewHarnessFields) =>
        harnesses.addHarness(input)
    );

    ipcMain.handle(IPC_CHANNELS.HARNESS_UPDATE, (_event, id: string, updates: HarnessUpdates) =>
        harnesses.updateHarness(id, updates)
    );

    ipcMain.handle(IPC_CHANNELS.HARNESS_ARCHIVE, (_event, id: string) => harnesses.archiveHarness(id));

    ipcMain.handle(IPC_CHANNELS.HARNESS_RESTORE, (_event, id: string) => harnesses.restoreHarness(id));
```

with `import { HarnessService, type HarnessStateFile } from './state/HarnessService';` and `import type { Harness, HarnessUpdates, NewHarnessFields } from '../shared/harness';`. Add `removeHandler` for all six in `cleanupIpcHandlers`.

In `src/preload/preload.ts`:

```typescript
contextBridge.exposeInMainWorld('harnessStateAPI', {
    getSnapshot: (): Promise<{ harnesses: Harness[]; needsImport: boolean }> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_GET_SNAPSHOT),

    importState: (harnesses: Harness[]): Promise<boolean> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_IMPORT, harnesses),

    addHarness: (input: NewHarnessFields): Promise<Harness> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_ADD, input),

    updateHarness: (id: string, updates: HarnessUpdates): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_UPDATE, id, updates),

    archiveHarness: (id: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_ARCHIVE, id),

    restoreHarness: (id: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.HARNESS_RESTORE, id),

    onChanged: (callback: (harnesses: Harness[]) => void) =>
        subscribe<Harness[]>(IPC_CHANNELS.HARNESS_CHANGED, callback),
});
```

Create `src/renderer/services/harnessBridgeState.ts`:

```typescript
import type { Harness, HarnessUpdates, NewHarnessFields } from '../../shared/harness';

/**
 * Bridge to the harness records owned by the main process.
 *
 * Separate from `harnessBridge`, which probes health: a probe result is a live
 * fact about the machine and is deliberately never persisted, so it has no
 * business travelling with the records.
 */
export const harnessBridgeState = {
    getSnapshot(): Promise<{ harnesses: Harness[]; needsImport: boolean }> {
        return window.harnessStateAPI.getSnapshot();
    },
    importState(harnesses: Harness[]): Promise<boolean> {
        return window.harnessStateAPI.importState(harnesses);
    },
    addHarness(input: NewHarnessFields): Promise<Harness> {
        return window.harnessStateAPI.addHarness(input);
    },
    updateHarness(id: string, updates: HarnessUpdates): Promise<void> {
        return window.harnessStateAPI.updateHarness(id, updates);
    },
    archiveHarness(id: string): Promise<void> {
        return window.harnessStateAPI.archiveHarness(id);
    },
    restoreHarness(id: string): Promise<void> {
        return window.harnessStateAPI.restoreHarness(id);
    },
    onChanged(callback: (harnesses: Harness[]) => void): () => void {
        return window.harnessStateAPI.onChanged(callback);
    },
};
```

Declare `harnessStateAPI` on the window type beside `workspaceAPI`.

- [ ] **Step 7: Convert `harnessStore.ts` to a read-through cache**

`statuses`, `probeHarness`, and `probeAll` are untouched — health was never persisted and does not move. Replace the four record actions with pass-throughs, drop the `persist` middleware, and add the hydration:

```typescript
export const useHarnessStore = create<HarnessState>()((set, get) => ({
    harnesses: [],
    statuses: {},

    addHarness: (input) => harnessBridgeState.addHarness(input),
    updateHarness: (id, updates) => harnessBridgeState.updateHarness(id, updates),
    archiveHarness: (id) => harnessBridgeState.archiveHarness(id),
    restoreHarness: (id) => harnessBridgeState.restoreHarness(id),

    getHarness: (id) => get().harnesses.find((harness) => harness.id === id),

    // getLaunchFields, probeHarness, and probeAll keep their existing bodies.
    // ...
}));

const LEGACY_HARNESS_KEY = 'consola-harnesses';

function readLegacyHarnesses(): Harness[] | null {
    const raw = localStorage.getItem(LEGACY_HARNESS_KEY);
    if (!raw) return null;
    try {
        const envelope = JSON.parse(raw) as { state?: { harnesses?: Harness[] } };
        return Array.isArray(envelope.state?.harnesses) ? envelope.state.harnesses : null;
    } catch {
        return null;
    }
}

export async function hydrateHarnessStore(): Promise<void> {
    let snapshot = await harnessBridgeState.getSnapshot();

    if (snapshot.needsImport) {
        const legacy = readLegacyHarnesses();
        if (legacy) {
            await harnessBridgeState.importState(legacy);
            snapshot = await harnessBridgeState.getSnapshot();
        }
    }

    useHarnessStore.setState({ harnesses: snapshot.harnesses });

    harnessBridgeState.onChanged((harnesses) => {
        useHarnessStore.setState({ harnesses });
    });
}
```

The four actions now return promises. Their call sites in `src/renderer/components/Harnesses/` are event handlers; add `await` where the handler continues afterwards and `void` where it does not.

Call it from `bootstrap()` in `main.tsx`:

```typescript
  await Promise.all([hydrateWorkspaceStore(), hydrateHarnessStore()]);
```

- [ ] **Step 8: Build, test, and check by hand**

Run: `npm run build && npm test`
Expected: PASS.

Run: `npm run dev`. Confirm every harness in Settings survived, `harnesses.json` exists in the Dev profile, and probing still reports versions and accounts.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: Give harness records the same single writer as workspaces"
```

---

# Phase 4 — Multi-window plumbing

## Task 8: `window-manager.ts` becomes a registry

**Files:**
- Modify: `src/main/window-manager.ts` (full rewrite)
- Modify: `src/main/index.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface WindowContext { workspaceId: string | null; activeSessionId: string | null }   // in shared/types.ts
  createWindow(context?: WindowContext): BrowserWindow
  findWindowForWorkspace(workspaceId: string): BrowserWindow | null
  getContextFor(window: BrowserWindow): WindowContext | undefined
  assignWorkspace(window: BrowserWindow, workspaceId: string | null): void
  setActiveSession(window: BrowserWindow, sessionId: string | null): void
  focusOrCreate(workspaceId: string): BrowserWindow
  getAnyWindow(): BrowserWindow | null
  listContexts(): Array<WindowContext & { bounds: Electron.Rectangle }>
  ```
  `getMainWindow` is deleted; `index.ts` is its only caller.

- [ ] **Step 1: Add the context type**

Append to `src/shared/types.ts`:

```typescript
/**
 * What a window is looking at.
 *
 * Injected at construction through `additionalArguments`, so the first paint
 * already knows its workspace and no frame is spent on an empty shell. Changes
 * afterwards arrive on WINDOW_WORKSPACE_CHANGED.
 */
export interface WindowContext {
    workspaceId: string | null;
    activeSessionId: string | null;
}

/** Verdict from asking main to point this window at a workspace. */
export type ActivateWorkspaceResult = 'took' | 'focused-elsewhere';
```

- [ ] **Step 2: Rewrite `window-manager.ts`**

```typescript
import { BrowserWindow } from 'electron';
import * as path from 'path';
import type { WindowContext } from '../shared/types';

/**
 * The open windows, and which workspace each one holds.
 *
 * A workspace lives in at most one window. That rule is enforced here rather
 * than in a renderer because two windows could otherwise claim the same
 * workspace in the same tick, and the loser would render a second live view of
 * a PTY that only expects one.
 */
const contexts = new Map<number, WindowContext>();

const EMPTY_CONTEXT: WindowContext = { workspaceId: null, activeSessionId: null };

export function createWindow(context: WindowContext = EMPTY_CONTEXT): BrowserWindow {
    const isDev = process.env.NODE_ENV === 'development';
    const isTest = process.env.NODE_ENV === 'test';

    const window = new BrowserWindow({
        title: 'Consola',
        width: 1000,
        height: 700,
        minWidth: 600,
        minHeight: 400,
        backgroundColor: '#0a0a0a',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 10, y: 10 },
        // A test run launches the app once per test and retries failures, so a
        // visible window means a dozen of them stealing focus. The renderer still
        // runs and Playwright still drives it over CDP; it is simply never mapped.
        show: !isTest,
        webPreferences: {
            preload: path.join(__dirname, '../../../dist/preload/preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            // Chromium throttles timers in a window it considers non-visible,
            // which would stretch the suite's waits into flakiness.
            backgroundThrottling: !isTest,
            // The renderer needs its workspace before the first paint, and an
            // IPC round trip would cost a frame of empty shell.
            additionalArguments: [`--consola-window=${JSON.stringify(context)}`],
        },
    });

    contexts.set(window.webContents.id, { ...context });

    if (isDev) {
        window.loadURL('http://localhost:5173');
        window.webContents.openDevTools();
    } else {
        window.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
    }

    window.on('closed', () => {
        // Only the view is forgotten. The PTYs this window was rendering keep
        // running, and reattach to whichever window opens the workspace next.
        contexts.delete(window.webContents.id);
    });

    return window;
}

export function getContextFor(window: BrowserWindow): WindowContext | undefined {
    return contexts.get(window.webContents.id);
}

export function findWindowForWorkspace(workspaceId: string): BrowserWindow | null {
    for (const window of BrowserWindow.getAllWindows()) {
        if (contexts.get(window.webContents.id)?.workspaceId === workspaceId) {
            return window;
        }
    }
    return null;
}

export function assignWorkspace(window: BrowserWindow, workspaceId: string | null): void {
    // Switching workspaces drops the session with it: an id from the old
    // workspace would name a session this window is no longer showing.
    contexts.set(window.webContents.id, { workspaceId, activeSessionId: null });
}

export function setActiveSession(window: BrowserWindow, sessionId: string | null): void {
    const existing = contexts.get(window.webContents.id);
    if (!existing) return;
    contexts.set(window.webContents.id, { ...existing, activeSessionId: sessionId });
}

/** Focus the window already holding a workspace, or open one for it. */
export function focusOrCreate(workspaceId: string): BrowserWindow {
    const existing = findWindowForWorkspace(workspaceId);
    if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return existing;
    }
    return createWindow({ workspaceId, activeSessionId: null });
}

export function getAnyWindow(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null;
}

/** Every open window's context and geometry, for restoring on next launch. */
export function listContexts(): Array<WindowContext & { bounds: Electron.Rectangle }> {
    return BrowserWindow.getAllWindows()
        .map((window) => {
            const context = contexts.get(window.webContents.id);
            return context ? { ...context, bounds: window.getBounds() } : null;
        })
        .filter((entry): entry is WindowContext & { bounds: Electron.Rectangle } => entry !== null);
}
```

- [ ] **Step 3: Re-scope teardown in `index.ts`**

Replace the `whenReady` block and the two lifecycle handlers:

```typescript
app.whenReady().then(() => {
    // The hidden test window still registers an app that bounces in the Dock and
    // takes focus on launch. Tests need neither.
    if (process.env.NODE_ENV === 'test') {
        app.dock?.hide();
    }

    // Handlers are registered once for the process, not once per window: they
    // are ipcMain-global, and a second registration throws.
    setupIpcHandlers();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // Deliberately does not tear anything down on macOS. Closing a window is
    // closing a view; the PTYs keep running and the dock icon reopens one.
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    cleanupIpcHandlers();
});
```

Update the imports: `import { BrowserWindow, app } from 'electron';` and `import { createWindow, getAnyWindow } from './window-manager';`. In the `second-instance` handler, replace `getMainWindow()` with `getAnyWindow()`.

- [ ] **Step 4: Make `setupIpcHandlers` window-free**

In `src/main/ipc-handlers.ts`, change the signature to `export function setupIpcHandlers(): void` and remove the `mainWindow` parameter from every use inside it.

`TerminalManager` is constructed there and currently takes a window, so its constructor has to change in this task too — otherwise this step does not compile. Give it the window list it will keep in Task 9, and let `send` reach all of them for now; there is still only ever one window until Task 10, so the interim behaviour is identical:

```typescript
    terminalManager = new TerminalManager(() => BrowserWindow.getAllWindows());
```

In `src/main/TerminalManager.ts`:

```typescript
import { BrowserWindow } from 'electron';
```

```typescript
    constructor(private readonly getWindows: () => BrowserWindow[]) {}
```

```typescript
    private send(channel: string, payload: unknown): void {
        for (const window of this.getWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(channel, payload);
            }
        }
    }
```

Task 9 splits that single `send` into the two routes the design calls for. Leaving it undivided here is deliberate: this task is about window lifecycle, and one window cannot tell the difference.

- [ ] **Step 5: Build and confirm one window still works**

Run: `npm run build && npm run dev`
Expected: the app launches, workspaces load, a session runs. Nothing about the UI has changed yet.

- [ ] **Step 6: Commit**

```bash
git add src/main/window-manager.ts src/main/index.ts src/main/ipc-handlers.ts src/shared/types.ts
git commit -m "refactor: Turn the window manager into a registry"
```

---

## Task 9: Route terminal events per channel, not per window

PTY bytes are heavy and mean nothing to a window that is not rendering the pane. Status flags are three booleans and are the whole reason another window can tell you a workspace needs attention. They route differently.

**Files:**
- Modify: `src/main/TerminalManager.ts`
- Modify: `src/main/ipc-handlers.ts` (pass `event.sender` into `ensure`)

**Interfaces:**
- Consumes: nothing new
- Produces: `new TerminalManager(getWindows: () => BrowserWindow[])`; `ensure(instanceId: string, options: TerminalServiceOptions, owner: WebContents): { replay: string; exited: boolean }`

**No unit test.** `TerminalService` spawns a real PTY on construction, so exercising this in Vitest would mean mocking node-pty deeply enough that the test proves nothing about routing. It is covered by the E2E in Task 15 instead — the "close a window, reopen, the PTY never restarted" case is exactly this code path.

- [ ] **Step 1: Add per-instance ownership**

Task 8 left this class broadcasting everything to every window. Change the import and the top of the class so it can also address one:

```typescript
import { BrowserWindow, WebContents } from 'electron';
import { TerminalService, TerminalExitInfo, TerminalServiceOptions } from './TerminalService';
import { IPC_CHANNELS } from '../shared/constants';

/**
 * Owns one TerminalService per session tab and forwards its events.
 *
 * Terminals are kept alive for every open session, not just the visible one, so
 * background work keeps running and switching tabs is instant. A window is a
 * view over that: closing one orphans its terminals without stopping them, and
 * the next window to open the workspace reattaches and repaints from the
 * replay buffer.
 */
export class TerminalManager {
    private readonly terminals = new Map<string, TerminalService>();
    /** Where this instance's output goes. Reassigned on every reattach. */
    private readonly owners = new Map<string, WebContents>();

    constructor(private readonly getWindows: () => BrowserWindow[]) {}
```

- [ ] **Step 2: Take ownership in `ensure`**

```typescript
    public ensure(
        instanceId: string,
        options: TerminalServiceOptions,
        owner: WebContents
    ): { replay: string; exited: boolean } {
        // Set before starting: a terminal that emits during start() would
        // otherwise have nowhere to send its first bytes.
        this.owners.set(instanceId, owner);

        let terminal = this.terminals.get(instanceId);

        if (!terminal) {
            terminal = new TerminalService(options);
            this.terminals.set(instanceId, terminal);
            this.wireEvents(instanceId, terminal);
            terminal.start();
        } else if (options.initialPrompt) {
            // Terminal already running — queue the prompt rather than dropping it.
            terminal.queuePrompt(options.initialPrompt);
        }

        return {
            replay: terminal.getReplayBuffer(),
            exited: terminal.hasClaudeExited(),
        };
    }
```

In `destroy`, add `this.owners.delete(instanceId);` after `this.terminals.delete(instanceId);`.

- [ ] **Step 3: Split the two send paths**

Replace the interim `send` from Task 8, and `wireEvents`:

```typescript
    /** Output goes only to the window rendering this pane. */
    private sendToOwner(instanceId: string, channel: string, payload: unknown): void {
        const owner = this.owners.get(instanceId);
        if (owner && !owner.isDestroyed()) {
            owner.send(channel, payload);
        }
    }

    /**
     * Status goes to every window.
     *
     * A window scoped to one workspace still has to show that a session in
     * another one is waiting on a keypress, and these three flags are the only
     * way it can know. They are small enough that broadcasting costs nothing.
     */
    private broadcast(channel: string, payload: unknown): void {
        for (const window of this.getWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(channel, payload);
            }
        }
    }

    private wireEvents(instanceId: string, terminal: TerminalService): void {
        terminal.on('data', (data: string) => {
            this.sendToOwner(instanceId, IPC_CHANNELS.TERMINAL_DATA, { instanceId, data });
        });

        terminal.on('activity', (busy: boolean) => {
            this.broadcast(IPC_CHANNELS.TERMINAL_ACTIVITY, { instanceId, busy });
        });

        terminal.on('awaiting-confirmation', (awaiting: boolean) => {
            this.broadcast(IPC_CHANNELS.TERMINAL_AWAITING_CONFIRMATION, { instanceId, awaiting });
        });

        terminal.on('exit', (info: TerminalExitInfo) => {
            this.broadcast(IPC_CHANNELS.TERMINAL_EXIT, { instanceId, ...info });
        });
    }
```

- [ ] **Step 4: Pass the sender through**

In `src/main/ipc-handlers.ts`, the `TERMINAL_CREATE` handler stops ignoring its event:

```typescript
    ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, (event, options: TerminalCreateOptions) => {
```

and its `manager.ensure(instanceId, { ... })` call gains a third argument:

```typescript
        }, event.sender);
```

- [ ] **Step 5: Build and check a session still renders**

Run: `npm run build && npm run dev`
Expected: sessions start, output paints, the sidebar activity dot still lights up.

- [ ] **Step 6: Commit**

```bash
git add src/main/TerminalManager.ts src/main/ipc-handlers.ts
git commit -m "feat: Send PTY output to its pane and status to every window"
```

---

## Task 10: Window identity in the renderer

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/preload.ts`
- Create: `src/renderer/services/windowBridge.ts`
- Modify: `src/renderer/stores/navigationStore.ts`
- Modify: `src/renderer/hooks/useKeyboardShortcuts.ts`
- Modify: `src/renderer/components/Layout/index.tsx`

**Interfaces:**
- Consumes: `findWindowForWorkspace`, `assignWorkspace`, `setActiveSession`, `focusOrCreate`, `createWindow` (Task 8)
- Produces: `windowBridge` with `context: WindowContext`, `activateWorkspace(id: string | null): Promise<ActivateWorkspaceResult>`, `openWindow(workspaceId: string | null): Promise<void>`, `setActiveSession(sessionId: string | null): void`, `onWorkspaceChanged(cb: (workspaceId: string | null) => void): () => void`. `useNavigationStore.setActiveWorkspace` becomes `(id: string | null) => Promise<void>`.

- [ ] **Step 1: Add the channels**

In `src/shared/constants.ts`:

```typescript
    // Window identity (renderer -> main)
    WINDOW_ACTIVATE_WORKSPACE: 'window:activate-workspace', // Claim a workspace, or be told who holds it
    WINDOW_OPEN: 'window:open',                             // Open another window
    WINDOW_SET_ACTIVE_SESSION: 'window:set-active-session',  // Remember it for relaunch

    // Window identity (main -> one renderer)
    WINDOW_WORKSPACE_CHANGED: 'window:workspace-changed',
```

- [ ] **Step 2: Arbitrate in main**

In `src/main/ipc-handlers.ts`, import from the window manager:

```typescript
import {
    assignWorkspace,
    createWindow,
    findWindowForWorkspace,
    focusOrCreate,
    getContextFor,
    setActiveSession,
} from './window-manager';
import type { ActivateWorkspaceResult } from '../shared/types';
```

Register:

```typescript
    // A workspace lives in at most one window, and main is the only thing that
    // can say so without two renderers racing to claim it in the same tick.
    ipcMain.handle(
        IPC_CHANNELS.WINDOW_ACTIVATE_WORKSPACE,
        (event, workspaceId: string | null): ActivateWorkspaceResult => {
            const requesting = BrowserWindow.fromWebContents(event.sender);
            if (!requesting) return 'focused-elsewhere';

            if (workspaceId === null) {
                assignWorkspace(requesting, null);
                return 'took';
            }

            const holder = findWindowForWorkspace(workspaceId);
            if (holder && holder !== requesting) {
                if (holder.isMinimized()) holder.restore();
                holder.focus();
                return 'focused-elsewhere';
            }

            assignWorkspace(requesting, workspaceId);
            return 'took';
        }
    );

    ipcMain.handle(IPC_CHANNELS.WINDOW_OPEN, (_event, workspaceId: string | null) => {
        if (workspaceId) {
            focusOrCreate(workspaceId);
        } else {
            createWindow();
        }
    });

    ipcMain.on(IPC_CHANNELS.WINDOW_SET_ACTIVE_SESSION, (event, sessionId: string | null) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window) setActiveSession(window, sessionId);
    });
```

Extend the `workspaces.onChange` listener registered in Task 4 so a deleted workspace never leaves a window pointing at a dead id:

```typescript
    workspaces.onChange((all) => {
        const liveIds = new Set(all.map((workspace) => workspace.id));

        for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) continue;
            window.webContents.send(IPC_CHANNELS.WORKSPACE_CHANGED, all);

            const held = getContextFor(window)?.workspaceId;
            if (held && !liveIds.has(held)) {
                assignWorkspace(window, null);
                window.webContents.send(IPC_CHANNELS.WINDOW_WORKSPACE_CHANGED, null);
            }
        }
    });
```

Add the three new channels to `cleanupIpcHandlers` (`removeHandler` for the two `handle`s, `removeAllListeners` for `WINDOW_SET_ACTIVE_SESSION`).

- [ ] **Step 3: Read the context in preload**

In `src/preload/preload.ts`:

```typescript
/**
 * The workspace this window opened on.
 *
 * Passed as a launch argument rather than fetched, so the renderer's very first
 * render already knows what it is looking at.
 */
function readWindowContext(): WindowContext {
    const prefix = '--consola-window=';
    const arg = process.argv.find((value) => value.startsWith(prefix));
    if (!arg) return { workspaceId: null, activeSessionId: null };
    try {
        return JSON.parse(arg.slice(prefix.length)) as WindowContext;
    } catch {
        return { workspaceId: null, activeSessionId: null };
    }
}

contextBridge.exposeInMainWorld('windowAPI', {
    context: readWindowContext(),

    activateWorkspace: (workspaceId: string | null): Promise<ActivateWorkspaceResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.WINDOW_ACTIVATE_WORKSPACE, workspaceId),

    openWindow: (workspaceId: string | null): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WINDOW_OPEN, workspaceId),

    setActiveSession: (sessionId: string | null): void => {
        ipcRenderer.send(IPC_CHANNELS.WINDOW_SET_ACTIVE_SESSION, sessionId);
    },

    onWorkspaceChanged: (callback: (workspaceId: string | null) => void) =>
        subscribe<string | null>(IPC_CHANNELS.WINDOW_WORKSPACE_CHANGED, callback),
});
```

Add `WindowContext` and `ActivateWorkspaceResult` to the `../shared/types` import, and declare `windowAPI` on the window type alongside `workspaceAPI`.

- [ ] **Step 4: Add the bridge**

Create `src/renderer/services/windowBridge.ts`:

```typescript
import type { ActivateWorkspaceResult, WindowContext } from '../../shared/types';

/**
 * Bridge to this window's identity.
 *
 * `context` is the value this window opened with and never changes; switching
 * goes through `activateWorkspace`, whose verdict decides whether this window
 * took the workspace or another one already had it.
 */
export const windowBridge = {
    get context(): WindowContext {
        return window.windowAPI.context;
    },

    activateWorkspace(workspaceId: string | null): Promise<ActivateWorkspaceResult> {
        return window.windowAPI.activateWorkspace(workspaceId);
    },

    openWindow(workspaceId: string | null): Promise<void> {
        return window.windowAPI.openWindow(workspaceId);
    },

    /** Remembered by main so a relaunch reopens on the same session. */
    setActiveSession(sessionId: string | null): void {
        window.windowAPI.setActiveSession(sessionId);
    },

    onWorkspaceChanged(callback: (workspaceId: string | null) => void): () => void {
        return window.windowAPI.onWorkspaceChanged(callback);
    },
};
```

- [ ] **Step 5: Split `navigationStore`**

Replace `src/renderer/stores/navigationStore.ts`:

```typescript
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { windowBridge } from '../services/windowBridge';

/**
 * What this window is showing, and how it is laid out.
 *
 * The two are persisted differently on purpose. Sidebar and explorer
 * visibility are preferences and are shared by every window, where a
 * last-writer-wins race is harmless. Which workspace and session a window holds
 * is that window's identity: it arrives from main at construction and is
 * remembered by main, because localStorage is shared and two windows writing
 * their own identity into one key would each read the other's.
 */
interface NavigationState {
  isSidebarHidden: boolean;
  isExplorerVisible: boolean;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
  toggleExplorer: () => void;
  setExplorerVisible: (visible: boolean) => void;
  /** Ask main for the workspace. Resolves once the verdict is known. */
  setActiveWorkspace: (id: string | null) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  // Read only by WorkspaceNavItem, which Task 12 deletes along with these.
  expandedWorkspaces: Record<string, boolean>;
  toggleWorkspaceExpanded: (workspaceId: string) => void;
  setWorkspaceExpanded: (workspaceId: string, expanded: boolean) => void;
  isWorkspaceExpanded: (workspaceId: string) => boolean;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      isSidebarHidden: false,
      isExplorerVisible: false,
      activeWorkspaceId: windowBridge.context.workspaceId,
      activeSessionId: windowBridge.context.activeSessionId,
      expandedWorkspaces: {},

      toggleSidebar: () => set((state) => ({ isSidebarHidden: !state.isSidebarHidden })),
      setSidebarHidden: (hidden) => set({ isSidebarHidden: hidden }),
      toggleExplorer: () => set((state) => ({ isExplorerVisible: !state.isExplorerVisible })),
      setExplorerVisible: (visible) => set({ isExplorerVisible: visible }),

      setActiveWorkspace: async (id) => {
        const verdict = await windowBridge.activateWorkspace(id);
        // 'focused-elsewhere' means another window already holds it and has
        // been brought forward. This window keeps showing what it was showing.
        if (verdict === 'took') {
          set({ activeWorkspaceId: id, activeSessionId: null });
          windowBridge.setActiveSession(null);
        }
      },

      setActiveSession: (id) => {
        set({ activeSessionId: id });
        windowBridge.setActiveSession(id);
      },

      toggleWorkspaceExpanded: (workspaceId) =>
        set((state) => ({
          expandedWorkspaces: {
            ...state.expandedWorkspaces,
            [workspaceId]: !get().isWorkspaceExpanded(workspaceId),
          },
        })),
      setWorkspaceExpanded: (workspaceId, expanded) =>
        set((state) => ({
          expandedWorkspaces: { ...state.expandedWorkspaces, [workspaceId]: expanded },
        })),
      isWorkspaceExpanded: (workspaceId) => get().expandedWorkspaces[workspaceId] ?? true,
    }),
    {
      name: 'consola-navigation',
      storage: createJSONStorage(() => localStorage),
      // Identity is deliberately absent: it belongs to the window, not the app.
      // expandedWorkspaces is absent too — it is about to stop existing.
      partialize: (state) => ({
        isSidebarHidden: state.isSidebarHidden,
        isExplorerVisible: state.isExplorerVisible,
      }),
    }
  )
);

/** React to main dropping this window's workspace, e.g. after a delete. */
export function subscribeToWindowWorkspace(): () => void {
  return windowBridge.onWorkspaceChanged((workspaceId) => {
    useNavigationStore.setState({ activeWorkspaceId: workspaceId, activeSessionId: null });
  });
}
```

`activateSession` in `sessionActions.ts` sets both fields at once and must keep doing so, but now also has to tell main. Replace it:

```typescript
export function activateSession(workspaceId: string, sessionId: string): void {
  useNavigationStore.setState({
    activeWorkspaceId: workspaceId,
    activeSessionId: sessionId,
  });
  windowBridge.setActiveSession(sessionId);
}
```

Add `import { windowBridge } from '../services/windowBridge';` to that file.

`openNewSessionComposer` calls `setActiveWorkspace`, which is now async — change it to `export function openNewSessionComposer(workspaceId: string): Promise<void>` returning the call.

- [ ] **Step 6: Subscribe, and add the new-window shortcut**

In `src/renderer/components/Layout/index.tsx`, add beside the terminal subscription:

```typescript
  useEffect(() => subscribeToWindowWorkspace(), []);
```

In `src/renderer/hooks/useKeyboardShortcuts.ts`, add before the `⌘N` branch — order matters, because `⌘⇧N` also satisfies the `⌘N` test:

```typescript
      // Cmd/Ctrl + Shift + N : Open another window
      if (isMod && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void windowBridge.openWindow(null);
        return;
      }
```

with `import { windowBridge } from '../services/windowBridge';` at the top.

- [ ] **Step 7: Prove two windows work**

Run: `npm run build && npm run dev`

Check:
1. `⌘⇧N` opens a second window showing HomeView.
2. Creating a workspace in one window makes it appear in the other's sidebar without a reload.
3. Selecting a workspace already open in the first window brings that window forward instead of duplicating it.
4. Starting a session in window A does not paint into window B.
5. A session busy in window A still lights its activity dot in window B's sidebar.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: Give each window its own workspace, arbitrated by main"
```

---

# Phase 5 — Renderer shape

## Task 11: The top-bar switcher

**Files:**
- Create: `src/renderer/utils/sessionStatus.ts`
- Create: `src/renderer/utils/sessionStatus.test.ts`
- Create: `src/renderer/components/Layout/WorkspaceSwitcher.tsx`
- Modify: `src/renderer/components/Layout/AppHeader.tsx`
- Modify: `src/renderer/components/Layout/styles.css`
- Modify: `src/renderer/components/Sidebar/SessionNavItem.tsx` (use the shared status helper)

**Interfaces:**
- Consumes: `useWorkspaceStore`, `useTerminalStore`, `useNavigationStore`, `windowBridge`, `useHarnessStore`
- Produces:
  ```typescript
  type SessionStatus = 'error' | 'attention' | 'running' | null;
  sessionStatusFor(terminal: TerminalState | undefined): SessionStatus
  workspaceStatusFor(workspace: Workspace, terminals: Record<string, TerminalState>): SessionStatus
  anyOtherWorkspaceNeedsAttention(workspaces: Workspace[], activeWorkspaceId: string | null, terminals: Record<string, TerminalState>): boolean
  <WorkspaceSwitcher />
  ```

- [ ] **Step 1: Write the failing test for the status helpers**

Create `src/renderer/utils/sessionStatus.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  anyOtherWorkspaceNeedsAttention,
  sessionStatusFor,
  workspaceStatusFor,
} from './sessionStatus';
import type { Workspace } from '../../shared/workspace';

function workspace(id: string, instanceIds: string[]): Workspace {
  return {
    id,
    name: id,
    path: `/code/${id}`,
    isGitRepo: true,
    defaultHarnessId: 'default',
    createdAt: 1,
    updatedAt: 1,
    sessions: instanceIds.map((instanceId, index) => ({
      id: `${id}-s${index}`,
      name: `Session ${index}`,
      workspaceId: id,
      instanceId,
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      hasStarted: true,
      harnessId: 'default',
      createdAt: 1,
      lastActiveAt: 1,
    })),
  };
}

const IDLE = { isBusy: false, isAwaitingConfirmation: false, hasExited: false };

describe('sessionStatusFor', () => {
  it('is null for a terminal that has not started', () => {
    expect(sessionStatusFor(undefined)).toBeNull();
  });

  it('ranks an exit above a waiting menu, and a waiting menu above work', () => {
    expect(sessionStatusFor({ ...IDLE, hasExited: true, isAwaitingConfirmation: true })).toBe('error');
    expect(sessionStatusFor({ ...IDLE, isAwaitingConfirmation: true, isBusy: true })).toBe('attention');
    expect(sessionStatusFor({ ...IDLE, isBusy: true })).toBe('running');
    expect(sessionStatusFor(IDLE)).toBeNull();
  });
});

describe('workspaceStatusFor', () => {
  it('surfaces the most urgent status among its sessions', () => {
    const terminals = {
      a: { ...IDLE, isBusy: true },
      b: { ...IDLE, isAwaitingConfirmation: true },
    };

    expect(workspaceStatusFor(workspace('w1', ['a', 'b']), terminals)).toBe('attention');
  });

  it('is null when nothing is happening', () => {
    expect(workspaceStatusFor(workspace('w1', ['a']), { a: IDLE })).toBeNull();
  });
});

describe('anyOtherWorkspaceNeedsAttention', () => {
  it('ignores the workspace this window is already showing', () => {
    const workspaces = [workspace('w1', ['a']), workspace('w2', ['b'])];
    const terminals = { a: { ...IDLE, isAwaitingConfirmation: true }, b: IDLE };

    expect(anyOtherWorkspaceNeedsAttention(workspaces, 'w1', terminals)).toBe(false);
    expect(anyOtherWorkspaceNeedsAttention(workspaces, 'w2', terminals)).toBe(true);
  });

  it('does not count work in progress as needing you', () => {
    const workspaces = [workspace('w1', ['a'])];
    const terminals = { a: { ...IDLE, isBusy: true } };

    expect(anyOtherWorkspaceNeedsAttention(workspaces, null, terminals)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- sessionStatus`
Expected: FAIL — `Failed to resolve import "./sessionStatus"`.

- [ ] **Step 3: Implement the helpers**

Create `src/renderer/utils/sessionStatus.ts`:

```typescript
import type { TerminalState } from '../stores/terminalStore';
import type { Workspace } from '../../shared/workspace';

/**
 * What a session's dot shows.
 *
 * Activity is inferred from terminal output, so the only states Consola can
 * distinguish are "the process is gone", "a menu is waiting on a keypress",
 * and "output is flowing".
 */
export type SessionStatus = 'error' | 'attention' | 'running' | null;

export function sessionStatusFor(terminal: TerminalState | undefined): SessionStatus {
  if (!terminal) return null;
  if (terminal.hasExited) return 'error';
  if (terminal.isAwaitingConfirmation) return 'attention';
  if (terminal.isBusy) return 'running';
  return null;
}

const RANK: Record<Exclude<SessionStatus, null>, number> = {
  error: 3,
  attention: 2,
  running: 1,
};

/** The most urgent status among a workspace's sessions. */
export function workspaceStatusFor(
  workspace: Workspace,
  terminals: Record<string, TerminalState>
): SessionStatus {
  let worst: SessionStatus = null;

  for (const session of workspace.sessions) {
    const status = sessionStatusFor(terminals[session.instanceId]);
    if (status && (!worst || RANK[status] > RANK[worst])) {
      worst = status;
    }
  }

  return worst;
}

/**
 * Whether a workspace this window is not showing wants a human.
 *
 * Deliberately excludes `running`: a session doing work is not a reason to
 * pull someone out of another project. Only a waiting menu or a dead process
 * is.
 */
export function anyOtherWorkspaceNeedsAttention(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  terminals: Record<string, TerminalState>
): boolean {
  return workspaces.some((workspace) => {
    if (workspace.id === activeWorkspaceId) return false;
    const status = workspaceStatusFor(workspace, terminals);
    return status === 'attention' || status === 'error';
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- sessionStatus`
Expected: PASS — 6 tests.

- [ ] **Step 5: Use the helper in `SessionNavItem`**

Replace the inline `sessionStatus` selector in `src/renderer/components/Sidebar/SessionNavItem.tsx` with:

```typescript
  const sessionStatus = useTerminalStore((state) =>
    sessionStatusFor(state.terminals[session.instanceId])
  );
```

and import it: `import { sessionStatusFor } from '../../utils/sessionStatus';`. The comment block above the old selector moves to the helper, where it now belongs.

- [ ] **Step 6: Build the switcher**

Create `src/renderer/components/Layout/WorkspaceSwitcher.tsx`:

```typescript
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  Plus,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { dialogBridge } from '../../services/dialogBridge';
import { windowBridge } from '../../services/windowBridge';
import { anyOtherWorkspaceNeedsAttention, workspaceStatusFor } from '../../utils/sessionStatus';

/**
 * The workspace this window holds, and the way to change it.
 *
 * It carries the one signal the sidebar used to own: that a session in a
 * workspace you are not looking at is waiting on you. Without the dot, scoping
 * a window to one workspace would make that invisible until you went looking.
 */
export function WorkspaceSwitcher() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const setActiveWorkspace = useNavigationStore((state) => state.setActiveWorkspace);
  const terminals = useTerminalStore((state) => state.terminals);
  const harnesses = useHarnessStore((state) => state.harnesses);
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace);

  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const elsewhere = anyOtherWorkspaceNeedsAttention(workspaces, activeWorkspaceId, terminals);
  const selectableHarnesses = harnesses.filter(isSelectableHarness);

  const handleAddWorkspace = async () => {
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    const workspace = await useWorkspaceStore
      .getState()
      .createWorkspace(folder.name, folder.path, folder.isGitRepo);
    await setActiveWorkspace(workspace.id);
  };

  const handleDelete = async () => {
    if (!active) return;
    if (!window.confirm(`Are you sure you want to delete "${active.name}"?`)) return;
    // Main drops this window's workspace when the record disappears, so there
    // is nothing to clear here.
    await deleteWorkspace(active.id);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="workspace-switcher" aria-label="Switch workspace">
          <span className="workspace-switcher-icon">
            {active?.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
          </span>
          <span className="workspace-switcher-name">{active?.name ?? 'Select workspace'}</span>
          {elsewhere && (
            <span
              className="workspace-switcher-elsewhere"
              aria-label="Another workspace needs attention"
            />
          )}
          <ChevronDown size={14} className="workspace-switcher-chevron" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content" sideOffset={6} align="start">
          {workspaces.map((workspace) => {
            const status = workspaceStatusFor(workspace, terminals);
            return (
              <DropdownMenu.Item
                key={workspace.id}
                className="dropdown-item"
                onSelect={() => void setActiveWorkspace(workspace.id)}
              >
                <span className="workspace-switcher-item-icon">
                  {workspace.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
                </span>
                <span className="workspace-switcher-item-name">{workspace.name}</span>
                {status && (
                  <span className={`session-status-indicator session-status-indicator--${status}`} />
                )}
                <span className="workspace-switcher-item-count">{workspace.sessions.length}</span>
                {workspace.id === activeWorkspaceId && <Check size={14} />}
              </DropdownMenu.Item>
            );
          })}

          {workspaces.length > 0 && <DropdownMenu.Separator className="dropdown-separator" />}

          {active && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() => void windowBridge.openWindow(null)}
            >
              <SquareArrowOutUpRight size={14} />
              <span>Open new window</span>
            </DropdownMenu.Item>
          )}

          <DropdownMenu.Item className="dropdown-item" onSelect={() => void handleAddWorkspace()}>
            <Plus size={14} />
            <span>Add workspace…</span>
          </DropdownMenu.Item>

          {active && selectableHarnesses.length > 1 && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="dropdown-item">
                <Boxes size={14} />
                <span>Default harness</span>
                <ChevronRight size={14} style={{ marginLeft: 'auto' }} />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="dropdown-content" sideOffset={4}>
                  {selectableHarnesses.map((harness) => (
                    <DropdownMenu.Item
                      key={harness.id}
                      className="dropdown-item"
                      onSelect={() =>
                        void updateWorkspace(active.id, { defaultHarnessId: harness.id })
                      }
                    >
                      <span
                        className="workspace-harness-dot"
                        style={{ background: harness.accentColor }}
                      />
                      <span>{harness.name}</span>
                      {harness.id === active.defaultHarnessId && (
                        <Check size={14} style={{ marginLeft: 'auto' }} />
                      )}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}

          {active && (
            <DropdownMenu.Item
              className="dropdown-item dropdown-item-destructive"
              onSelect={() => void handleDelete()}
            >
              <Trash2 size={14} />
              <span>Delete workspace</span>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
```

- [ ] **Step 7: Render it in the header**

Replace `src/renderer/components/Layout/AppHeader.tsx`:

```typescript
import { useNavigationStore } from '../../stores/navigationStore';
import { SidebarToggle } from '../Sidebar/SidebarToggle';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

export function AppHeader() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);

  return (
    <header className="app-header">
      <div className="app-header-drag-region" />
      <div className={`app-header-sidebar ${isSidebarHidden ? 'hidden' : ''}`}>
        <SidebarToggle />
      </div>
      <div className={`app-header-content ${isSidebarHidden ? 'sidebar-hidden' : ''}`}>
        <WorkspaceSwitcher />
      </div>
    </header>
  );
}
```

- [ ] **Step 8: Style it**

Append to `src/renderer/components/Layout/styles.css`:

```css
/* Workspace switcher */
.workspace-switcher {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 100%;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-2);
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-1);
  font-weight: 500;
  cursor: pointer;
  /* The header is a drag region; the button has to opt back out of it. */
  -webkit-app-region: no-drag;
}

.workspace-switcher:hover {
  background: var(--color-bg-hover);
}

.workspace-switcher-icon {
  display: flex;
  color: var(--color-text-secondary);
}

.workspace-switcher-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The one signal the sidebar tree used to carry: something elsewhere wants you. */
.workspace-switcher-elsewhere {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-status-attention, #f59e0b);
}

.workspace-switcher-chevron {
  color: var(--color-text-tertiary);
}

.workspace-switcher-item-icon {
  display: flex;
  color: var(--color-text-secondary);
}

.workspace-switcher-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-switcher-item-count {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-1);
  font-variant-numeric: tabular-nums;
}
```

If `--color-status-attention` is not defined in `src/renderer/styles/themes/`, find the variable `session-status-indicator--attention` uses in `Sidebar/styles.css` and use that instead, so the two dots cannot drift apart.

- [ ] **Step 9: Build and look at it**

Run: `npm run build && npm run dev`
Expected: the header shows the active workspace; the dropdown lists all of them with dots and session counts; picking one already open in another window brings that window forward.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: Put the workspace picker in the top bar"
```

---

## Task 12: Flatten the sidebar

**Files:**
- Modify: `src/renderer/components/Sidebar/index.tsx`
- Modify: `src/renderer/components/Sidebar/styles.css`
- Modify: `src/renderer/components/Sidebar/SessionNavItem.tsx`
- Delete: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`
- Delete: `src/renderer/components/Sidebar/WorkspaceActionsMenu.tsx`

**Interfaces:**
- Consumes: `createQuickSession`, `activateSession` (Task 6), `useNavigationStore` (Task 10)
- Produces: nothing new

- [ ] **Step 1: Rewrite the sidebar**

Replace `src/renderer/components/Sidebar/index.tsx`:

```typescript
import { Plus, Settings } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useSettings } from '../../contexts/SettingsContext';
import { SessionNavItem } from './SessionNavItem';
import { activateSession, createQuickSession } from '../../utils/sessionActions';
import './styles.css';

/**
 * The sessions of the workspace this window holds.
 *
 * Flat on purpose: a window shows one workspace, so there is nothing left to
 * nest under. Which workspace that is lives in the top bar.
 */
export function Sidebar() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const { openSettings } = useSettings();

  if (isSidebarHidden) {
    return null;
  }

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;
  // Sessions appear once Claude has named them, so an unnamed one is a session
  // whose first turn has not landed yet.
  const sessions = workspace?.sessions.filter((session) => session.name.length > 0) ?? [];

  const newSessionButton = (
    <button
      className="sidebar-section-button"
      onClick={() => workspace && void createQuickSession(workspace.id)}
      disabled={!workspace}
    >
      <Plus size={14} />
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">Sessions</span>
          <Tooltip.Provider delayDuration={200}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>{newSessionButton}</Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
                  New Session
                  <span className="tooltip-shortcut">⌘N</span>
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
        <nav className="session-list">
          {workspace &&
            sessions.map((session) => (
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

- [ ] **Step 2: Drop the indent from the session item**

In `src/renderer/components/Sidebar/SessionNavItem.tsx`, change the root class:

```typescript
      className={`session-nav-item ${isActive ? 'active' : ''}`}
```

- [ ] **Step 3: Delete what the tree needed**

```bash
git rm src/renderer/components/Sidebar/WorkspaceNavItem.tsx src/renderer/components/Sidebar/WorkspaceActionsMenu.tsx
```

`WorkspaceNavItem` was the last reader of the collapsible state Task 10 kept alive for it. Delete from `src/renderer/stores/navigationStore.ts`: the `expandedWorkspaces` field, `toggleWorkspaceExpanded`, `setWorkspaceExpanded`, and `isWorkspaceExpanded`, along with their four lines in the `NavigationState` interface. Change `(set, get) =>` back to `(set) =>` once `get` is unused.

In `src/renderer/components/Sidebar/styles.css`, delete the rules for `.workspace-nav-item-container`, `.workspace-nav-item`, `.workspace-expand-toggle`, `.workspace-collapsible-content`, `.workspace-sessions-list`, `.workspace-add-session`, `.workspace-actions-trigger`, `.workspace-list`, and `.session-nav-item--indent-1`. Keep `.workspace-harness-dot` — the switcher's harness submenu still uses it. Add `.session-list` with the rules `.workspace-sessions-list` had.

- [ ] **Step 4: Build and check for orphans**

Run: `npm run build`
Expected: PASS. Then confirm nothing still references the deleted files:

```bash
grep -rn "WorkspaceNavItem\|WorkspaceActionsMenu\|indent-1" src/
```

Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: Flatten the sidebar to the sessions of one workspace"
```

---

## Task 13: Home, and the palette's workspace door

**Files:**
- Modify: `src/renderer/components/Views/HomeView.tsx`
- Modify: `src/renderer/components/CommandPalette/buildItems.ts`

**Interfaces:**
- Consumes: `windowBridge` (Task 10), `workspaceStatusFor` (Task 11)
- Produces: `WorkspacePaletteItem` gains `status: SessionStatus`

- [ ] **Step 1: Fix the Home copy**

In `src/renderer/components/Views/HomeView.tsx`, the description no longer points at a sidebar that does not list workspaces:

```typescript
        <p className="home-view-description">
          {workspaces.length === 0
            ? 'Create your first workspace to get started'
            : 'Pick a workspace from the top bar, or create a new one'}
        </p>
```

- [ ] **Step 2: Route palette selection through the window arbiter**

Every palette path that selects a workspace or a session must go through the same arbitration the switcher uses, or the palette becomes a way to put one workspace in two windows.

In `src/renderer/components/CommandPalette/buildItems.ts`, `buildWorkspaceItems` gains the status the dropdown shows:

```typescript
export function buildWorkspaceItems(
  workspaces: Workspace[],
  terminals: Record<string, TerminalState>
): WorkspacePaletteItem[] {
  return workspaces.map((workspace) => ({
    kind: 'workspace',
    section: 'workspaces',
    id: `workspace:${workspace.id}`,
    label: workspace.name,
    context: workspace.path,
    workspaceId: workspace.id,
    isGitRepo: workspace.isGitRepo,
    status: workspaceStatusFor(workspace, terminals),
  }));
}
```

Add `status: SessionStatus` to `WorkspacePaletteItem` in `types.ts`, thread `terminals` in from `usePaletteResults.ts` where the other context fields are gathered, and render the dot in `CommandPaletteRow.tsx` using the same `session-status-indicator` classes the sidebar and switcher use.

- [ ] **Step 3: Make session activation cross-window**

`activateSession` sets this window's state directly, which is wrong when the session belongs to a workspace another window holds. In `src/renderer/utils/sessionActions.ts`:

```typescript
/**
 * Select a session, whichever workspace it belongs to.
 *
 * Goes through main when the workspace is not this window's, because that
 * workspace may already be open somewhere else — in which case the right
 * outcome is bringing that window forward, not opening a second view of it.
 */
export async function activateSessionAnywhere(
  workspaceId: string,
  sessionId: string
): Promise<void> {
  const current = useNavigationStore.getState().activeWorkspaceId;

  if (current === workspaceId) {
    activateSession(workspaceId, sessionId);
    return;
  }

  const verdict = await windowBridge.activateWorkspace(workspaceId);
  if (verdict === 'took') {
    activateSession(workspaceId, sessionId);
  }
}
```

Keep `activateSession` as-is for the same-workspace case — the sidebar calls it and must stay synchronous. Point the palette's session items at `activateSessionAnywhere`, and its workspace items at `useNavigationStore.getState().setActiveWorkspace`, which already arbitrates.

- [ ] **Step 4: Build and exercise both doors**

Run: `npm run build && npm run dev`

Check:
1. `⌘P`, type a workspace name, Enter → this window switches to it.
2. With that workspace open in window A, do the same from window B → window A comes forward and B does not change.
3. Palette workspace rows show status dots matching the switcher's.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Make every workspace door respect the one-window rule"
```

---

# Phase 6 — Polish and proof

## Task 14: Make background work visible, and restore windows on launch

Sessions keeping running with no window open is only honest if there is a way to tell. This adds the dock badge that says so, and brings each window back where it was.

**Files:**
- Modify: `src/main/TerminalManager.ts`
- Modify: `src/main/window-manager.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `JsonStateFile` (Task 2), `listContexts` (Task 8)
- Produces: `TerminalManager.getAttentionCount(): number`; `saveWindowLayout(): void`; `restoreWindowLayout(): void`

- [ ] **Step 1: Track what is waiting**

In `src/main/TerminalManager.ts`, add the field and the accessor:

```typescript
    /** Instances showing a menu that wants a keypress. Drives the dock badge. */
    private readonly awaiting = new Set<string>();
```

```typescript
    /** How many sessions are waiting on a human, across every workspace. */
    public getAttentionCount(): number {
        return this.awaiting.size;
    }
```

In `wireEvents`, maintain it alongside the broadcast:

```typescript
        terminal.on('awaiting-confirmation', (awaiting: boolean) => {
            if (awaiting) {
                this.awaiting.add(instanceId);
            } else {
                this.awaiting.delete(instanceId);
            }
            this.broadcast(IPC_CHANNELS.TERMINAL_AWAITING_CONFIRMATION, { instanceId, awaiting });
            this.onAttentionChanged?.();
        });

        terminal.on('exit', (info: TerminalExitInfo) => {
            // A dead process is not waiting for anything.
            this.awaiting.delete(instanceId);
            this.broadcast(IPC_CHANNELS.TERMINAL_EXIT, { instanceId, ...info });
            this.onAttentionChanged?.();
        });
```

and add the hook the badge listens on:

```typescript
    /** Called whenever getAttentionCount() may have changed. */
    public onAttentionChanged?: () => void;
```

Also delete from `awaiting` in `destroy(instanceId)`.

- [ ] **Step 2: Drive the badge**

In `src/main/ipc-handlers.ts`, after constructing the terminal manager:

```typescript
    // With no windows open on macOS the app is still alive and sessions are
    // still running. The badge is the only thing that says so.
    manager.onAttentionChanged = () => {
        if (typeof app.setBadgeCount === 'function') {
            const count = manager.getAttentionCount();
            app.setBadgeCount(count > 0 ? count : 0);
        }
    };
```

- [ ] **Step 3: Persist and restore the window layout**

Append to `src/main/window-manager.ts`:

```typescript
import { app } from 'electron';
import { JsonStateFile } from './state/JsonStateFile';

interface WindowLayoutFile {
    windows: Array<WindowContext & { bounds: Electron.Rectangle }>;
}

function layoutFile(): JsonStateFile<WindowLayoutFile> {
    return new JsonStateFile<WindowLayoutFile>(path.join(app.getPath('userData'), 'windows.json'));
}

export function saveWindowLayout(): void {
    const windows = listContexts();
    if (windows.length === 0) return;
    layoutFile().write({ windows });
}

/**
 * Reopen the windows from last launch, or one empty window on a first run.
 *
 * A saved workspace that has since been deleted opens on Home rather than
 * failing: a window must never hold an id that names nothing.
 */
export function restoreWindowLayout(knownWorkspaceIds: Set<string>): void {
    let stored: WindowLayoutFile | null = null;
    try {
        stored = layoutFile().read();
    } catch {
        // A layout we cannot read is worth nothing; a fresh window costs a click.
        stored = null;
    }

    const windows = stored?.windows ?? [];
    if (windows.length === 0) {
        createWindow();
        return;
    }

    for (const entry of windows) {
        const workspaceId =
            entry.workspaceId && knownWorkspaceIds.has(entry.workspaceId) ? entry.workspaceId : null;
        createWindow(
            { workspaceId, activeSessionId: workspaceId ? entry.activeSessionId : null },
            entry.bounds
        );
    }
}
```

Give `createWindow` the optional bounds:

```typescript
export function createWindow(
    context: WindowContext = EMPTY_CONTEXT,
    bounds?: Electron.Rectangle
): BrowserWindow {
```

and inside the `BrowserWindow` options, replace the fixed `width`/`height` with:

```typescript
        width: bounds?.width ?? 1000,
        height: bounds?.height ?? 700,
        ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
```

- [ ] **Step 4: Use it at both ends of the process**

`restoreWindowLayout` needs the workspace ids, which only `ipc-handlers` has. Export a getter from there:

```typescript
export function getKnownWorkspaceIds(): Set<string> {
    return new Set((workspaceService?.getAll() ?? []).map((workspace) => workspace.id));
}
```

In `src/main/index.ts`, replace the bare `createWindow()` in `whenReady`:

```typescript
    setupIpcHandlers();
    restoreWindowLayout(getKnownWorkspaceIds());
```

and save on the way out:

```typescript
app.on('before-quit', () => {
    // Read the layout while the windows still exist — by the time cleanup runs
    // they are gone and there is nothing left to record.
    saveWindowLayout();
    cleanupIpcHandlers();
});
```

- [ ] **Step 5: Check it by hand**

Run: `npm run build && npm run dev`

Check:
1. Open two windows on two workspaces, resize one, quit, relaunch → both come back, in place, on their workspaces.
2. Start a session, get it to a permission prompt, close every window → the dock icon shows a badge of 1.
3. Click the dock icon → a window opens and the session is still there, mid-prompt.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Badge waiting sessions and reopen windows where they were"
```

---

## Task 15: Prove the window rules in E2E

**Files:**
- Modify: `tests/e2e/helpers/electron.ts`
- Create: `tests/e2e/windows.spec.ts`

**Interfaces:**
- Produces: `launchElectron(options?: { userDataDir?: string })`, `newWindowChord(): string`

- [ ] **Step 1: Make launches hermetic**

Every test in this file writes `workspaces.json`, so they cannot share the profile they run in. Replace `tests/e2e/helpers/electron.ts`:

```typescript
import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface LaunchOptions {
  /** Profile directory. Defaults to a fresh temp dir, so runs cannot collide. */
  userDataDir?: string;
}

/** The chord for a new window, matching useKeyboardShortcuts on this platform. */
export function newWindowChord(): string {
  return process.platform === 'darwin' ? 'Meta+Shift+KeyN' : 'Control+Shift+KeyN';
}

export function createProfileDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'consola-e2e-'));
}

export async function launchElectron(
  options: LaunchOptions = {}
): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const userDataDir = options.userDataDir ?? createProfileDir();

  const app = await electron.launch({
    args: [
      path.join(__dirname, '../../../dist/main/main/index.js'),
      // main/index.ts still appends its " Test" suffix on top of this, which is
      // fine: the point is that the root is ours and nothing else writes here.
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  return { app, page, userDataDir };
}
```

`terminal.spec.ts` destructures `{ app, page }`, which still works.

- [ ] **Step 2: Write the failing test**

Create `tests/e2e/windows.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchElectron, newWindowChord } from './helpers/electron';

let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  ({ app, page } = await launchElectron());
});

test.afterEach(async () => {
  await app.close();
});

/** Create a workspace without going through the native folder picker. */
async function seedWorkspace(target: Page, name: string, folder: string): Promise<string> {
  return target.evaluate(
    ([workspaceName, workspacePath]) =>
      window.workspaceAPI
        .createWorkspace(workspaceName, workspacePath, false)
        .then((workspace) => workspace.id),
    [name, folder] as const
  );
}

test('the new-window chord opens a second window', async () => {
  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  expect(app.windows()).toHaveLength(2);
});

test('a workspace created in one window appears in the other', async () => {
  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  await seedWorkspace(page, 'alpha', '/tmp/alpha');

  await expect
    .poll(() =>
      second.evaluate(() =>
        document.body.textContent?.includes('alpha') ? 'present' : 'absent'
      )
    )
    .toBe('present');
});

test('a workspace open in one window is focused, not duplicated, from another', async () => {
  const workspaceId = await seedWorkspace(page, 'alpha', '/tmp/alpha');
  await page.evaluate((id) => window.windowAPI.activateWorkspace(id), workspaceId);

  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  const verdict = await second.evaluate(
    (id) => window.windowAPI.activateWorkspace(id),
    workspaceId
  );

  expect(verdict).toBe('focused-elsewhere');
  expect(app.windows()).toHaveLength(2);
});

test('workspaces survive a relaunch through the state file, not localStorage', async () => {
  const { app: first, page: firstPage, userDataDir } = await launchElectron();
  await seedWorkspace(firstPage, 'persisted', '/tmp/persisted');
  await first.close();

  const { app: second, page: secondPage } = await launchElectron({ userDataDir });
  const names = await secondPage.evaluate(() =>
    window.workspaceAPI.getSnapshot().then((snapshot) => snapshot.workspaces.map((w) => w.name))
  );
  await second.close();

  expect(names).toContain('persisted');
});
```

- [ ] **Step 3: Run it and watch it fail for the right reason**

Run: `npm run build && npm run test:e2e -- windows.spec.ts`
Expected: FAIL only if a rule is actually broken. If every test passes on the first run, that is the expected outcome — Tasks 8 through 14 built these behaviours, and this task is the proof, not the implementation.

- [ ] **Step 4: Add the outlive-the-window case**

This one needs a real session, so it follows the pattern in `terminal.spec.ts`. Append to `windows.spec.ts`:

```typescript
test('closing a window leaves its session running', async () => {
  const workspaceId = await seedWorkspace(page, 'alpha', process.cwd());
  await page.evaluate((id) => window.windowAPI.activateWorkspace(id), workspaceId);

  const instanceId = `workspace-${workspaceId}-session-e2e`;
  await page.evaluate(
    ([instance, cwd]) =>
      window.terminalAPI.create({
        instanceId: instance,
        cwd,
        claudeSessionId: '22222222-2222-4222-8222-222222222222',
        resume: false,
        cols: 80,
        rows: 24,
      }),
    [instanceId, process.cwd()] as const
  );

  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');

  await page.close();

  // Reattaching from a different window returns the replay buffer, which only
  // exists if the PTY was never torn down.
  const snapshot = await second.evaluate(
    ([instance, cwd]) =>
      window.terminalAPI.create({
        instanceId: instance,
        cwd,
        claudeSessionId: '22222222-2222-4222-8222-222222222222',
        resume: true,
        cols: 80,
        rows: 24,
      }),
    [instanceId, process.cwd()] as const
  );

  expect(snapshot.replay.length).toBeGreaterThan(0);
});
```

- [ ] **Step 5: Run the whole suite**

Run: `npm run build && npm test && npm run test:e2e`
Expected: all unit tests and all E2E specs pass, including the pre-existing `terminal.spec.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: Cover the window rules end to end"
```

---

## Done when

- Two windows hold two workspaces, and a workspace cannot be in both.
- Closing a window leaves its sessions running; the dock badge counts the ones waiting.
- `workspaces.json` and `harnesses.json` are the source of truth; the localStorage copies are still on disk, untouched, as the one-release fallback.
- The sidebar lists sessions only; the top bar names the workspace and dots the ones that want you.
- `npm test` and `npm run test:e2e` both pass.
