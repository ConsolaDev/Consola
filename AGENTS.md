# AGENTS.md

This file guides coding agents (Claude Code, Codex and the other CLIs Consola drives) working with code in this repository. `CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads it too.

## What is Consola?

Consola is an Electron desktop application that provides a structured AI-assisted development workflow around the Claude Code CLI. It features a multi-workspace tabbed interface where each session runs `claude` in an embedded terminal, alongside file exploration with git status integration and a git review panel.

**The CLI owns the conversation.** Consola does not reimplement chat, tool rendering, permissions, or history — it spawns `claude` in a PTY and renders it with xterm.js, so improvements to Claude Code arrive without any work here. Consola's job is the surrounding workspace: sessions, files, git, and layout.

## Build & Development Commands

```bash
pnpm run dev              # Full dev environment (Vite HMR + tsc --watch + Electron auto-restart)
pnpm run dev:cloud        # Consola Cloud: the API (3100) and the web app (5175)
pnpm run build            # Production build (all processes)
pnpm start                # Run production build
pnpm run test:e2e         # Run Playwright E2E tests
pnpm test                 # Every package's tests via Turborepo (the website's Playwright suite included)
pnpm --filter @consola/automation-engine test   # Just the engine's tests
```

Individual builds:
```bash
pnpm run build:main       # Main process only
pnpm run build:preload    # Preload script only
pnpm run build:renderer   # Renderer (Vite) only
```

Only the renderer hot-reloads. `src/main`, `src/preload` and the packages main
loads (`packages/factory-spec`, `packages/automation-engine`) are compiled and
loaded once per launch, so `scripts/dev-electron.cjs` restarts Electron when
their output changes — otherwise a new UI ends up talking to a main process
built hours earlier, and the mismatch reads as a renderer bug. It restarts only
when the code the app loads actually changes: compiled tests (`*.test.js`) and
rebuilds that emit identical output (`pnpm build`, which `test:e2e` runs first)
leave the running app alone, because every restart pulls its window to the
front. E2E runs themselves are already hidden and unfocusable
(`src/main/test-mode.ts`); set `CONSOLA_E2E_HEADED=1` to watch them.

All commands above run from the repository root. The pnpm workspace contains
`apps/desktop` (`consola`), `apps/website` (`@consola/website`),
`apps/cloud-api` (`@consola/cloud-api`), `apps/cloud-web` (`@consola/cloud-web`),
`packages/factory-spec` (`@consola/factory-spec`, MIT) and
`packages/automation-engine` (`@consola/automation-engine`). Turborepo
orchestrates builds, tests, and typechecking. Paths below beginning with `src/`,
`scripts/`, or `dist/` are relative to `apps/desktop`. Use
`pnpm --filter consola exec <tool>` for app-specific tools.

Tooling runs on one exact Node version, named in three places that move
together: `engines.node` (which Vercel reads), CI and the release build. Pin
an exact version, never a range: Vercel resolves a range to the newest major
it offers, so a range can move the website onto a new Node unannounced.
Node 26 ships without corepack, so `vercel.json`
runs pnpm through `npx pnpm@<version>`: keep that version equal to
`packageManager`. Electron bundles its own Node, so none of this changes the
app's runtime.

## Architecture Overview

### Three-Process Structure

```
src/main/           → Electron main process (Node.js, CommonJS output)
src/preload/        → Context bridge (exposes APIs to renderer)
src/renderer/       → React frontend (Vite, ESM)
src/shared/         → Shared types and IPC channel constants
```

### The Automation Engine

The automation runner is its own package, `packages/automation-engine`
(`@consola/automation-engine`, AGPL-3.0-only), because the same runner has to
run on the desktop, a headless runner and the cloud. So it imports no
`electron`, `node-pty`, `@xterm/*` or anything under `apps/`, and its
`boundary.test.ts` fails on any such import. Its core
(`packages/automation-engine/src/`) does no I/O: it imports no I/O module,
reaches no `process`, `fetch`, `require`, `XMLHttpRequest` or `WebSocket`
global, imports no test code, and its `index.ts` holds only exports. Node adapters (state files,
run history, the factory file on disk) live in its `src/node/`, the one place
allowed to touch the machine. The desktop is one host: it implements the
engine's ports, and `src/main/automations/engineViews.ts` maps its records
onto the package's narrow views. `src/shared/automations.ts` re-exports the
runner's types, type-only, so the renderer never loads the engine's runtime.
Beside it, `packages/factory-spec` (MIT) holds the `factory.yml` schema,
parser and Run record that every runner shares.

### Main Process Key Files
- `index.ts` - App lifecycle, window management
- `ipc-handlers.ts` - All IPC message routing
- `TerminalService.ts` - One session's PTY, prompt delivery
- `TerminalManager.ts` - Owns a TerminalService per session, forwards events
- `ScreenModel.ts` - Headless xterm mirroring what a PTY displays
- `LoginEnvironment.ts` - The ambient login-shell environment, shared by every driver
- `drivers/` - One driver per agent CLI: binary resolution, argv, env, health probe
- `ClaudeSessionIndex.ts` - Reads Claude's own transcripts
- `HarnessCapabilitiesCache.ts` - Remembers what each harness said it can offer
- `harnessSwitch/` - Moves a session onto another harness: plan, handoff documents, `HarnessSwitcher`
- `sessionTitles/` - Names sessions automatically: `SessionNamer`, title text and prompts
- `worktreeCleanup/` - Removes Consola's worktrees when their work is done, and rebuilds them: `policy.judge`, `WorktreeExecutor`, `WorktreeRebuilder`, the sweep
- `browser/` - The in-app browser's tabs and pages, and the agent's tools on them: `BrowserService`, `guestPolicy`, `PageDriver` over `CdpRelay`, `browserTools`

### Renderer Organization
- `components/` - React components with co-located `styles.css`
- `stores/` - Zustand stores (agentStore, workspaceStore, navigationStore, etc.)
- `services/` - Bridge services for Electron API access
- `hooks/` - Custom React hooks

### Consola Cloud

`apps/cloud-api` (`@consola/cloud-api`, Hono, Better Auth, Drizzle on PGlite or
Postgres) and `apps/cloud-web` (`@consola/cloud-web`, Vite and React) are the
company layer's first piece: Google sign-in and the deployment's one
organisation. Nothing in `apps/desktop` depends on them, and neither imports
from the desktop, the website or `packages/*`. Setup is in
`apps/cloud-api/README.md`, and the API's layers and the dependency rule that
keeps them apart are in `apps/cloud-api/AGENTS.md`.

The browser talks only to the web app's origin. Vite proxies `/api` to the API,
so the session cookie is first-party and the API needs no CORS. Better Auth
owns sign-in and sessions, and its tables are generated
(`pnpm --filter @consola/cloud-api auth:generate`), never hand-edited. Every
table that holds company data carries `organization_id`, and a person reaches
it through `member`.

`mayJoin` (`apps/cloud-api/src/domain/joinRule.ts`) is checked before an account
is created and before every new session. It is open for now (any Google
account with a verified email), so this deployment is for local use only. The
later rule that limits it to the company lands in `mayJoin` and so gates every
sign-in (sessions already open when the rule changes are not ended this
round). The web app's footer links to the source of the commit it runs
(AGPL §13).

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
- `harnessBridge.ts` - Harness health probes and capabilities
- `dialogBridge.ts` - Native dialogs
- `fileBridge.ts` - File system reads
- `gitBridge.ts` - Git status
- `browserBridge.ts` - In-app browser tabs and page actions

The website's demo runs the renderer against a hand-written stand-in for the
whole bridge (`apps/website/demo/mock.ts`, typed by `DemoBridge` to hold every
`window.*API` the app declares, less the few in `Unprovided` that the renderer
checks for before using). A new API, or a new member of one, must land there
too, or the site breaks: its Vercel build does not typecheck, so CI's
`pnpm --filter @consola/website typecheck` is what notices.

### Terminals Outlive Their Views

A PTY belongs to the main process and is keyed by `instanceId`. Unmounting a
session pane (switching tabs) tears down only the xterm view — the terminal
keeps running so background work continues. Only closing a session destroys it.

Remounting repaints from `ScreenModel.snapshot()`, escape sequences that
reconstruct the current screen exactly. Do not try to reason about a TUI from
the raw byte stream: Claude paints with cursor movement and overwrites in
place, so recent bytes are not the current screen. Ask the `ScreenModel`.

A snapshot is exact only in a view of the size it was captured at, so it
carries that size, and `restoreScreen` lays it into the fresh view at that size
before the view follows its pane. Panes follow their container only once its
size has settled (`whenSettled`). Both guard one failure: xterm drops the rows
below the cursor when it shrinks, and Claude keeps its prompt's frame there,
so a view that shrinks and returns to the size the CLI already knows has lost
rows the CLI will never repaint. Its relative cursor moves then land typing
above the prompt.

Output crosses to a window only while that window has a view of the terminal
mounted: unmounting sends `TERMINAL_DETACH`, and `TerminalManager` sends
nothing more until the next mount, which repaints from the snapshot. Two
things make that exact. `ScreenModel.write` parses synchronously, so a
snapshot holds every byte main has received; and a view drops output that
reaches it before its snapshot does, since that output is in the snapshot.
What is sent is gathered for `OUTPUT_BATCH_MS` first: a PTY hands over 1 KiB
per read, so one repaint is dozens of reads, and a frame boundary between them
paints half of it. The replay goes into the view in slices (`REPLAY_CHUNK`),
because xterm never yields inside one write.

A fullscreen CLI scrolls one row per wheel report, and xterm sends one report
per wheel event whatever its distance. `tuiWheel` turns each event into the
rows it moved (trackpads 1:1 with the fraction carried, notched wheels on a
curve), while the program has mouse reporting on.

`@xterm/xterm` and `@xterm/addon-webgl` carry pnpm patches (`patches/`): WebGL
atlas fixes (page layout versions, merged pages capped at 4096, released
textures and contexts) and three scroll fixes in xterm. The runtime reads the
minified `lib/` files; each hunk is repeated in `src/` so the patch can be
read. Bumping either package means carrying the patch over or dropping what
upstream fixed.

### Pages Live in One Place

The in-app browser's pages are `<webview>` guests, and Electron destroys the
guest of an element that moves. So no page lives in the browser panel, which
unmounts under every overlay and re-renders on every session switch:
`BrowserHost`, at the layout's root, holds every page of the window's
workspace in one parent, in creation order (`hostOrder`), and only ever adds
or removes one. The panel's slot only says where to draw. A page out of sight
is `display: none`, or painting but `inert` while an agent reads it
(`pagePresence`), never `visibility: hidden`, after which Electron 43 can
leave a macOS guest blank for good. DevTools open in a window of their own
(`mode: 'detach'`), so the page keeps its whole panel.

- **Main decides what a guest is.** `will-attach-webview` asks `decideAttach`
  (`browser/guestPolicy.ts`): the workspace's own partition, a web address (or
  `about:blank`), and preferences built from nothing (sandboxed, no preload,
  no nested `<webview>`), never copied from the element. Nothing the renderer
  puts on it is trusted; binding a guest to a tab is checked again
  (`decideGuestBinding`), and every later navigation goes through main
  (`browserBridge.navigate`), never `<webview>.src`.
- **Only a Consola window's main frame may call IPC.** Handlers register
  through `guardedIpc` (`isTrustedSender`), the second wall behind "no
  preload", so neither has to be right alone. A page's popup is a
  `BrowserWindow` too, so "a Consola window" means one `createWindow`
  registered (`isConsolaContents`), and broadcasts go through
  `consolaWindows()`, never `BrowserWindow.getAllWindows()`.
- **Logins are per workspace.** Its pages share the partition
  `persist:consola-browser-<workspaceId>` (`browserPartitionFor`), whose
  permission, device, screen-sharing and download rules `configurePartition`
  (`sessionPolicy.ts`) sets once. Navigation and popups are guarded per guest
  (`secureGuest`, `installPopupPolicy`), certificates per page.
- **Electron says yes for a page unless told no.** Left alone it hands a
  page the first client certificate in the system store and the first
  matching Bluetooth device, and lets its `beforeunload` keep it.
  `refusePageRequests` answers each no on every guest (`secureGuest`) and
  every popup (`hardenPopup`); a new request Electron answers itself goes
  there. A page never holds an unload: main's own ending of it
  (`destroyGuest`'s blanking, the navigation guard's revert) must go through.
- **A page does not outlive its window. The tab list does.** Unlike a PTY, a
  guest needs a DOM element in a window, so a window that closes or changes
  workspace takes its pages (`detachWindow`). Main owns the tabs
  (`BrowserService`), saves them in `browser-state.json` and pushes changes to
  the workspace's window; a page reloads from its address when shown. Main
  decides which tabs have a page (`LivePages`, `decideLive`): one hidden for
  `HIDDEN_UNLOAD_MS` (15 minutes) unloads, and past `MAX_LIVE_PAGES` (8) the
  least recently shown goes, never the visible page or one an agent's call
  holds. Tabs go with the session, logins with the workspace
  (`destroyWorkspace`), its pages ended first (`destroyGuest`) so none writes
  the cleared partition. A tab on an address also keeps a session that never
  had a message from being removed as empty (`browsedIn`,
  `EmptySessionReaper`): the person used it.
- **A page ends when its window removes the element**, once a snapshot stops
  calling the tab `live`; until then main blanks it (`destroyGuest`). Never
  `close()` a loaded guest: on Electron 43 that ends only main's handle while
  the page runs on, and a `window.open` from it then takes main down. Only a
  guest refused as it attaches, still on its first load, is stopped and closed
  (`installGuestPolicy`).
- **Three Electron traps.** Never stop or load a page inside its own navigation
  event, which takes the app down (`guardNavigation` waits for it to return).
  Read a web contents' `id` once, as it is created: a destroyed one throws on
  `.id`, and in an event handler the throw is swallowed and the entry leaks.
  It throws on almost any other read too, so each watcher of a page runs on
  its own (`isolated`): one that throws must not stop the others.
- **A page keeps its own keys.** A page or popup with the keyboard gets them
  on its own web contents, so a key rule on the window's, or in the renderer's
  keydown, never hears them. Main takes the app's chords
  (`forwardedShortcutFor`) from each page (`forwardGuestShortcuts`) and sends
  them on `browser:shortcut` to `useKeyboardShortcuts`; a popup closes itself
  on ⌘W (`popupWindows.ts`), and pages and popups share their window's ⌘Q
  guard (`createQuitShortcut`, `shareQuitGuard`). ⌘W closes a browser tab only
  with the keyboard in the browser (`closeShortcut.ts`): a page's ⌘W arrives
  with its tab, and the window's own counts when focus is in the panel, over
  a page or in the toolbar's menu (`keyboardPlaceOf`). After a close the
  keyboard stays in the panel (`browserPanelFocusStore.ts`), so the next ⌘W
  closes the next tab, and with no tab left it closes nothing. A new
  window-level shortcut must join the forwarded set, or be attached to pages
  and popups, or it is dead in a page. A key taken for the app is still the
  person's input on the tab.

### Agents Use Pages Without Taking Them

An agent uses its session's tabs through the `consola_browser_*` tools, plain
MCP tools, so nothing branches on a driver id; the tabs are the session's, so
a harness switch leaves them alone.

- **Tool authority comes from the endpoint.** The tools are on the session's
  own MCP server (`buildSessionServer`, `browserTools.addTo`), so the caller
  is the session bound to the socket, never an argument, and a tool reaches
  only its tabs (`CallerAccess.tab`). The socket and its token are in a file
  any process of the person's can read, so this boundary, between sessions
  and between a workspace with agent access on and one with it off, holds
  against mistakes, not against an agent with a shell that goes looking.
  `browserRefusal` is the one access rule: no tools for a read-only session
  or a workspace with agent access off. The server is built when the CLI
  connects, so turning access on reaches a session at its next start; every
  call asks again, and again once the page answers (`stillAllowed`). An
  agent's navigation goes through `BrowserService` by the person's address
  rules, never Playwright's.
- **Playwright drives one page, in process.** `PageDriver` hands
  `playwright-core` a `CdpRelay`, a `ConnectOverCDPTransport` over the guest's
  `webContents.debugger`. Nothing listens on a port: never
  `--remote-debugging-port`, which would expose every window, and never a
  WebSocket. Chromium answers a page's CDP session for the whole app, so
  `cdpRelayProtocol.ts` is the wall, an allow-list: a command it does not
  name (`FORWARDED_COMMANDS`) is refused, and logged. Within it: one page and
  nothing past it (other targets, every site's cookies, where downloads go),
  no files for the page, no bringing it to front or closing it, no address
  but http or https. It also swallows Playwright's focus emulation (main's,
  on only while an act runs) and hides a held dialog from it (it would
  dismiss it at once). When Playwright needs a command, ask what it reaches
  first; never widen the list just to make Playwright work.
- **A page cannot fill main's memory through an agent.** Page text main keeps
  (a console error, a dialog's message) is a copy (`cutCopy`), never a slice,
  which keeps the whole original alive. An agent's connection has a budget
  in events and size (`relayBudget`); past it the relay closes the connection.
- **Agent input never takes the person's keyboard or the window's focus.**
  Chromium sends a guest's CDP keys and text to whatever the window has
  focused (the terminal, say), and a CDP press would focus the page in the
  window and count as the person's. So the relay refuses all `Input` but a
  buttonless mouse move or wheel (`inputRefusal`), and acts click and type in
  the page with synthetic events (`pageInput.ts`, whose functions run in the
  page and use nothing from the module, not even a constant); a page that
  insists on a real press may ignore them. An agent's script carries no user
  gesture (`withoutUserGesture`), so it opens no file chooser or fullscreen,
  and a popup window needs the person's press (`decidePopup`). Nothing an
  agent does opens the panel or focuses the window or the page's web contents;
  an act's in-page `focus()` moves only the page's focus. Its tabs open behind
  the one showing; its use marks the tab and the globe button.
- **The person comes first.** Their input on a tab (`PersonInput.noteInput`)
  is a key or button going down in its page, or a move or answer they make
  from Consola's controls (`personNavigated`: an address, back, forward,
  reload, "Continue anyway" past a certificate, a sign-in answered or
  cancelled), never the window's automatic retry, a timer on a channel of its
  own that records nothing. An act, evaluate, move or close gives way for
  `PERSON_INPUT_GUARD_MS` after it (`giveWay`), which must outlast the user
  activation a real press leaves, or the agent's script could spend it. A tab
  is in its opener's hands until the other takes it: the agent by moving it,
  acting or evaluating on it, answering its dialog, or a call that has to load
  its page (`noteAgentUse`); the person by their input. A download is decided
  in this order (`downloadRefusal`): none from a tab in the agent's hands;
  none while a save dialog already waits in the session; the person's input
  on the tab within the guard pays for one; else the session gets one
  uninvited download until the person's next input on any of its tabs. A tab
  its page opens is the person's, and shown, after their input on the opener
  within the guard; else it opens behind, the agent's if the opener is in the
  agent's hands, was opened by one, or has a call on it (`placePopupTab`). A
  new tool or control that moves a tab, acts or answers on it, or loads its
  page for an agent must record one or the other, or downloads go by the
  wrong hands, or an agent acts over the person; looking takes nothing.
  DevTools open on a page shuts the agent out.
- **Page content is untrusted.** A page can carry text written to instruct the
  agent, and the agent has a shell. Every answer with page text opens with
  `UNTRUSTED_NOTE`, and each string the page chose stays on one line
  (`quoted`), so it cannot pose as Consola's. What an in-page function
  returns is the page's to shape, so main validates it before wording an
  answer (`readFillOutcome`).
- **A dialog is held for the agent, not shown** (`PageDialogs`), only while
  `shouldHoldDialog` allows: the session may use the browser, an agent is
  connected, the person gave no input on the tab within the guard, and the tab
  is in the agent's hands or off screen. A press in the tab hands it to the
  person; the connection ending, or `DIALOG_HOLD_MS` (60 s), dismisses it. It
  rests on Electron's internal `-run-dialog` event: unless `takeOver` finds
  exactly one listener, it warns and leaves the page to native boxes. On a new
  Electron, check by hand first: raise a `confirm()` on an agent's tab in a
  normal run and see no `takeOver` warning logged, no box while the agent
  holds the tab, and a press in the tab hand it to Electron's box. Only then
  rely on the held confirm in `tests/e2e/browser-agent-safety.spec.ts`, which
  stops on a new Electron major until the check is done and
  `DIALOG_TAKEOVER_VERIFIED_ELECTRON_MAJOR` (`screenGuard.ts`) is moved to it.
  Its screen guard (`keepOffScreen`) swaps the listener for a recorder only if
  it finds exactly one, and otherwise stops the test before any dialog
  (`expectOffScreen`). It cannot see Electron also show dialogs another way
  (nothing asserts on a box on screen), nor what Electron's listener does with
  a dialog handed back, which the recorder stands in for.

### Each Workspace Remembers Where It Was Left

Switching workspaces returns to the view that workspace was last on, rather
than the blank composer. A "view" is the pair `(activeSessionId, overlay)`
— exactly what `MainContent` routes on. Both travel together because opening
the Inbox or Automations does not clear the session: either overlays the pane
while the session keeps running behind it, so remembering one without the
other loses half the answer.

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
`WorkspaceService.replaceConversation` — one of the field's two writers,
which is why it is absent from `allowedSessionUpdates` — and
`TerminalService.startFreshConversation` moves the live terminal onto it.
Tab, harness, model, tool policy, checkout and linked item all stay. The
other writer is a harness switch (`WorkspaceService.switchHarness`), which
replaces the conversation and the harness together. Do not
reach for typing `/clear` instead: the Claude driver does not follow a
conversation change made inside the CLI, so the record would keep naming
the old conversation and the next relaunch would resume it.

### Session Names

Only a session still called `NEW_SESSION_NAME` is named automatically: not one
with `nameIsUserSet`. Everything Consola names itself is
born with another name, so a name anyone chose is never a candidate.

Main's `SessionNamer` is the only automatic writer. It writes a stand-in from
the first message (`readFirstPrompt`), then a generated title, each by
compare-and-set through `updateSession`, so any rename in between wins. A
generated name never sets `nameIsUserSet`; only Regenerate replaces a typed
name. A name given inside the CLI is adopted as user-set (`readCliNameSince`),
but only a change after the first read counts: a fork's inherited title is a
baseline, never adopted, while a brand-new session still called "New Session"
starts with an empty baseline.

The title call is one throwaway non-interactive call (`generateText`) from the
home directory, with no tools, no hooks and no persistence. It is never a
session, and nothing is typed into a terminal to obtain a name. While a
session's inline rename field is open its sidebar row stays where it is: a row
that changes list remounts and would lose the field (`renamingStore`, `pinHold`
in `renderer/sidebar/openRowHold.ts`).

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
as `Session.agentCwd` (`WorkspaceService.recordAgentCwd`, its only writer; a
harness switch only clears it, since the new process reports for itself).
`checkoutPathForSession` prefers it, so every git view follows the agent.
Launching never does: spawns still start in `cwd`, and the CLI reports again
from there.

Whether a folder *is* a worktree is asked of git (`readCheckout`, cached per
folder in `checkoutStore`), not inferred from the record: a scope can itself
be a worktree. The header's checkout chip and the sidebar's worktree line read
that one answer, so they cannot name different branches for one session.

### Worktrees Are Removed, Sessions Stay

Consola removes its own worktrees (direct children of
`~/.consola/worktrees`, `isManagedPath`) when their work is done, by rules
the person turns on: a finished pull request, a session settled for N days,
an automation run that ended, or deleting the session. Every rule is off by
default, globally (`Preferences.worktreeCleanup`) and per workspace
(`Workspace.worktreeCleanup`: absent inherits, `off`, or `custom`). Agents
reach the same removal through `consola_cleanup_stale_sessions` and
`consola_delete_session` (`SessionCleanupService`), which keep their contract
and always delete the session.

- **One decision function.** `worktreeCleanup/policy.ts` `judge` decides
  every removal, for every caller — the sweep, Preview, the delete dialog,
  "Clean up now", the MCP tools — from facts `FactGatherer` reads. It does no
  IO, and any fact that is missing or unreadable keeps the worktree. Only
  `WorktreeExecutor` touches disk, and it judges again, from fresh facts,
  under the folder's lock first. Never `--force`: git's refusal of a dirty
  tree is the last guard. Main writes every sentence a verdict carries; the
  renderer shows them and never interprets a reason.
- **What keeps a worktree** is listed once, in `treeBlockers` and
  `userBlockers`: anything uncommitted, unpushed, hidden from `git status`
  (skip-worktree, assume-unchanged), ignored with no identical copy in the
  main checkout (rebuildable folders like `node_modules` excepted), a nested
  repository, a lock, a process still running in it (`lsof`; unreadable is
  unknown), a session on it that is working, waiting, held by a run, open in
  a window or active within the hour, and any other session still using it
  through `cwd` or `agentCwd`.
- **The session stays.** For the sweep's rules the session keeps its
  record and `cwd`; the executor writes `Session.removedWorktree` on every
  session of the tree (`WorkspaceService.recordWorktreesRemoved`, its one
  writer with `clearWorktreeRemoved`) and a keep-ref,
  `refs/consola/worktrees/<folder>`, at HEAD in the clone — record before
  removal, so a crash leaves a record over a folder that still exists, which
  the rebuild reads as "exists". The keep-ref is what keeps the commit: a
  pull request's checkout can be detached, or its branch reset by a later
  checkout, and gc drops what nothing references. It goes after a rebuild,
  and when the last session naming the folder is deleted.
- **A rebuild uses the same path and the recorded commit**
  (`WorktreeRebuilder`, `WorktreeService.restore`), with git hooks off. Never
  `ensureWorktree`, `refreshPullRequest` or the provider's checkout: those
  move to a pull request's latest head, and Claude trusts a folder per path,
  so a full-tools session rebuilt onto commits it never saw would load their
  hooks and settings with no trust prompt. Every spawn of a recorded session
  rebuilds first (`TERMINAL_CREATE`, `TERMINAL_RESTART`, the shells,
  `SessionLauncher.resolveFolder`), and the pane says so (`launchNotice`).
  `checkoutPathForSession` answers `undefined` while a worktree is removed.
- **Only the rebuilder recreates a folder a record names.** `ensureWorktree`
  hands such a path to it (`restoreRemoved`) before anything else, so an
  Inbox click or an automation run lands on the recorded commit rather than
  recreating the folder at the latest head under an already-trusted path.
- **One lock per folder** (`PathLock`, keyed by real path): removal, rebuild,
  `ensureWorktree`, `refreshPullRequest` and a new session's checkout all take
  it — a per-item chain outside, the path lock inside. A folder just handed
  out counts as in use for ten minutes (`recentlyPrepared`), covering the gap
  before the session that will use it is recorded.
- **Branches.** A rule that keeps the session keeps the branch, so the
  session can be rebuilt. Deleting a session deletes only a `consola/*`
  branch or one whose pull request is finished, compare-and-swap at the
  commit that was checked.

### Never Type Into a Confirmation Menu

Queued prompts are delivered only when the emulated screen shows an *empty*
composer and no confirmation markers (`CONFIRMATION_MARKERS`). Claude shows a
workspace trust gate on first launch in an unfamiliar folder, and typing into
it would answer it. Any future automated input must respect the same guard.
A harness switch's handoff prompt does: it is queued like any first prompt
(or passed as an argument to a CLI that takes one), so a target harness that
has never trusted the folder asks first, and the person answers.

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

A Consola tool marked `fullToolsOnly` is never offered to a read-only
session. And whatever `save_automation` writes or replaces gives up the
entry's acceptance, so it asks once before its next unattended run — even
when only its schedule changed, which a hand edit would not ask about.

An automation's run on a work item refreshes an existing worktree to the PR's
latest head only because its session is read-only. Claude trusts a folder per
path, so refreshing one the person already trusted would load the author's
newly pushed settings and hooks into a full-tools session with no trust
prompt. The worktree is one per item, so the refresh is skipped while any
full-tools session was launched there, running or not (`worktreeHeld`).

### A Steps Run Works in a Checkout of Its Own

A `steps:` run on a pull request or issue never works in the Inbox's worktree
for it. It gets a second, detached worktree per item beside that one,
`<repo>-pr-<n>-automation` (`WorktreeService.automationCheckoutPathFor`),
reset to the item's head each time a run prepares it. Nothing is reset until
`assertOwnAutomationCheckout` proves the folder is that linked worktree of the
clone (not a symlink, not the clone, not the Inbox's worktree): a reset
anywhere else would destroy someone's work. Once a full-tools session was
launched there, running or not, Consola never moves it again, for the same
reason an automation's refresh leaves a trusted worktree alone (above).

An agent step's tools (`steps/stepTools.ts`) are scoped by the calling
session's provenance (run, step and attempt), resolved again on every call and
never taken from a tool's arguments. Writes are refused once that attempt is
not the step's running one, or the step recorded a different session.

A `run:` step's command gets values only as environment variables: `{{` is
refused in `run:`, and `env:` refuses the names and prefixes that make a
program run a value (`REFUSED_ENV_NAMES`, `REFUSED_ENV_PREFIXES`). Its intent
(`intentAt`) is written durably (`RunStore.updateDurably`) before the spawn, so
a quit mid-command is known after a restart. Such a command is never re-run
automatically: the restart fails it as interrupted, and Retry warns before it
runs again.

### Harnesses Are Launch Descriptions

A harness is one configured agent CLI: a binary path, a config directory, and
extra arguments. Consola coordinates CLIs rather than embedding them, so a
harness never holds a credential — pointing one at its own
`CLAUDE_CONFIG_DIR` is what gives it a separate login, history and transcripts.

Everything CLI-specific lives behind `HarnessDriver` (`src/main/drivers/`).
Supporting another CLI means adding a driver and registering it; nothing in
`TerminalService`, `ipc-handlers`, or the renderer should branch on a driver id.

Two invariants are load-bearing:

- **A session's harness is fixed for its conversation.** The transcript is
  written inside that harness's config directory, and `--resume` only finds it
  there. A session's model is fixed the same way and for the same kind of
  reason: it is replayed on every relaunch, so a later edit would move a
  conversation onto a different model part-way through. Both are kept immutable
  by being absent from `allowedSessionUpdates`, not by validation. So is a
  session's `toolPolicy` (`read-only` for every session an automation
  starts): main replays it from the record on every launch, `TERMINAL_CREATE`
  included, and each driver enforces it with its CLI's own flags or refuses to
  launch. The one way the harness and model change is a harness switch (see
  below), which gives the session a new conversation on the new harness in
  the same move; the tool policy survives a switch unchanged.
- **Deleting a harness archives it.** The record has to outlive removal, or
  every conversation started under it would resume against the wrong profile.

A harness that pins nothing resolves exactly as Consola did before harnesses
existed, ambient `CLAUDE_CONFIG_DIR` included. Keep that true: it is what the
built-in harness and every migrated session rely on.

### Switching a Session's Harness

A session can carry on with another harness in the same tab — a harness
that hit its usage limit, another CLI taking over (`harnessSwitch/`). The
conversation travels the best way the two drivers allow, and
`planHarnessSwitch` is the only place that decides, from which optional
driver methods exist — never from a driver id:

- **Native**, between harnesses of one driver whose CLI can fork:
  `transplantConversation` makes the conversation findable under the target
  (Claude copies the transcript and its sibling folder into the target's
  identically named project folder, never overwriting), then the target
  launches with `forkFrom`. Nothing is lost. The copy is verified before
  anything changes, since a fork of a missing file fails. A driver offering
  transplant must honour `forkFrom` (contract test in `toolPolicy.test.ts`).
- **Handoff**, across CLIs or within one that cannot fork: the source
  driver's `readConversation` is rendered to a markdown document under
  `<userData>/handoffs/<session id>/` (removed with the session, since later
  handoffs point back at earlier ones), and the target starts a fresh
  conversation whose opening prompt says to read it. Tool output is not
  carried, and the prompt says so.

A conversation that is there with nothing in it carries nothing, and the
target simply starts fresh. One whose transcript cannot be found is refused,
never taken for empty: a session that ran somewhere its harness record does
not point would otherwise come back blank, as if its history were lost. The
renderer and main translate a harness into launch fields with the one
`launchFieldsFor` (`shared/harness.ts`) for the same reason — a built-in
harness given its own config folder keeps its conversations there, and every
reader has to look there too.

`WorkspaceService.switchHarness` is the one writer of `harnessId`; the record
it leaves is `switchedSession`'s. It moves `claudeSessionId` with the harness,
drops `model` (a selector belongs to its harness) and `agentCwd` (the old
process's report), keeps `toolPolicy` — a target that cannot enforce it is
refused — and records what was left in `priorConversations`, each link naming
the conversation that took over (`continuedAs`). A handoff pins the name,
because a summary of the new conversation would describe the handoff.
`TerminalService.switchHarness` moves a live terminal in place, like
`startFreshConversation`: the instance, its pane and listeners stay, while
what attention knew of the old process is forgotten — a CLI without hooks
would never clear a held turn. The switch is refused mid-turn, but not at a
menu: a usage-limit notice is where it is wanted, and the switch stops that
process rather than answering anything. Conductors stay on their harness.

Claude writes a forked conversation only once its first message is sent, so
a switch nobody has spoken after yet leaves a conversation that is not there
to resume. Resuming still asks Claude first; when the resume fails, the
fallback that would start blank instead opens the conversation the way the
switch began it — the same fork, or the same handoff prompt
(`switchOpening`/`openingFor`, passed as `TerminalServiceOptions.opening` by
every launch path).

`HarnessSwitcher` orders it so the record never names a conversation nothing
started: everything that can refuse, or only writes artifacts nothing names
yet, comes first; then a live terminal is checked and moved right after the
record is written, while a session with no terminal is started on the target
first and its record written after.

### Hooks Add to the Screen, They Do Not Replace It

A driver with `attentionHooks` (Claude's) registers hooks through `--settings`
that POST to a loopback endpoint main owns (`attention/AttentionEndpoint`,
random port per launch, random token per terminal). They are one more input to
`deriveAttention` via `HookSignals`, never a status: the screen heuristic stays
as the fast path and `CONFIRMATION_MARKERS` must stay. Claude's
`permission_prompt` notification lags about six seconds and `idle_prompt` about
sixty; no hook fires at all until an interactive session's folder is trusted,
which is the trust gate's moment. What hooks add is what the screen cannot
show — a question that is no known menu (`PermissionRequest` fires on
AskUserQuestion within a model turn), a subagent waiting. Branch on
`notification_type`, never on message text. A `Stop` listing `background_tasks`
is a paused turn, not a finished one — counting only tasks still `running`, and
only for `BACKGROUND_HOLD_MS`, since the payload cannot tell awaited work from a
dev server. Running `subagent` tasks are the exception: Claude waits on them
and takes a turn on each result, so the session reads `working` until a later
`Stop` reports none, with no bound. Only a `Stop` (or exit) ends the hold, never
a `working` edge: while Claude waits, its spinner stops but the agents panel
repaints about once a second, which the screen reads as turns. The OS notification follows the derived attention, not terminal status. Hooks use HTTP, not `mcp_tool`: a
Notification hook does not wait for an MCP server still connecting.

### Attention Reads a Steadied Status

`TerminalService` infers `working` from output flow: right for delivering a
prompt, too twitchy to file a row by. Everything that decides attention
(`SessionSource`, `TurnActivity`) hears `SteadyStatus` instead, which holds
back the two changes that are usually noise: a `ready` inside a turn
(`DROP_HOLD_MS`) and a `working` after the CLI said the turn was over
(`UNTURNED_WORK_MS` — a background agent's tool calls paint in bursts the
screen reads as turns). `HookInputs.turn` says which side of a turn a change
is on; without hooks only the drop is held. `needs-attention` and `exited`
are never delayed, and prompt delivery and the renderer's terminal status
still read the terminal's own.

A row sits in the section its attention says, the open row included: pinning
a stopped row under Working made the section state something false. The
sidebar's own softening is the same for every row (`workingExits`, the shift
guard).

A menu is looked for when output pauses, and again shortly after the person
types into one (`ANSWER_RECHECK_MS`): a turn that goes on after its answer
never pauses, so without that it read as waiting on the person to its end.

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

### Snooze Is Derived in Main, and Never Hides a Question

A snooze is four ledger fields (`snoozedUntil`, `snoozedAt`, `snoozeReason`,
then `wokeAt`/`wakeCause` once it ends), not a field on `Session`: a click must
not fsync the workspace list. `deriveAttention` reads `snoozed` from them and
the clock, beating every status except an open run that holds the session.
The renderer never computes it; snooze views ride the attention push
(`AttentionChange.snoozes`), so windows cannot disagree.

`Snoozer` (`main/attention/Snoozer.ts`) is the only writer of those fields. It
snoozes a conductor's whole tree (only a root is offered), and runs one timer
through `armAt` (`wakeTimer.ts`), which hops at most a day, because a
`setTimeout` past 2³¹-1 ms fires at once. Every main timer for a wall-clock
time goes through `armAt`, and is re-checked on `powerMonitor` `resume`. A
snooze that ran out while Consola was closed wakes at startup, before the
first auto-settle sweep.

A snooze can never hide a new question. `SessionSource` calls the Snoozer on
every edge into `needs-attention` (screen or hook) before anything derives, so
the wake is written first. A question already open when the person snoozed
stays snoozed ("ask me later"); an agent may not snooze one at all. Finishing
work, opening the session, a queued prompt, a paste and an agent's prompt
never wake it. Only the person's keys on `TERMINAL_INPUT` do: Enter,
or a key pressed at a question that then goes away. Snoozing never touches a
PTY, and nothing is ever typed at a wake.

Undo restores only the fields an action wrote (`seenAt` and the shelving
fields), never `lastActiveAt` or `finishedAt`: a snoozed session keeps
working, and a whole-record restore would erase a finish written in between.

### Usage Limits Are Asked of the CLI, Never Guessed

Two questions, kept apart. *When did this session stop on a limit?* comes from
the session: a `turn-failed` hook with `limit` (Claude's `StopFailure`), or the
CLI's own notice on screen (`UsageLimitReporting.showsLimitNotice`, given the
raw screen text because notices are matched at a line's start). *When does it
reset?* comes only from the harness's CLI (`UsageLimitReporting.read`: Claude's
`get_usage` control request, Codex's `account/rateLimits/read`), through
`HarnessLimitsCache`, keyed like capabilities. A notice limits nothing until
the CLI confirms a used-up window that binds the session, since the agent may
have printed those words itself. No session lends another its reset.

One rule reads every CLI's windows (`shared/usageLimits.ts`). An answer the
mapper does not recognise throws, and a used-up window with no time leaves no
time, never a guessed one: waking a session into the same limit only stops it
again. `UsageLimitService` decides when to offer an automatic snooze (answer
in, terminal at rest, reset over a minute away, once per stop); the Snoozer
decides whether, and never replaces a time the person chose. A driver reports
limits by adding the `usageLimits` capability; the contract test
(`drivers/usageLimits.test.ts`) needs its fixtures under
`drivers/__fixtures__/usage-limits/<driverId>/`.

### Claude's Own Storage

`ClaudeSessionIndex` reads transcripts under `$CLAUDE_CONFIG_DIR/projects`
(falling back to `~/.claude`) — always honour that variable. Locate files by
probing each project directory for `<sessionId>.jsonl`; the directory-name
encoding is lossy and cannot be derived from a working directory. The
transcript is authoritative and `sessions-index.json` is a cache that lags.
The one write is `copyConversation`, for a harness switch: into another
config directory, under the source's own project-folder name, never over
anything already there.

### IPC Channels

All channel names are defined in `src/shared/constants.ts`. Key patterns:
- `terminal:*` - Session terminal lifecycle and events
- `attention:*` - Derived attention, settle, snooze and wake (batches are one write, one memento)
- `usage-limits:*` - Which sessions stopped on a usage limit, pushed whole
- `harness:*` - Harness health probes and capabilities, dispatched by driver
- `file:*` - File operations
- `git:*` - Git status and commit message generation
- `dialog:*` - Native dialogs
- `worktree-cleanup:*` - Cleanup preview, "Clean up now", history, and a deleted session's outcome
- `browser:*` - In-app browser tabs, page actions and snapshots; every id is checked against the sender's workspace

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

Direction (where the product is heading, not a spec) lives in `docs/north-star/`.
`docs/` is gitignored, so it exists only in the main checkout; from a worktree,
read it there.
- `docs/north-star/consola-automations.md` - **The north star for automations**: CI-shaped pipelines defined in files, run by desktop, headless and cloud runners. Read its invariants and decisions before designing anything that touches automations, triggers, connections, runs, agents, factory files, environments, runners, or sharing across an org
- `docs/north-star/consola-automations-roadmap.md` - The slice order toward that north star, what each slice delivers, and the contracts each slice must leave true for later ones. Read a slice's entry and its contracts before writing that slice's spec
- `docs/north-star/consola-factories.md` - The earlier local + cloud direction ("factories"). Its cloud runner, identity and Run record still stand; its "no workflow engine", "confirm every run" and "org ⊕ repo merge" rules are superseded by the automations north star

The automations direction in brief:
- An automation is a trigger plus steps, all in YAML/Markdown files (`factory.yml`, `agents/`, `automations/`, `skills/`, `environments/`). Nothing only the UI can express.
- The file decides the route (`if`, `repeat`, `wait`, `gate`). An agent affects it only through declared, schema-validated outputs, never through prose.
- Every agent step is a new session, so each starts with a clean context. Only three things cross to the next step: typed outputs, declared artifacts (documents written and read through Consola's artifact tools, with the handover as the default one), and the shared checkout.
- The files name every side effect, and Consola implements none of them. A push, PR, review, ticket move or Slack post is a `run:` command (a vendor CLI such as `gh` or `acli`), an MCP tool the engine calls (`uses:`), or an agent granted write tools in its definition. Item values reach commands only as environment variables. How strongly an agent with a shell is contained is its environment's declared isolation (`host`, `sandbox`, `container`), never silently downgraded.
- Triggers are generic, `poll` (a command or MCP tool diffed by key, firing again when a declared `changed:` value moves) and `webhook`. Built-in vendor events are YAML manifests over them, not vendor code. Any automation on items can also be run on an item a person picks. Agents name MCP servers, which resolve in the harness's own CLI config.
- Trust is approved per definition version; after that a run is unattended except at gates the file or org policy declares.
- A run is a durable row anchored on an item. A write or `uses:` step is never silently repeated, and a change to an item is delivered at most once, never silently. A run on a pull request works in a checkout of its own and records the commit it read. A step can read what the last run on the same item wrote (`previous`).
- The same files run on every runner. Across an org, factories share by pinned `uses:` references, and only policy flows down.
- Agent files are harness-neutral requirements (tools, MCP server names, skills, outputs, isolation). Each `HarnessDriver` compiles them into its CLI's flags or refuses, and the refusal is checked when the factory applies, never mid-run. Anything Consola reads back (artifacts, outputs) goes through Consola's MCP tools, which every CLI speaks.
