# One Workspace Per Window

**Date:** 2026-08-19
**Status:** Design — approved, not implemented

## Problem

Workspaces live in the sidebar as a collapsible tree: every workspace, and under
each one every named session. Four things are wrong with it at once.

The tree is crowded — several workspaces times their sessions, and the session
you want is somewhere in the scroll. It spends vertical space on workspace rows
that sessions need. It puts other projects' sessions on screen while you work in
this one. And because a workspace is a row rather than a window, two projects
cannot sit side by side on two monitors.

The fix is to scope a window to one workspace, move the workspace picker to the
top bar, and let a second window hold a second workspace.

## What this costs, and how it is paid for

The sidebar is currently the only place that shows a session in *another*
workspace needs you: `SessionNavItem` renders a `running` / `attention` /
`error` dot for every session in every workspace. Scoping to one workspace per
window deletes that signal, and
`research/2026-08-18-agent-deck-conductor-listeners-actions.md` points the
opposite way — toward supervising a fleet, where "which one is waiting on me"
is the primary question.

So the signal has to survive the move. It does, in two places: an attention dot
on the top-bar switcher whenever any *other* workspace has a session awaiting
confirmation or exited, and a per-workspace dot in the switcher's dropdown.
That is one glyph of cost against four problems solved.

## Decisions

| Question | Decision |
|---|---|
| Window ↔ workspace | One workspace per window, switchable from the top bar, but a workspace lives in at most one window. Picking one that is open elsewhere focuses that window. |
| Closing a window with work in flight | Sessions keep running. A window is a view; the existing "terminals outlive their views" invariant is lifted one level. |
| Shared state | Main process owns workspaces and harnesses. Renderers send intents, never whole-state writes. |
| Cross-workspace awareness | Preserved in the switcher, not the sidebar. |

The unique-binding rule is what keeps this cheap: one live view per PTY means no
event fan-out, no two panes rendering one session, and no divergence between two
windows' file explorer and git panel state.

## Process and window lifecycle

One app process, N windows. The single-instance lock stays exactly as it is — it
is what guarantees one `TerminalManager` owns every PTY, so a second window is a
second view and never a rival process.

**`window-manager.ts`** loses its `mainWindow` singleton and becomes a registry
holding `Map<windowId, { window, workspaceId }>`. It gains:

- `createWindow(workspaceId | null)`
- `findWindowForWorkspace(id)` — the lookup that enforces unique binding
- `focusOrCreate(workspaceId)`

**`ipc-handlers.ts`** stops taking a window. `setupIpcHandlers()` is called once
at `whenReady`, before any window exists, and registers every `ipcMain` handler
exactly once. Today it is called per window from both `whenReady` and
`activate`, and the second call avoids a duplicate-handler throw only because
`cleanupIpcHandlers` happens to have run first. That coincidence goes away.

**`TerminalManager`** drops `constructor(window)`. `ensure()` takes an owner
from `event.sender` and stores it per instance; `send()` targets that instance's
owner and no-ops when it is destroyed. Reattaching from a different window
reassigns the owner and replays the buffer.

**Teardown re-scopes.** `window-all-closed` no longer calls
`cleanupIpcHandlers()` — on darwin it does nothing at all, so PTYs survive with
zero windows open. Only `before-quit` tears down. `activate` calls
`focusOrCreate` instead of re-registering handlers.

### Event routing is per channel, not per window

Owner-only routing alone would leave no window able to see that another
workspace needs attention, which defeats the design. The split is by weight:

| Channel | Routing | Why |
|---|---|---|
| `TERMINAL_DATA` | Owner window only | Heavy, and meaningful only to the pane rendering it |
| `TERMINAL_ACTIVITY` | All windows | Tiny, globally interesting |
| `TERMINAL_AWAITING_CONFIRMATION` | All windows | Tiny, globally interesting |
| `TERMINAL_EXIT` | All windows | Tiny, globally interesting |

`terminalStore` therefore holds status for every session, not just local ones,
and the attention dot is computable in any window.

## State ownership

Four keys persist today. They split three ways.

### Moves to main

`WorkspaceService` and `HarnessService`, each owning a JSON file under
`app.getPath('userData')`. These two are conversation-bearing: a lost session
record orphans a transcript, and a lost harness record orphans every transcript
written under it. Everything else can afford last-writer-wins.

The renderer keeps `useWorkspaceStore` as a read-through cache, which is what
keeps the blast radius small. Of the 39 usages outside the store, 27 are reads
and stay untouched. The 12 mutating sites become `workspaceBridge` intents:

```
createWorkspace   deleteWorkspace   updateWorkspace
createSession     updateSession     deleteSession
```

`updateSessionActivity` is not in that list. It is declared on the store and
called from nowhere — dead before this change. Delete it rather than port it;
`lastActiveAt` is already written on create, and reviving the field is a
separate decision from moving the store.

Main applies the intent, writes, and broadcasts the new state to every window,
which replaces its snapshot wholesale. Concurrent writes cannot lose data
because no renderer ever sends a whole blob.

```
Renderer                          Main
  workspaceBridge.createSession() ──intent──▶ WorkspaceService
                                              (owns the file,
                                               serializes all writes)
  useWorkspaceStore  ◀──broadcast─────────── every window
```

One knock-on: `createSession` returns the new `Session` synchronously today and
`createQuickSession` uses it to navigate (`sessionActions.ts:46`). That becomes
async. Every caller is an event handler, so it is a signature change rather than
a restructure.

### Per window, injected at creation

