# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Consola?

Consola is an Electron desktop application that provides a structured AI-assisted development workflow around the Claude Code CLI. It features a multi-workspace tabbed interface where each session runs `claude` in an embedded terminal, alongside file exploration with git status integration and a git review panel.

**The CLI owns the conversation.** Consola does not reimplement chat, tool rendering, permissions, or history — it spawns `claude` in a PTY and renders it with xterm.js, so improvements to Claude Code arrive without any work here. Consola's job is the surrounding workspace: sessions, files, git, and layout.

## Build & Development Commands

```bash
pnpm run dev              # Full dev environment (Vite HMR + tsc --watch + Electron auto-restart)
pnpm run build            # Production build (all processes)
pnpm start                # Run production build
pnpm run test:e2e         # Run Playwright E2E tests
```

Individual builds:
```bash
pnpm run build:main       # Main process only
pnpm run build:preload    # Preload script only
pnpm run build:renderer   # Renderer (Vite) only
```

Only the renderer hot-reloads. `src/main` and `src/preload` are compiled and
loaded once per launch, so `scripts/dev-electron.cjs` restarts Electron when
their output changes — otherwise a new UI ends up talking to a main process
built hours earlier, and the mismatch reads as a renderer bug. It restarts only
when the code the app loads actually changes: compiled tests (`*.test.js`) and
rebuilds that emit identical output (`pnpm build`, which `test:e2e` runs first)
leave the running app alone, because every restart pulls its window to the
front. E2E runs themselves are already hidden and unfocusable
(`src/main/test-mode.ts`); set `CONSOLA_E2E_HEADED=1` to watch them.

All commands above run from the repository root. The pnpm workspace contains
`apps/desktop` (`consola`) and `apps/website` (`@consola/website`). Turborepo
orchestrates builds, tests, and typechecking. Paths below beginning with `src/`,
`scripts/`, or `dist/` are relative to `apps/desktop`. Use
`pnpm --filter consola exec <tool>` for app-specific tools.

## Architecture Overview

### Three-Process Structure

```
src/main/           → Electron main process (Node.js, CommonJS output)
src/preload/        → Context bridge (exposes APIs to renderer)
src/renderer/       → React frontend (Vite, ESM)
src/shared/         → Shared types and IPC channel constants
```

### Main Process Key Files
- `index.ts` - App lifecycle, window management
- `ipc-handlers.ts` - All IPC message routing
- `TerminalService.ts` - One session's PTY, prompt delivery
- `TerminalManager.ts` - Owns a TerminalService per session, forwards events
- `ScreenModel.ts` - Headless xterm mirroring what a PTY displays
- `LoginEnvironment.ts` - The ambient login-shell environment, shared by every driver
- `drivers/` - One driver per agent CLI: binary resolution, argv, env, health probe
- `ClaudeSessionIndex.ts` - Reads Claude's own transcripts and session index
- `HarnessCapabilitiesCache.ts` - Remembers what each harness said it can offer

### Renderer Organization
- `components/` - React components with co-located `styles.css`
- `stores/` - Zustand stores (agentStore, workspaceStore, navigationStore, etc.)
- `services/` - Bridge services for Electron API access
- `hooks/` - Custom React hooks

## Critical Patterns

### Electron IPC Bridge Pattern

**Always use bridge services** to access Electron APIs - never access `window.*API` directly.

```typescript
// Correct - use the bridge
import { dialogBridge } from '../../services/dialogBridge';
const result = await dialogBridge.selectFolder();

// Wrong - direct window access
const result = await window.dialogAPI.selectFolder();
```

Bridge services are in `src/renderer/services/`:
- `terminalBridge.ts` - Session terminals
- `harnessBridge.ts` - Harness health probes and session names
- `dialogBridge.ts` - Native dialogs
- `fileBridge.ts` - File system reads
- `gitBridge.ts` - Git status

### Terminals Outlive Their Views