`windowId` and `workspaceId` travel through
`webPreferences.additionalArguments`, so preload exposes them synchronously and
the first paint already knows which workspace it is — no flash, no async gate on
identity. `activeSessionId` lives in main's window record alongside bounds, so a
relaunch restores each window where it was left.

### Stays in localStorage

`consola-settings`, plus `isSidebarHidden` and `isExplorerVisible` — preferences
rather than identity, where a boolean race is harmless. These stay global rather
than per window. `expandedWorkspaces` is deleted.

## Renderer shape

### The switcher

Lands in `.app-header-content`, already styled at `Layout/styles.css:45` and
currently rendered by nothing. The button shows the workspace's `GitBranch` or
`Folder` icon, its name, a chevron, and an attention dot when any other
workspace has a session awaiting confirmation or exited.

It gets two doors. Clicking opens an anchored Radix `DropdownMenu` listing
workspaces with per-workspace status dots and session counts, then `Open in new
window`, `Add workspace…`, and the items left homeless by removing
`WorkspaceActionsMenu` from the sidebar. Keyboard flow keeps `pick-workspace`
mode in the command palette, which already exists at `buildItems.ts:109` and
already fuzzy-searches.

A centered overlay is the wrong shape for a top-left button, and an anchored
dropdown is the wrong shape for "I do not know where that workspace is". Both,
not one.

### Selection is arbitrated by main

`windowBridge.activateWorkspace(id)` returns `took` or `focused-elsewhere`, and
the renderer re-scopes only on `took`. Putting the unique-binding rule anywhere
else invites two windows to claim one workspace in the same tick.

### Sidebar

Loses `WorkspaceNavItem` entirely. It becomes a "Sessions" header with the `+`,
a flat `SessionNavItem` list for the active workspace, and the settings footer.
The `--indent-1` class goes with the nesting.

### Views

`HomeView` survives for `workspaceId === null` — a fresh window, or first launch
— with its copy updated, since "select a workspace from the sidebar" stops being
true.

### Zero windows

On macOS the app stays alive with no windows and PTYs still running. A dock
badge counts sessions awaiting confirmation, and `activate` reopens the last
window. This is the affordance that makes "sessions keep running" honest rather
than invisible.

## Migration

Main cannot read Chromium's LevelDB, so the import comes from the renderer. On
boot main reports `needsImport` when no `workspaces.json` exists. The first
window reads its own persisted state through the existing zustand path — running
`migrateWorkspaceState` one final time — and posts the result via
`workspace:import`.

Main accepts an import **only when the file is absent**. That makes it
idempotent by construction and settles the two-windows-at-first-launch race
without a lock.

`migrateWorkspaceState` moves to `src/shared/`. Both sides need it — the
renderer for the import release, main for every migration after — and one ladder
is the only way it stays trustworthy. It is already exported for standalone
exercise, for the reason CLAUDE.md gives.

The renderer does not clear localStorage after a successful import. The copy
stays through one release as a fallback.

Writes are atomic: temp file, fsync, rename, and a `.bak` of the last good
state.

## Error handling

| Situation | Behaviour |
|---|---|
| Corrupt `workspaces.json` at boot | Load `.bak`. If both fail, surface an error and refuse to start. Booting with zero workspaces is indistinguishable from total data loss to the person looking at it, and it would quietly orphan every transcript. |
| Workspace deleted while open in another window | Main broadcasts; that window falls to `workspaceId = null` and HomeView. A window never holds a dead id. |
| Restored window record names a deleted workspace | Same landing, no error. |
| Two windows race to claim one workspace | Impossible — main arbitrates, the renderer obeys. |
| Process crash | PTYs die with it, as today. |

Two things explicitly do not change. Queued-prompt delivery is gated on
`ScreenModel` in main, so it is indifferent to whether any window exists and the
"never type into a confirmation menu" invariant holds unmodified. And a session's
harness stays fixed for its lifetime.

## Testing

The repo has one Playwright spec and no unit test runner. This change moves
conversation-bearing data across a process boundary through a one-shot
migration, which makes it the highest-risk work in the codebase and currently
the least covered. Vitest is added as part of this; Vite is already present, so
it is near-zero config.

**Unit — the things whose failure costs conversations:**

- The full `migrateWorkspaceState` ladder, v2 through v5, including the pre-v4
  path that mints a fresh `claudeSessionId` and the v5 harness backfill. The
  move to main does not bump the shape version — nothing about the records
  changes, only who writes them.
- `WorkspaceService` intent application, atomic write, `.bak` recovery from a
  corrupt file, and refusal to boot empty.
- Import idempotency: a second `workspace:import` against an existing file is a
  no-op.

**E2E — Playwright enumerates windows via `electronApp.windows()`:**

- Unique binding: window A holds workspace X; open a second window and pick X →
  two windows, focus moves, X rendered once.
- Broadcast: create a session in A, assert it appears in B's sidebar.
- Outlive: start a session, close its window, reopen → the pane repaints from
  `ScreenModel.snapshot()` and the PTY was never restarted.
- Migration: launch with seeded localStorage, assert `workspaces.json` is written
  and the UI is unchanged.

The test profile already gets its own `userData` (`main/index.ts:22`), so
`workspaces.json` lands in *Consola Test* and real workspaces are never touched.

## Out of scope

- Grouping sessions inside a workspace.
- Conductors, watchers, and the rest of
  `research/2026-08-18-agent-deck-conductor-listeners-actions.md`. This design
  is compatible with them: main owning session state and broadcasting status to
  every window is a precondition for supervision, not an obstacle to it.
- Per-window sidebar and explorer visibility.
- Behaviour when a workspace folder disappears from disk.