A PTY belongs to the main process and is keyed by `instanceId`. Unmounting a
session pane (switching tabs) tears down only the xterm view — the terminal
keeps running so background work continues. Only closing a session destroys it.

Remounting repaints from `ScreenModel.snapshot()`, escape sequences that
reconstruct the current screen exactly. Do not try to reason about a TUI from
the raw byte stream: Claude paints with cursor movement and overwrites in
place, so recent bytes are not the current screen. Ask the `ScreenModel`.

### Each Workspace Remembers Where It Was Left

Switching workspaces returns to the view that workspace was last on, rather
than the blank composer. A "view" is the pair `(activeSessionId, overlay)`
— exactly what `MainContent` routes on. Both travel together because opening
the Inbox does not clear the session: it overlays the pane while the session
keeps running behind it, so remembering one without the other loses half the
answer.

`ViewMemoryService` (`state/ViewMemoryService.ts`) owns this, keyed by
workspace and persisted to `view-memory.json`. Keyed by workspace rather than
by window because a workspace outlives the window showing it, and main already
guarantees at most one window holds a workspace — so an entry has one writer.

Three things are load-bearing:

- **Not a field on the `Workspace` record.** Every `WorkspaceService` write is a
  synchronous fsync of the whole list plus a full snapshot pushed to every
  window. That is right for renaming a workspace and absurd for clicking a
  session, which is why navigation has its own small file that nobody
  subscribes to.
- **Resolution happens on read**, in `resolveRememberedView` — a dangling
  session id becomes `null`, while workspace destinations remain available.
  Because every read goes through it, nothing upstream
  has to eagerly clean up after a delete. A dangling id never resolves to a
  *substitute* session: mounting one spawns a PTY the user never asked for.
- **"No session" is a remembered state**, not an absence of one. Backing out to
  the composer on purpose is written through, so returning does not resurrect
  the session. For the same reason, anything that means "start something new"
  — `openNewSessionComposer` — must not route through `setActiveWorkspace`,
  which restores the remembered view.

### Session Identity

Consola assigns each tab a UUID and launches `claude --session-id <uuid>` the
first time, then `--resume <uuid>` afterwards (`Session.hasStarted`). Reusing
`--session-id` for an existing session is an error, hence the two paths. If a
resume fails because the conversation is gone, `TerminalService` falls back to
a fresh session automatically — so never gate resuming on a local existence
check, Claude is the authority.

A session's conversation can be replaced without replacing the session. An
action set to start fresh (`WorkItemAction.conversation`), run in a session
that already exists, gives that tab a new `claudeSessionId` through
`WorkspaceService.replaceConversation` — the only writer of the field, which
is why it is absent from `allowedSessionUpdates` — and
`TerminalService.startFreshConversation` moves the live terminal onto it.
Tab, harness, model, tool policy, checkout and linked item all stay. Do not
reach for typing `/clear` instead: the Claude driver does not follow a
conversation change made inside the CLI, so the record would keep naming
the old conversation and the next relaunch would resume it.

### Git State Belongs to the Checkout

A session runs in its scope's folder or in its own linked worktree
(`Session.cwd`). Everything git-shaped — header stats, the review panel, the
explorer's colours, palette commits — reads `checkoutPathForSession`, never
the scope's path. A worktree has its own branch, index and changes, so the
scope would report (and commit) a different checkout than the agent edits.

The agent can also move itself: Claude's `EnterWorktree` moves the whole
process into a worktree Consola never made. While a session works, its
terminal asks the driver where the process is (`readWorkingDirectory`,
Claude's own `<config>/sessions/<pid>.json`), and main records a difference
as `Session.agentCwd` (`WorkspaceService.recordAgentCwd`, its only writer).
`checkoutPathForSession` prefers it, so every git view follows the agent.
Launching never does: spawns still start in `cwd`, and the CLI reports again
from there.

Whether a folder *is* a worktree is asked of git (`readCheckout`, cached per
folder in `checkoutStore`), not inferred from the record: a scope can itself
be a worktree. The header's checkout chip and the sidebar's worktree line read
that one answer, so they cannot name different branches for one session.

### Never Type Into a Confirmation Menu

Queued prompts are delivered only when the emulated screen shows an *empty*
composer and no confirmation markers (`CONFIRMATION_MARKERS`). Claude shows a
workspace trust gate on first launch in an unfamiliar folder, and typing into
it would answer it. Any future automated input must respect the same guard.

An automation's session never needs that guard for its first turn: it runs
non-interactively (Claude's print mode), with its prompt as an argument, so
there is no composer and no menu to type into. That happens only in a
read-only session, and each driver refuses it otherwise
(`SessionLaunch.unattended`): print mode skips the trust prompt, and
without `--restricted` it would load the folder's hooks and settings
unasked. The run lasts until that process exits. Continuing the session
afterwards is an ordinary interactive resume, still read-only, where the
trust prompt is the person's to answer. Lifting the restriction means a
fork the person starts (`SessionLauncher.forkWithFullTools`), never an edit
of the session's `toolPolicy`.

### The Assistant

Each workspace has one `kind: 'assistant'` session: a conversation that sees
every scope and runs the others. It is created on first open, and it lives in
its own folder beside `factory.yml` (not a repo, so no git, explorer or review
panels). `listedSessions` hides it from the renderer's session lists and pickers
(`consola_list_sessions` deliberately lists it). A session needs a
scope, so `removeScope` moves it to a remaining one, or drops it with the last.

It adds three tools to the generic MCP endpoint: `consola_prompt_session`,
`consola_read_session` and `consola_start_session` (the last replaces the
generic one, which would start work inside the Assistant's own folder). The
workspace is resolved from the endpoint on every call, never from an argument,
so it cannot reach across workspaces or address itself.

It wakes a session through `SessionLauncher.deliverPrompt`, which relaunches an
exited terminal in place: the pane another window is showing keeps streaming.
It hears back through `AssistantActivity`, which listens on `TerminalManager`'s
status listener set and tells it when the sessions it touched settle.

An Assistant start on a work item refreshes an existing worktree to the PR's
latest head only for a read-only session. Claude trusts a folder per path, so
refreshing one the person already trusted would load the author's newly pushed
settings and hooks into a full-tools session with no trust prompt. The worktree
is one per item, so the same holds for every read-only refresh (automation
runs, Assistant starts and re-runs): it is skipped while any full-tools session
was launched there, running or not (`worktreeHeld`).

### Harnesses Are Launch Descriptions

A harness is one configured agent CLI: a binary path, a config directory, and
extra arguments. Consola coordinates CLIs rather than embedding them, so a
harness never holds a credential — pointing one at its own
`CLAUDE_CONFIG_DIR` is what gives it a separate login, history and transcripts.

Everything CLI-specific lives behind `HarnessDriver` (`src/main/drivers/`).
Supporting another CLI means adding a driver and registering it; nothing in
`TerminalService`, `ipc-handlers`, or the renderer should branch on a driver id.

Two invariants are load-bearing:

- **A session's harness is fixed for its lifetime.** The transcript is written
  inside that harness's config directory, and `--resume` only finds it there.
  A session's model is fixed the same way and for the same kind of reason: it
  is replayed on every relaunch, so a later edit would move a conversation onto
  a different model part-way through. Both are kept immutable by being absent
  from `allowedSessionUpdates`, not by validation. So is a session's
  `toolPolicy` (`read-only` for every session an automation starts): main
  replays it from the record on every launch, `TERMINAL_CREATE` included,
  and each driver enforces it with its CLI's own flags or refuses to launch.
- **Deleting a harness archives it.** The record has to outlive removal, or
  every conversation started under it would resume against the wrong profile.

A harness that pins nothing resolves exactly as Consola did before harnesses
existed, ambient `CLAUDE_CONFIG_DIR` included. Keep that true: it is what the
built-in harness and every migrated session rely on.

### Ask the CLI What It Can Do

Slash commands, subagents and models are not Consola's to enumerate. The CLI
answers an `initialize` control request over stream-json stdio with its own
`/` menu — commands, agents, models, output styles and the signed-in account —
before running any turn, so the question costs no tokens and starts no
conversation (`drivers/claudeCapabilities.ts`).

The answer is scoped to the harness's config directory, not the working
directory: a repo's own `.claude/commands` never appears, so the probe runs
from the home directory and is cached per harness rather than per workspace.
That cache lives in the main process, because the probe starts a real process
and runs the user's `SessionStart` hooks — once per harness, not once per
window. Cache by what a harness *launches as*, never by its record id, and an
edited harness re-probes with nothing to invalidate.

Parse the response strictly. It is the CLI's own wire format rather than a
promised contract, so an unrecognised shape must throw: a plausible-looking
empty result would read as "this harness has no commands".

### Claude's Own Storage

`ClaudeSessionIndex` reads transcripts under `$CLAUDE_CONFIG_DIR/projects`
(falling back to `~/.claude`) — always honour that variable. Locate files by
probing each project directory for `<sessionId>.jsonl`; the directory-name
encoding is lossy and cannot be derived from a working directory. The
transcript is authoritative and `sessions-index.json` is a cache that lags.

### IPC Channels

All channel names are defined in `src/shared/constants.ts`. Key patterns:
- `terminal:*` - Session terminal lifecycle and events
- `harness:*` - Harness health probes and session names, dispatched by driver
- `file:*` - File operations
- `git:*` - Git status and commit message generation
- `dialog:*` - Native dialogs

Every terminal message carries `instanceId`; there is one terminal per session.

## Licensing

Consola is AGPL-3.0-only (`LICENSE`), and every `package.json` says so. Three
rules follow:

- **Packages other people build against are MIT.** Plugin API types
  (`@consola/plugin-types`), the `factory-spec` schema, integration manifest
  formats: anything a third party compiles against gets its own MIT `LICENSE`
  and `"license": "MIT"`, so plugin and integration authors choose their own
  license. Such a package must not import from `apps/*` — that would pull
  AGPL code into it.
- **A server people use over the network offers its source** (AGPL §13). The
  cloud web app links to the source of the version it is running.
- **Dependencies must be AGPL-compatible**: MIT, ISC, BSD, Apache-2.0,
  MPL-2.0, LGPL and GPL-3.0 are; GPL-2.0-only is not.

Outside contributions need a signed CLA (`CLA.md`, checked by
`.github/workflows/cla.yml`). It is what keeps relicensing — a commercial
license, an MIT carve-out — possible, so never bypass it.

## Tech Stack

- **Electron 43** - Desktop framework
- **React 19** - UI (with react-router-dom hash routing)
- **Zustand** - State management
- **claude CLI** - AI integration, driven as a subprocess (not a library)
- **node-pty** - Pseudo-terminals (native; rebuilt for Electron on install)
- **@xterm/xterm** - Terminal rendering, plus `@xterm/headless` in the main process
- **@radix-ui/themes** - Component library
- **Vite** - Build tool (dev server at localhost:5173)
- **Playwright** - E2E testing

## Build Outputs

- Main: `dist/main/main/index.js`
- Preload: `dist/preload/preload/preload.js`
- Renderer: `dist/renderer/`

## Research Documents

Implementation plans live in `docs/plans/`.

Architecture decisions are documented in `docs/research/`:
- `2026-02-05-esm-commonjs-interop-claude-agent-sdk.md` - SDK integration
- `2026-02-05-git-status-file-explorer.md` - Git feature design
- `2026-02-03-workspace-feature-architecture.md` - Workspace system

Direction (where the product is heading, not a spec) lives in `docs/north-star/`:
- `docs/north-star/consola-factories.md` - Local + cloud automations ("factories"): the invariants and decisions to consult before designing anything that touches sessions-as-runs, actions, triggers, spec files, the cloud, or identity
