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
pnpm test                 # Every Consola package's tests via Turborepo (the website's Playwright suite included; not vendor/)
pnpm run test:vendor      # The copied t3code packages' own tests, as CI's vendor job runs them (Linux)
pnpm run typecheck:vendor # The copied t3code packages' own typecheck, as CI's vendor job runs it
pnpm --filter @consola/automation-engine test   # Just the engine's tests
pnpm run lint             # Biome, then Oxlint (lint:oxlint), as CI's lint job runs them
```

Linting is two tools, and each check runs in one of them. Biome formats,
lints CSS and owns accessibility (`biome.jsonc`). Oxlint owns JavaScript and
TypeScript linting with Cloudflare's preset (`@cloudflare/oxlint-config`, in
`oxlint.config.mts`), whose type-aware rules read the real types through
`tsrs`. Where both have a rule, Biome's is off when its own rule sources call
Oxlint's the same rule and Oxlint runs it as an error everywhere Biome lints;
Biome keeps the rest, including those Oxlint leaves to TypeScript in `.ts`
files, and Oxlint leaves accessibility to Biome. Those rules read the workspace packages' types from their `dist/`, so
`lint:oxlint` builds the packages first: run bare `oxlint` without them and
every import from one is `any`, which the `no-unsafe-*` rules then report. A
rule of the preset that stays off says why beside it in the config, and a
rule turned off for one line names itself and its reason
(`// oxlint-disable-next-line <rule> -- <why>`): an unused disable fails the
check. A rule that is right here but has a backlog warns (the Rules of React,
unsafe type assertions, non-null assertions in the desktop and the engine,
nkzw's quality rules), each with a Linear issue to clear it; CI runs Oxlint with `--quiet`, as it
runs Biome at error level, so warnings show in the editor.

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

No desktop unit test can find or start your own agent CLI: vitest's
`setupFiles` (`src/main/drivers/realCliIsolation.setup.ts`, which needs
`pool: 'forks'`) gives each test process an empty home and config dirs, a
plain login shell and a PATH without `claude`, `codex` or `agy`. Where one is
installed in `/opt/homebrew/bin` or `/usr/local/bin`, or sits on the login
shell's PATH (`/etc/paths`, `/etc/paths.d`, `/etc/profile`), no home or PATH
hides it, so the suite refuses to run and names the file to move.

All commands above run from the repository root. The pnpm workspace contains
`apps/desktop` (`consola`), `apps/website` (`@consola/website`),
`apps/cloud-api` (`@consola/cloud-api`), `apps/cloud-web`
(`@consola/cloud-web`), `packages/factory-spec` (`@consola/factory-spec`,
MIT), `packages/automation-engine` (`@consola/automation-engine`),
`packages/sandbox` (`@consola/sandbox`), `packages/runner-protocol`
(`@consola/runner-protocol`, MIT), `packages/host` (`@consola/host`, AGPL),
`packages/agent-ui` (`@consola/agent-ui`, MIT), `packages/cloud-session-e2e`
(`@consola/cloud-session-e2e`, a cloud session end to end: the built cloud
app, a runner on local sandboxes and t3's client, with no credential) and the copied
t3code packages under `vendor/t3code/` ("Vendored t3code", below). Turborepo
orchestrates builds, tests, and typechecking; the root runs leave `vendor/`
out. Paths below beginning with `src/`, `scripts/`, or `dist/` are relative to
`apps/desktop`. Use `pnpm --filter consola exec <tool>` for app-specific
tools.

Tooling runs on one exact Node version, named in three places that move
together: `engines.node` (which Vercel reads), CI's setup
(`.github/actions/setup/action.yml`) and the release build. Pin
an exact version, never a range: Vercel resolves a range to the newest major
it offers, so a range can move the website onto a new Node unannounced.
Node 26 ships without corepack, so `vercel.json`
runs pnpm through `npx pnpm@<version>`: keep that version equal to
`packageManager`. Electron bundles its own Node, so none of this changes the
app's runtime.

`.env` files are gitignored, so a new git worktree has none, and an app that
needs one (`apps/cloud-api/.env`, say) will not start there. `pnpm install`
fixes that: its `postinstall` (`tools/link-worktree-env.mjs`) links every
`.env` and `.env.*` the main checkout has, at the root or in a package's
folder, into the worktree, as symbolic links to the main checkout's files. It
never replaces a file that is there, links only what git ignores, and does
nothing in the main checkout, in a plain clone (CI) or outside git. Run it by
hand with `pnpm link-env`. A relative `pglite:` `DATABASE_URL` then gives each
worktree a database of its own.

### CI

CI (`.github/workflows/ci.yml`) runs a pull request's checks only where its
change can fail them. `.github/scripts/ci-scope.mjs` asks Turborepo which
packages the change affects (`turbo ls --affected`: the changed packages and
every package that depends on them), and each job runs for those alone, so
a change to one cloud app never starts the desktop's macOS jobs. A new
workspace package gets its own job without the workflow naming it, except
under `vendor/`: the copied t3code packages are checked together, with their
own scripts, in the `vendor` job. `@consola/agent-ui` has a job of its own,
like the website, for its browser tests and the checks of its built library.
The script also holds four rules the package graph cannot see:

- A change to the desktop checks the website too, because the site's demo
  imports the desktop's renderer by path, not as a dependency.
- A change to the desktop's or cloud-web's CSS that `@consola/agent-ui`'s
  page tests read as files (`src/testing/embeddingPages.ts`: the desktop's
  `global.css` and theme tokens, cloud-web's `ui/styles.css` and
  `ui/Sessions.css`, and the Radix Themes stylesheet its `package.json` or the
  lockfile installs) checks
  agent-ui too. `ci-scope.test.mjs` fails when that module reads a file the
  rule does not name.
- A change to CI itself, the root `package.json`, `pnpm-workspace.yaml`,
  `turbo.json` or `patches/` checks everything.
- A push to main checks everything.

`CI`, the workflow's last job, is the one status check the main branch's
ruleset requires. It passes when every job it waits on passed or was
skipped. Desktop E2E runs but does not block a merge yet, because main has
known failures. CodeQL (`codeql.yml`) and a dependency review run on every
pull request, and the lint job checks every installed dependency's licence
(`.github/scripts/check-licenses.mjs`).

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

### Sandboxes

`packages/sandbox` (`@consola/sandbox`, AGPL-3.0-only) is the one interface
every runner uses to start and drive sandboxes: create one from a template,
with a lifetime, run a command and stream its output, read and write files,
expose a port, stop it, and reach it again by its id from another process.
E2B is the first provider behind it (`@consola/sandbox/e2b`, an entry point
of its own), invisible to users. Code holds `Sandboxes` from
`sandboxesFrom(provider)`, which checks every request before a provider sees
it, and checks a capability (`pausing`, `snapshots`, `keepAlive`) by its
member, never by which provider it has. A sandbox's lifetime is a hard
maximum and the only thing that stops one whose runner died, so long work
renews it (`keepAlive`) rather than setting a long one. Its core does no
I/O, which its `boundary.test.ts` proves; every provider passes its contract
(`src/contract.test.ts`, against real E2B when `E2B_API_KEY` is set in
`packages/sandbox/.env`), and its in-memory `FakeProvider` is what other
packages' tests use. Before changing it, or adding a provider, read
`packages/sandbox/AGENTS.md`.

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

`apps/cloud-api` (`@consola/cloud-api`, Hono, Better Auth, Drizzle on PGlite
or Postgres) and `apps/cloud-web` (`@consola/cloud-web`, Vite and React) are
the company layer: Google sign-in, the workspaces people make, belong to
several of and switch between, and what a workspace holds (its teams,
factories, runs, GitHub connection and cloud sessions). The API is one app
with one database and one migration chain. Every workspace keeps its region
(`eu` or `us`) on its record, and every new workspace takes the deployment's
(`REGION`, `eu` when unset); no route moves one.

The app has two parts, each with its own domain, application and adapters
layers: `src/accounts/` (people, sign-in, sessions, workspaces and who is in
them) and `src/company/` (what a workspace holds, GitHub included).
`src/shared/` holds the regions and the workspace roles, which both use.
Only the composition ring (`src/*.ts`) imports both parts: `company` never
imports `accounts` or Better Auth, and `accounts` never imports `company`
(`src/boundary.test.ts`). The seam is there so that a later split stays a
data move, not a rewrite, and two rules keep it so, each a failing test
(`src/rules.test.ts`, with the boundary test):

- **Every company table carries its workspace id**, a not-null
  `workspace_id`. Only the accounts tables do not, each named in the test
  with its reason: `user`, `account`, `session`, `verification`,
  `organization` (the workspace registry, whose id is the workspace id),
  `member` and `invitation`.
- **Company data refers to people only by id.** No company table has a
  foreign key into an accounts table, no company column holds an email or a
  person's name, and no company file imports accounts' files or Better Auth.
  A name reaches a page only through accounts' own
  `GET /api/me/workspace/members`.

A company route takes who is asking from Better Auth's session cookie, and
the person's role from a live read of `member` on every request, through a
port `company` declares and `accounts` implements (`MembershipReader`). The
workspace is the session's active one, never the request's. Every company
request also carries `x-consola-workspace`, the workspace the page shows,
only as a guard: a page whose session another tab switched is refused (409
`workspace_switched`) instead of acting in the other workspace. Company
changes are authorised by the cookie, so they sit behind the origin check
(403 `bad_origin`) like every other change. The runner's socket
(`GET /api/runner`) is the one other trust root, for the POC until runners
are enrolled: a shared secret (`RUNNER_SECRET`), compared in constant time,
that admits one runner for one workspace and no person. The app signs each
session's pass with a key of its own (`PASS_PRIVATE_KEY`), and only
`company/adapters/token` imports `jose`; the runner's socket
(`company/adapters/runner`) may use `hono` and `@hono/node-ws`.

Nothing in `apps/desktop` depends on the cloud apps, and neither imports from
the desktop, the website, the other app or `packages/*`, with four
exceptions. `cloud-api`'s `company` part, and only it, imports
`packages/runner-protocol` (`@consola/runner-protocol`, MIT), what the app
and its runners say to each other: the runner socket's messages, the readers
of a repository and a harness, and the session pass's claims. It does no
I/O, so any layer of `company` may import it; before changing it, read
`packages/runner-protocol/AGENTS.md`. `company` also imports
`packages/factory-spec` (`@consola/factory-spec`), the factory files' schema
every runner shares, to check the factory files it stores; it does no I/O
either, so any layer of `company` may import it. `cloud-web`'s `domain`
imports it too, and only there (its `boundary.test.ts`), so a factory's
definition page checks the files as the person edits them with the very rules
the API saves them by. It holds no Node builtin, so it loads in a browser
(its `sha256.test.ts`). Last, `cloud-web`'s `ui` imports `packages/agent-ui`
(`@consola/agent-ui`, MIT), the chat a running cloud session's page mounts,
with its stylesheet, and only there, never in `domain`, `services` or a
test. Setup is in `apps/cloud-api/README.md`. Before changing a cloud app,
read its own `AGENTS.md` (`apps/cloud-api/AGENTS.md`,
`apps/cloud-web/AGENTS.md`): it holds the layer rules and the dependency rule
that keeps them apart.

**Every HTTP API a cloud app serves has a contract, and every client calls
it through types generated from that contract.** This holds for every route,
in every cloud app, a new app included:

- The routes are declared in Zod with `@hono/zod-openapi`, in the
  `adapters/http` contract of the part that serves them
  (`src/accounts/adapters/http/contract.ts`,
  `src/company/adapters/http/contract.ts`), with every status a route answers
  and its body (strict objects). Each part registers its routes with
  `app.openapi`, never `app.get`, `app.post` and the like, on the one app
  `compose.ts` hands it, and lists them in its routes list, which the app's
  `ROUTES` joins.
- The app's `openapi.json` is generated from them (`openapi:generate`) and
  committed. `openapi.test.ts` fails while it is stale, and while the app
  serves a route the contract does not declare (`OUTSIDE_THE_CONTRACT` names
  the exceptions, such as Better Auth's own routes, each with its reason).
- The app's HTTP suites check every answer they read against the route's
  schema.
- A client's types are generated from that `openapi.json`, which it reads as
  a file and never imports (`cloud-web`'s `domain/apiContract.ts`, by
  `api:generate`), and it calls the API only through an `openapi-fetch`
  client typed by them (`createApi`): `cloud-web`'s boundary test refuses
  `fetch` in its services.
- The package graph cannot see a file read across apps, so
  `.github/scripts/ci-scope.mjs` checks the client with every change to the
  API (`cloud-api` → `cloud-web`), and a new pair is added there.

`apps/cloud-api/AGENTS.md` ("The contract") holds the details and the
library's traps.

The browser talks only to the web app's origin. Vite proxies `/api` to the API,
so the session cookie is first-party and the API needs no CORS. Better Auth
owns sign-in and sessions, and its tables are generated
(`pnpm --filter @consola/cloud-api auth:generate`), never hand-edited.
Workspaces are Consola's own routes (`/api/workspaces`), with every route of
Better Auth's organisation plugin closed. A workspace is Better Auth's
`organization` row, whose id is the `workspace_id` every company table
carries, and a person is in it through `member`. A workspace is born whole:
its row, its owner's `member` row, its first team and the owner's place in
that team are written in one transaction.

`mayJoin` (`apps/cloud-api/src/accounts/domain/joinRule.ts`) is checked before an account
is created and before every new session. It is open for now (any Google
account with a verified email), so this deployment is for local use only. The
later rule that limits it to the company lands in `mayJoin` and so gates every
sign-in (sessions already open when the rule changes are not ended this
round). The web app's footer links to the source of the commit it runs
(AGPL §13).

### Agent teams (an experiment)

Beside the steps design, the cloud runs an experiment: a software factory led by
one agent, which deliberately breaks the north star's rule that the file decides the
route. A factory may hold an agent team (`agents/<name>/agent.md`,
`automations/<name>/automation.md`, `skills/<name>/…`, factory-spec's
`parseAgentTeam`), whose automations hand a pull request's event to one agent, the
orchestrator, which dispatches the others and posts the result itself. The cloud app starts
each as an agent run, a cloud session no person started, and records it as a
request in Runs whose conversation is that session
(`apps/cloud-api/AGENTS.md`, "Agent runs"); the host runs every agent of it in
full access inside its sandbox (`packages/host/AGENTS.md`, "Agent runs"). Nothing
in the steps design depends on it. Known gap: the sandbox holds the runner's own
git token and loads the pull request's own `.claude` settings, whoever opened it,
so a runner serves agent runs only on repositories whose contributors are
trusted.

### Vendored t3code

`vendor/t3code/` is t3code's packages and server files, copied byte for byte (MIT, its own
`LICENSE`). Never edit a copied file there or in `packages/agent-ui/src/t3/`; Biome ignores
them. A change that cannot be avoided, every file copied and every re-sync are recorded in
`vendor/t3code/UPSTREAM.md`, in the same commit. Two Consola packages build on it:
`packages/host` (`@consola/host`, AGPL), which runs t3's orchestration for one session and
serves t3's RPC behind a session pass, and in its runner role (`consola-host runner`) starts
sessions in sandboxes through `@consola/sandbox` (on E2B, from the `consola-session` template in
`packages/host/sandbox-template/`, which runs the host from a bundle that is never published),
speaking `@consola/runner-protocol` to the cloud app (the only two Consola packages it imports), and
`packages/agent-ui` (`@consola/agent-ui`, MIT),
t3's chat view behind `AgentChat`, which `cloud-web` mounts for a cloud session. Read each
one's `AGENTS.md` before changing it. The copied packages' own checks are not part of
`pnpm test` or `pnpm typecheck`: run
`pnpm run test:vendor` and `pnpm run typecheck:vendor` (CI's `vendor` job, on Linux, where a
few of t3's tests assume Linux and fail on macOS).

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
guest of an element that moves. So no page lives in the Browser tab, which
unmounts whenever it goes behind another tab, its group is hidden, the side
panel hides, or an overlay covers it, and remounts on every session switch:
`BrowserHost`, at the layout's root, holds every page of the window's
workspace in one parent, in creation order (`hostOrder`), and only ever adds
or removes one. The tab's slot only says where to draw. A page out of sight
is `display: none`, or painting but `inert` while an agent reads it
(`pagePresence`), never `visibility: hidden`, after which Electron 43 can
leave a macOS guest blank for good. DevTools open in a window of their own
(`mode: 'detach'`), so the page keeps its whole slot.

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
  `browserRefusal` is the one access rule: no tools for a session with a
  tool policy or a workspace with agent access off. The server is built when the CLI
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
  agent does opens the Browser tab or the side panel, or focuses the window
  or the page's web contents; an act's in-page `focus()` moves only the
  page's focus. Its tabs open behind the one showing; its use marks the tab,
  and sets the Browser kind's mark.
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

### The Side Panel Holds Tabs

Beside each session's conversation sits its side panel: one group of tabs,
or two, stacked or side by side. It is not the Automations overlay's own
side panel (`components/Automations/SidePanel.tsx`,
`.automations-side-panel`). Each tab is a kind (Changes, Files, Terminal,
Browser, Pull request) or the "+" list's placeholder (`NEW_TAB`). It is
view state, kept in the renderer, never on a `Workspace` or `Session`
record.

- **`sidePanel/tabKinds.ts` is the only list of kinds** (`TAB_KINDS`), and its
  order is canonical: the header's shortcuts, the "+" list and the palette
  iterate it, and a stored layout is repaired against it, so none of them
  lists kinds by id; code that means one kind (a chord, the palette's commit
  rows, a terminal link) names it. A kind is an entry there, its view in
  `TAB_VIEWS` (`components/SidePanel/tabViews.tsx`, a component per kind,
  keyed by every id, so a kind without a view does not typecheck) and, if it
  has one, its mark in `TAB_MARKS`. Whether a kind applies to the session is
  its own `availability`, read from `TabFacts`, whose `checkoutPath` is
  `checkoutPathForSession`'s: Changes, Files and Terminal are unavailable
  while the worktree is removed, and say why in their tab.
- **Every arrangement change goes through `sidePanel/layout.ts`.** Its
  functions are pure and return their input when an action does not apply;
  the store wraps each function that changes the layout in an action of the
  same name, and components change the layout only through those; the
  queries are called directly. The layout is a tree, so allowing deeper
  splits is a change of rule, not of format: `canSplit` is the one place a
  change checks the two-group cap (`MAX_GROUPS`). A stored layout from
  another build goes through `repairLayout`, which applies the cap to what
  storage holds, drops what it cannot keep (an unknown kind, a kind twice, a
  third group) and never throws.
- **The conversation's panel stays the unconditional first child of
  `ContentView`'s `Group`**, with the same key and no wrapper that differs
  between layouts. Opening, closing, splitting, maximizing or dragging in the
  side panel then only resizes the conversation; a remount would reattach
  its terminal at a captured size (see "Terminals Outlive Their Views").
  Each group's panel is keyed by its group's id, so a group that survives a
  split or unsplit is not remounted either.
- **A shell mounts only through `bodyFor`**: in front, in a visible group
  (`isInFront`, `visibleGroups`), and available. A kind with `mount: 'front'`
  renders nothing anywhere else, and Terminal is one, because its view
  attaching spawns the shell and main rebuilds a removed worktree first: a
  tab behind another, in a group Maximize hides, in a hidden side panel or
  for a removed worktree starts nothing. A shell takes the keyboard only on
  the person's own request (`takeFocusRequest`). `openKind`, `pressShortcut`,
  `bringToFront` and `choosePlaceholder` set a request only when the kind was
  not in front on screen before and is after; a launch, a session switch or
  a return from an overlay sets no request by itself, so keys meant for
  Claude never land in a shell. The "+" list takes the keyboard by the same
  rule. Under the Inbox or Automations the side panel's chords do nothing,
  and the palette leaves out the side panel's rows, so the two agree; a row
  the person runs there (the browser's, as on main) is their own action.
- **The side panel's own closes, and the chords that hide it, never drop
  the keyboard to the body** (`keyboardAfterClose.ts`). The palette's
  "Hide side panel" row is not one of them: run with the keyboard in a
  shell or a page, it leaves the keyboard on the body, and that is
  accepted. A close from the tab bar, with the keyboard on
  the tab or in what it shows, hands it to the tab now in front, else to the
  conversation (`keyboardAfterClose`). A tab closed from inside its own view
  (Changes' Escape, a view's own close button) or with the keyboard in its
  page, and a chord that hides the side panel with the keyboard in it or in
  a page, send it to the conversation's terminal (`keyboardToConversation`).
  Either way a held key's repeats stop at the window. An action taken from
  the conversation, the header or the palette leaves the keyboard where it
  is.
- **The Browser tab holds no page.** Pages stay in `BrowserHost` (see "Pages
  Live in One Place"); the Browser kind's view only claims the slot a page is
  drawn over, and only while mounted (`mount: 'front'`), so a tab behind, a
  hidden group or a hidden side panel never leaves a page drawn over the
  window. Its mark (an agent used the session's browser while no Browser tab
  showed it) is on its header shortcut while Browser is one of the three, on
  its tab while that is in a group on screen, and otherwise on the side panel
  toggle (`markPlaces`). `.side-panel-tab` is one of `BrowserHost`'s drag
  handles, so a tab dragged across a shown page does not stall. The drop
  target and the tab menu draw above the page's layer (`--z-browser-page`).
- **Layout, use counts and the setting live in `sidePanelStore`**, on
  localStorage (`consola-side-panel`), never in `Preferences`. The layout is
  written and read only while "Remember the side panel's layout" is on;
  otherwise the panel starts as one hidden group at every launch. The
  header's three shortcuts are the most used kinds, ranked once per run
  (`shortcutKinds`), so nothing moves under the pointer. Sizes live apart,
  in `useDefaultLayout`'s keys (the session pane, each orientation's groups,
  the Files tab), and are always remembered, whatever the setting. A
  `Group` inside the side panel mounts only once its box is laid out at its
  size (`useSized`): react-resizable-panels checks the saved sizes against
  the box as the group mounts, and one that mounts as the side panel comes
  on screen, before it is laid out, loses them and writes the loss back.

### The Info Panel States Facts

Between the conversation and the side panel sits the info panel
(`components/InfoPanel/`, `<Panel id="info-panel">`): where the session
runs, its branch and its pull request, said at a glance. Like the side
panel it is view state, kept in the renderer.

- **It is a glance.** Three sections in a fixed order (`INFO_SECTION_IDS`),
  where a later section joins. A row with more behind it opens a tab
  (`openKind`, or `reveal` for a place inside the tab's view, such as the
  pane's merge card, which the view acts on once per `revealRequest.seq`);
  the Folder row copies its path, and its card, on hover or focus, explains
  the checkout (its branch, the session's folder (the path the row copies)
  and a worktree's main checkout). Under it, "Open in" opens that folder in
  the app last picked (`settingsStore.openInFavourite`, else the file
  manager, Finder on a Mac), as ⌘O
  (Ctrl+Alt+O elsewhere: a bare Ctrl+O is the terminal's) does from
  anywhere in a session pane; its chevron lists the apps main found
  (`main/openIn/`, one table), and a pick there or in the palette becomes
  the favourite. Main opens only an app it found, on the real path an
  absolute one leads to (links and `..` followed), which must be a folder
  and not an app's bundle, with argument lists; a test run records instead
  of opening. No folder (a removed worktree), no button. Nothing in
  the panel navigates or takes the keyboard, on mount or otherwise.
  Visibility rides with the layout (`sidePanelStore.infoVisible`,
  written only under the remember setting, shown when absent); folds sit in
  `settingsStore.infoSectionOpen` and are always kept. While the side panel
  is open on a session pane narrower than `INFO_PANEL_ROOM_PX` (1026px: 60
  columns of conversation beside both panels and their two separators,
  `PANEL_SEPARATOR_PX`), the panel steps aside
  (`infoPanelShown`, `infoPanel/stepAside.ts`) without writing `infoVisible`,
  everything that asks whether it shows reads that answer, and its toggle
  shows it anyway until the side panel hides or the pane has room. While all
  three show on a pane with that room, the conversation's `minSize` is those
  60 columns (`CONVERSATION_ROOM_PX`, `conversationKeepsRoom`), else 20%: the
  panels give way before it, and a split saved while the person kept the
  panel on a narrow pane never restores it narrower on a pane that holds
  them. That leans on react-resizable-panels, which re-registers a Panel
  whose `minSize` changes and re-validates its remembered layout, and a saved
  one as it restores. A folded section
  renders neither its rows nor its heading's actions (`InfoSection`), so
  whatever they read never starts. Showing, hiding or resizing the panel
  only resizes the conversation, which stays `ContentView`'s first child.
- **One budget per pull request.** `workItemDetailsStore` is the only way to
  an item's details. The Inbox's pane, the Pull request tab and the info
  panel share its entries (`detailsKey`: workspace, account, item). It reads
  only for an active viewer (`watch`, through `useWorkItemDetails`), one
  read per item at a time, at most once per `INBOX_REFRESH_INTERVAL_MS`
  (a failed read counts as one, quiet or loud) unless forced by the person's
  Refresh or Retry or the re-read after a write. A forced load never takes
  the answer of a read already in flight, which may predate the write,
  unless a loud forced load started that read; it waits, then gets one more.
  The store's own reads (a watch's first load, the re-check once an entry
  goes stale) are quiet once the entry holds details, so the pane's editors
  never lock under the person's typing. The mergeability poll is its own: a
  few quiet reads while `mergeState` is `UNKNOWN`, only while watched
  (`MERGE_STATE_POLLS`). At most `MAX_UNWATCHED_DETAILS` (20) entries nobody
  watches keep their details, the least recently read dropped first. A
  folded section, a hidden panel, a tab behind another and the mark read
  nothing: `useDetailsEntry` reads the cache and never watches.
- **A branch's pull request is found in main** (`BranchPullRequestFinder`),
  for a session linked to none. Main reads the branch from the folder
  (`readBranchIdentity`), so the renderer never sends one; origin is mapped
  by the driver's `repoOfRemote`, and `lookupPullRequests` is asked once per
  provider, account, repo and the branch's name on the remote per interval
  (`BRANCH_LOOKUP_TTL_MS`, counted from the ask, not the answer, less a
  few seconds' slack, `ASK_SLACK_MS`, so the renderer's re-ask one interval
  on is not served the old answer), a failure kept as long as an answer,
  sooner only for Retry or Refresh. It is asked
  only while someone looks: the info panel shown with Pull request open, or
  the Pull request tab in front
  (`useBranchPullRequestLookup`, from `ContentView`). It is never written to
  the record; Link writes `workItem`. Every answer names the branch it was
  read for and counts only while the checkout is on it
  (`foundPullRequestOf`). `branchPullRequestStore` never lets an answer that
  says nothing new replace one that does: an answer for another branch
  never ends a lookup (one more is asked), a failed lookup keeps a pull
  request already found for the same branch, and an answer that read no
  branch keeps the asked branch's answer, or fails it so Retry is offered.
- **Branch facts never fetch**, on git 2.44 and later (`readBranchFacts`,
  through `readGit`: `GIT_NO_LAZY_FETCH=1`, which an older git ignores, so a
  partial clone's diff there fetches what it lacks; `GIT_TERMINAL_PROMPT=0`,
  a 10 s timeout and argument lists): every count is against what the clone
  already has, and what git cannot answer is a line not drawn, never a throw.
  "vs" compares with the session's pull request's base when its details are
  cached, else `origin/HEAD`, never a guessed `main`. They are read while the
  Branch section is open and again after each git status refresh of that
  checkout (`gitStatusStore.refreshedAt`);
  a load during a read gets one more read after it (`branchFactsStore`), so
  a commit made mid-read is counted. Uncommitted, like the header's counts,
  reads the stats git gave for its own checkout (`statsFor`, `statsRoot`),
  never the last checkout's during a session switch, and says `None` only
  when git did (`uncommittedFor`): while git reads its checkout for the
  first time the row stays with no value, so the rows below do not jump;
  with no read of it under way and none landed (a folder below its
  repository's top, whose status is never read), or where git said no
  repository, the row is not drawn.
- **A kind's mark has a tone** (`agent` or `alert`), and every mark takes
  the same three places (`markPlaces`): its header shortcut; its tab in a
  group on screen, drawn there only while behind another tab, since in
  front its view says it; and with neither, the side panel toggle.
  `markDots` is where a tone becomes `data-agent-dot` or
  `data-alert-dot`. The toggle draws every mark left to it
  (`marksOnToggle`), the red dot in the corner and the accent one 8px to its
  left, and says each after its label, in registry order
  (`labelWithMarks`). The Pull request mark (a failing check, changes
  requested) reads the newer of the cached details and the Inbox snapshot's
  item (`pullRequestAlert`), and never asks for a read.

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
be a worktree. The info panel's Folder row and the sidebar's worktree line read
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
  unknown), an automation run whose checkout it is, working in it or parked
  at a gate or a retry with no process there (`heldCheckouts`), a session on
  it that is working, waiting, held by a run, open in a window or active
  within the hour, and any other session still using it through `cwd` or
  `agentCwd`.
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

A run's own checkout is a tree too, recognised by its run record or its git
folder's `consola.run`, removed with its git folder by `removeRunClone`
(never `git worktree remove`) after its branch is fetched into the person's
clone as a keep-ref, recorded on its sessions and its run, and rebuilt from
it; never while its run is open. Unlike a linked worktree's, its keep-ref
stays after a rebuild, for as long as the folder exists: a shared clone's own
refs keep nothing in the person's clone, so without it a `gc` there would
drop the rebuilt checkout's commits. Its rules are its run's: an ended run
(`run-finished`), and, off by default, *Remove a run's own checkout once its
run is no longer in history* (`runForgotten`); Retry, or opening a step's
session, rebuilds it. Its keep-ref goes only once no session and no run in
history names the folder and the folder is gone (`releaseRemovedWorktreeWith`;
`git for-each-ref refs/consola/worktrees` lists them), and its
`.consola-cache` is regenerable, never a reason to keep it.

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
session with a tool policy (`read-only`, `edit` or `write`), every one of
which launches `--restricted`, and each driver refuses it otherwise
(`SessionLaunch.unattended`): print mode skips the trust prompt, and
without `--restricted` it would load the folder's hooks and settings
unasked. The run lasts until that process exits. Continuing the session
afterwards is an ordinary interactive resume, still under its policy, where
the trust prompt is the person's to answer. Lifting the restriction means a
fork the person starts (`SessionLauncher.forkWithFullTools`), never an edit
of the session's `toolPolicy`.

A Consola tool marked `fullToolsOnly` is never offered to a read-only
session. And whatever `save_automation` writes or replaces gives up the
entry's acceptance, so it asks once before its next unattended run — even
when only its schedule changed, which a hand edit would not ask about. No
run an agent asks for (`run_automation`) ever gives it back: approving that
run runs it only (`acceptApproved`), so an entry is accepted only when a
person approves a run that really is unattended, or allows a poll.

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

An entry with `checkout: { repo, branch }` gets a checkout of its own per run
instead: `~/.consola/worktrees/<repo>-run-<8>/`, a `git clone --shared` of
the person's clone whose git folder is `~/.consola/run-git/<repo>-run-<8>.git`,
outside the checkout, so no step's sandbox can write it (in a linked worktree
a sandboxed shell can move the clone's branches; in a git folder of its own it
could plant replace refs and grafts); the checkout holds only a `.git` pointer
that neither the sandbox nor the file tools may rewrite (canary rows 47 and
30). `origin` is the real remote, the branch the one the run cut. Consola
makes it before the first step (`makeRunClone`, under the folder's lock; a
make a quit cut short is made again by the next start or a Retry, `again`,
only when the run's record claims that very folder with no commit, no other
run's names it, both folders are real folders and the git folder names no
other run), ends the step's own
processes and commits after every agent step, checks commands leave nothing,
and resets to a step's `before` for a retry (`engine/node/runCheckout.ts`),
always naming `GIT_DIR` and `GIT_WORK_TREE` for its own git, with no global or
system config, replace refs and grafts off, and `gitFolderProblem` and
`treeProblem` before every write. Neither variable reaches a step's shell, a
session or a command (they would make `git clone` refuse and aim git in any
other repository at the run's clone): a step's git finds the folder through
the pointer, so `gitFolderProblem` also runs before every spawn there, and a
changed folder starts nothing. A session open there holds the run before its
next step. `--shared` borrows the person's objects: a `git gc --prune` in
their clone can break a run's checkout, most likely one parked at a gate.
Consola's commit runs no git filter, so a changed Git LFS file is committed
as its content, not as a pointer.

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

### What a Write Step Is Held To

An agent file's `tools: edit | write` needs `environment:`
(`environments/<name>.yaml`, `host` or `sandbox`) and a run's own checkout.
`ClaudeDriver` compiles it (`claudeWriteAgent.ts`) into `--restricted` and one
`--settings` holding `sandbox` and `allowedMcpServers` (attention hooks on
`host` only: the sandbox's proxy refuses them, canary row 39, so a sandboxed
step shows no live attention); the session's policy and grants are immutable
and replayed on every launch. A sandboxed session gets `sandboxSessionEnv`'s
allow-list, and no session with a policy gets the bound account's token
(`borrowProviderToken`). The shell may not read `denyReadList`: the credential
files and folders, each agent CLI's default profile (`~/.claude`, `~/.codex`,
`~/.gemini`), Consola's data (`userData`, the factory root) and every
harness's effective profile. Those are files: Git's osxkeychain helper, `gh`
and Claude keep their sign-ins in the keychain, which the shell still reaches
(row 49), and the card says so (`KEYCHAIN_SIGN_INS_SENTENCE`). `sandbox` is refused on a harness whose own or managed
settings set `sandbox` (`sandboxSettingsProblem`), and off macOS. It is
checked by `scripts/claude-steps-canary.mjs` rows 29–50 on a CLI version
change, never at run time.

The sandbox holds the shell only; the file tools are held by `--restricted`
(they read and write only the checkout and refuse `.claude/agents`,
`.claude/skills`, `.husky/` and `.git`, rows 30 and 44,
`FILE_TOOLS_DENY_CHECKED`; whether they follow a link out of it is row 50's,
not yet seen, `FILE_TOOLS_LINKS_CHECKED`, and the card says so). A link a
step leaves that leads out of the checkout (`linkLeadsOut`: an absolute
target, a `..` above it, or a chain that ends outside) fails the step, so
none reaches a later step; and what a step changes among the paths agents and
CI read (`.claude/`, `.github/`, `CLAUDE.md`, `.gitattributes`…) is flagged on
the run page (`flaggedPaths`). Not contained: the shell's reads of other
files, the keychain service (`security` reaches it, row 49), the temporary
folder all sandboxed Claude shells share (`/tmp/claude-<uid>`), other CLI
versions and other OSes. `git clone` and `git init` do not work in a sandboxed
shell (row 37). Its package managers read no `~/.npmrc` (denied): pnpm and npm
fall back to their defaults, so a private registry needs an `.npmrc` in the
checkout and its host in the environment's `network:`. Their caches sit under
`.consola-cache` (`npm_config_store_dir` for pnpm 10, `pnpm_config_store_dir`
from 11), but pnpm 12 locks its store in `/tmp/pnpm-store-operation-locks-<uid>`,
outside what the sandbox lets the shell write, so its `install` fails there.
That was seen with `sandbox-exec` (pnpm 10.28.2 and 12.21.0), not yet through
the CLI's own sandbox, which row 29 asks.
Consola ends only a step's own processes (its CLI's group, and the descendants
recorded as its turn ended, while their start time matches) and never signals
another; a process an agent backgrounds is in neither (row 48), so it is found
by its working directory, and any process outside Consola's sessions left in
the checkout fails the step. A step's full-tools continuation waits for its
run to end, and an item step's forks into `<repo>-<type>-<n>-continue-<8>`.
Once a full-tools session was launched in a run's own checkout, running or
not, Retry refuses until that session is deleted (`fullToolsSession`):
Claude trusts the folder for it, as slice 1's rule for an item's checkout.
Rerun the canary's rows 29–50 after every CLI upgrade, and record the version
in `SANDBOX_CHECKED_ON_CLAUDE`.

### A Run Parks at a Gate

A `steps:` run that reaches a `gate:` step, a loop's exhaustion gate, or a
declared retry's wait is `waiting`: started, open and live, with no process
and no slot. It still holds its item, so a new revision is held for after it
(`openStates` reads it as `working`), and its checkout (`checkoutHeld`, by its
record: `holdsWhileWaiting`), so another run on the item waits, naming the
gate (`RunRecord.waitingFor.gate`). Only a person answers a gate: the renderer
calls `automations:answer-gate`, and no MCP tool, conductor tool or step tool
reaches `answerGate` (`gateAnswerers.test.ts`). Answering accepts nothing and
approving a run answers none of its gates. A restart changes no `waiting` run
and leaves a loop's `repeat` row as it was; the engine raises each gate's
notification again, and a retry wait whose time passed runs at start. A loop
is one row of its own plus its steps' rows in record order (`flatSteps`), each
round a new attempt carrying `round`; read an entry's steps through
`leafSteps`, never `automation.steps`, or a step inside a loop goes unseen.
Only what cannot have acted retries by itself (`steps/retry.ts`): the
validator refuses a step's `on_failure` on a step that may have acted, and an
entry's `on_failure`, accepted on any `steps:` entry, is decided when its run fails
(`entryMayRetry`: it starts again only if nothing in it acted). The budget is
checked at every step boundary, and an agent step's first unattended turn in
a run with a budget gets `--max-budget-usd` for what is left (canary row 40).

### A Step's Turn Reports Itself

A step's unattended turns run with `--output-format stream-json`: the driver's
reader parses it (`createTurnReader`) and `TerminalService` shows Consola's
lines instead (notice, tool calls, non-JSON lines, summary), so never read such
a turn from its pane. A non-JSON line loses every escape and control character
and is marked as the CLI's (`formatCliLine`), so it can neither repaint the
pane nor pass for Consola's dim lines. Only Ctrl+C reaches the CLI (the PTY
echoes other keys into the stream), what Consola quotes of the report goes
through `oneLine`, and the report stays in main. The engine decides failure,
cost and the reminder's cap from `TurnReportView` (`steps/turnReport.ts`). It
checks the servers an agent grants against the turn's `init` as it is printed
and again at the turn's end, so a turn whose `init` never arrived never
completes a step that grants one. A cap counts one launch's turns: a resume
after a quit runs under the step's `max_turns` again, a reminder cut off by a
quit under the reminder's own cap. Attention never reads the
pane's prose: `working` is the turn's own status, a question comes from hooks
and non-JSON lines, a limit from `StopFailure` and the stream (OR'd into
`limit-notice`). The reopen is a plain resume: no stream-json, no `--max-turns`.
Extra args setting `--output-format`, `--input-format` or `--max-turns` refuse
steps. Rerun `scripts/claude-steps-canary.mjs` after every CLI upgrade.

### The Factory Folder Applies as a Unit

A workspace's factory is its folder (`factory.yml`, `automations/`, `agents/`,
`skills/`), polled by `FactoryFolder` (engine `node/`) and parsed only by
`parseFactory`, which resolves references across files (`parseFactorySpec`
reads a lone `factory.yml` and refuses `agent:`). `decideApply` decides what
runs: from the first clean read on, any issue, or a changed entry whose agent's
harness the host refuses, keeps the last applied version running (per folder in
`<userData>/factory-applied/`, read once per workspace; the entry as written
shows it). A removal always applies, recomputed at each read; machine state is
a per-entry problem, never a rollback; a folder never applied cleanly applies
entry by entry. A step's agent travels in `RunDefinition.agents`: the host
launches on its harness with `--model`, refuses one gone since apply, and a
reopen takes both from the record. New entries go to `factory.yml`, a replace
where the entry lives; an agent's servers and skills are its driver's to
compile (below); Open shows only the folder's own files, as text. Canary rows
16–19: `--model`.

### An Agent's Servers and Skills Are Compiled by Its Driver

An agent's `mcpServers:` and `skills:` reach a step only as its driver compiles
them (`compileAgent`, pure) or refuses them in words. A harness's servers are
asked of its CLI (Claude: `mcp_status`, from home), never read from its files,
and cached per launch identity (`McpServersCache`, main); a failure stays until
**Check again**, on every entry it stopped. On someone else's pull request or
issue (an `item` checkout) only claude.ai connectors: the person's own server
could start, or run its sign-in helper, in the author's checkout. Claude's
grants: one `--settings` (hooks, `allowedMcpServers`: stdio by name, remote by
URL), strict dropped only for a connector, narrowed `--allowedTools`, a plugin
dir in the attempt's folder (`--add-dir`, `Skill`, a deny rule per other skill
the CLI lists, asked each launch where the session runs). `Session.grants` (not
in `allowedSessionUpdates`) replays them every launch; skills are copied at
fire, re-hashed at launch and in the plugin built from them, and a reopen
loads that plugin only while it still holds them; `init` must show each
granted server connected, and no server but those and Consola's own. A
step's session keeps its harness while its run is open (provenance and run
record, not `attention.holds()`), then loses its grants. "Reads text other
people wrote" marks runs that carry an item. A card names a whole server's
tools: Allow from the last answer, a run's approval from its definition,
which keeps the answer the run was made with (`knownTools`, never a grant).
Both show each skill's `SKILL.md` as what they accept holds it: Allow the
version's, a run's approval its own copy's. Canary rows 20–28.

### Secrets Are Names; Bindings Are the Runner's

A file names a secret, never its value or where it lives: `secrets:` on a
`run:` step or on a poll's check command. Each runner binds the name per
workspace and factory (`personal` until factories arrive); the desktop keeps
the binding in `secret-bindings.json` in Consola's state folder, as a
reference only (`keychain:<service>/<account>`, `op://…`, `env:<NAME>`), never
in the factory folder, a harness record or workspace settings. Where a name is
bound is not part of the version, so a rebinding never asks for approval again;
it shows where the name is used (Settings › Secrets, the cards), and a poll
whose check uses it baselines rather than firing every item.

- **Unbound is the entry's problem**, never the folder's: `needs … bound on
  this Mac (Settings › Secrets)`, decided last, after everything else about
  the entry (`resolveAll`'s last line). A save never refuses for it, and
  binding brings back the entry, version and acceptance it had.
- **A run reads every value it will use when its next step is let in to start
  and it holds none** (`startWaiting`, `RunSecrets`), all at once, never
  before a turn that resumes in its session after a restart. It holds them
  only while its status is `running`: `broadcastRun` drops them, and
  `syncWorkspaces` for a deleted workspace's runs. A failed read fails that
  step before it starts. A check reads its own before each check.
- **Each command gets only its own names**, as environment variables, after
  `env:` and before `CONSOLA_*`; never a template path (`{{secrets.X}}` is
  refused), never a command line. No agent is given a value, and an `env:`
  binding hides nothing from a host agent or from a command that does not
  name it: both start with the whole login environment.
- **Every value's printed forms** (`maskFormsOf`: raw, its lines with and
  without a closing CR, JSON-escaped, percent-encoded, base64 at each
  alignment) join the mask list every command and check already uses, so
  logs, `command.json`, outputs, errors and a
  check's status line are masked by the code that masks the bound account's
  token. Consola rewrites a command's `$CONSOLA_OUTPUT` masked as it ends,
  its step ended or not. One a quit or a crash cut off cannot be masked, as
  its values went with the quit: the next start empties it before anything
  reads it (`emptyCutOffOutputs`). A file the command writes under a name of
  its own stays its own.
- **The engine core sees names, labels and fingerprints** through
  `SecretsPort`, never a reference, and spawns no reader. The desktop reads
  `/usr/bin/security` by absolute path and `op` by the path kept when the
  person bound it, both named only in `secretPrograms`, which in a test run
  answers the stubs `CONSOLA_E2E_SECURITY` / `CONSOLA_E2E_OP` name, or
  nothing. No test reads the person's keychain or 1Password.
- **No IPC member carries a value**: `secrets:list` carries names, labels,
  times and uses, `secrets:bind` a reference. No agent binds, and no Consola
  tool reads, writes or lists a value, a reference or a label. A failed read
  is worded twice (`readSecrets`): the person's words say where the name is
  bound and why; an agent's (`told`) say only which name and that it is
  bound, since a label is a reference and a reason can name one. `list()`,
  which `list_automations` returns whole, carries an agent's; only the
  person's panel (`snapshot`) has the person's.

### A Factory's Servers Are the Engine's

`factory.yml`'s `mcpServers:` defines servers that only a `uses:` step calls
(and, from 5a-3, a tool poll). They are a namespace apart from an agent file's
`mcpServers:`, which name the harness's own servers: the same name in both
places is two servers. A factory server starts only for a call or for a
person's **Check server**, never when the folder applies, and never before a
person allowed the entry's version (or approved the one run an agent asked
for, which accepts nothing).

- **Per call, as the person.** A stdio server starts for each call, in an
  empty folder under `<userData>/mcp-calls`, with the allow-list
  (`SERVER_ENV_ALLOW_LIST`), its `env:` and its secrets as its environment,
  and nothing else of the login environment. Its process group is recorded
  durably as it is spawned (`call.server` on the step's record, or
  `mcp-server-groups.json` for Check server), ended after the call with its
  descendants found by parent id, and ended at the next start when it is
  still that process (`endServersLeftRunning`, which compares the `ps` start
  time first).
- **A card shows a server's definition in full, never a value.** The
  approval card, the Allow card, the page and Check server's dialog show its
  literal `env:` pairs and headers as written (`ServerFacts.env`, `headers`),
  a header made from a secret as its template (`Bearer ${TRACKER_TOKEN}`):
  the credential heuristic misses some literals, and the person sees them
  there. `ServerFacts` is made from the definition alone, so a secret's value
  never enters it, a view or IPC.
- **A call's order, and its two durable writes.** Render `with:`, reach the
  tool (start or connect, initialize, list, check the arguments and the
  declared outputs), write `call.json`, record the intent, send, record the
  answer, then the outputs, the settle and the close. The intent is written
  before the send and the answer after it; anything that fails before the
  intent says `Nothing was sent.`
- **A call is in the command lane, and the line waits only for its start.**
  `startCall` marks its step running and keeps its handle before anything is
  awaited; the call then runs on its own and its end settles it, as a
  command's does, so a slow server holds up no other run. Only a dry run's
  report is awaited, since its preview runs while the step is still queued.
  A throw past the call's own handling fails its run (`callThrew`).
- **After the send, only a result without `isError` says what happened.** A
  timeout, a stop, a closed connection, an unreadable or oversized answer and
  an `isError` result all read "may or may not have happened", and nothing
  calls again by itself: a quit fails an interrupted call, and Retry warns
  first.
- **The adapter** (`node/mcpClient.ts`) sends and lists with
  `client.request`, never `client.callTool` or `client.listTools`; reads a
  JSON-RPC error answer as an `isError` result; refuses every redirect with
  its own `fetch`; declares no capabilities; ends a server's group at once on
  a quit; offers only the transports its platform can
  (`McpClientPort.transports`); and is the only file that imports the SDK
  (`boundary.test.ts`).
- **After a call's intent, nothing is written once its run has ended**, and a
  write that fails says what may have happened, never `Nothing was sent.`
- **Every automatable Consola tool says what each argument does** (`prompt`,
  `selector` or `data`: `ToolDefinition.roles`, which the registry requires),
  and a `prompt` or `selector` argument takes only trusted values.
  `run: { tool }` runs on the executor's in-process branch, with its parse,
  hash, modes and previewed plan unchanged.
- **No test starts a server but the repository's stubs**, and a stub's
  controls are its arguments, never environment variables, which a server's
  allow-listed environment drops.

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
  session's `toolPolicy` (`read-only`, `edit` or `write`, set only on a
  session an automation starts): main replays it from the record on every launch, `TERMINAL_CREATE`
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
- `app:*` - The machine Consola runs on: its name (`app:get-computer-name`), read once per run
- `open-in:*` - "Open in" a session's folder: the apps main found (`open-in:list`), and opening one (`open-in:open`), which main checks first
- `worktree-cleanup:*` - Cleanup preview, "Clean up now", history, and a deleted session's outcome
- `browser:*` - In-app browser tabs, page actions and snapshots; every id is checked against the sender's workspace
- `secrets:*` - A workspace's secret names and bindings (never a value); bind and unbind
- `automations:check-server` - Check server: start a factory server once, on a person's press, and list its tools

Every terminal message carries `instanceId`; there is one terminal per session.

## Licensing

Consola is AGPL-3.0-only (`LICENSE`), and every `package.json` says so. Three
rules follow:

- **Packages other people build against are MIT.** Plugin API types
  (`@consola/plugin-types`), the `factory-spec` schema, the runner protocol
  (`@consola/runner-protocol`), integration manifest
  formats: anything a third party compiles against gets its own MIT `LICENSE`
  and `"license": "MIT"`, so plugin and integration authors choose their own
  license. Such a package must not import from `apps/*` — that would pull
  AGPL code into it.
- **A server people use over the network offers its source** (AGPL §13). The
  cloud web app links to the source of the version it is running.
- **Dependencies must be AGPL-compatible**: MIT, ISC, BSD, Apache-2.0,
  MPL-2.0, LGPL and GPL-3.0 are; GPL-2.0-only is not. CI checks every
  installed dependency's declared licence against the list in
  `.github/scripts/check-licenses.mjs`. Its `NOT_SHIPPED` names the few
  that are not (the Claude Agent SDK and the Cursor SDK, which the copied
  t3code packages install), each with what keeps it out of everything
  Consola publishes or releases; a package joins it only when nothing that
  ships may bundle it.

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

## Documents Live in Linear

Every design, spec, plan, spike and piece of research is a Linear document
in the Consola workspace, never a file in the repository. Start at the
[Documents index](https://linear.app/consola/document/documents-index-start-here-63df2a55ce30): it lists every document by area and says
how to add one. There is no `docs/` folder any more. On 2026-11-22
everything in it, and the documents that were only in worktrees, moved to
Linear, and each moved document opens with the path it came from. A
`docs/...` path in older code, commits, issues or notes names one of them;
find it in the index.

- **Write every new document in Linear, never as a local file.** This
  overrides any skill that saves to `docs/` by default (superpowers'
  brainstorming and writing-plans, this repository's research-codebase).
  Create it with the Linear MCP tools (`save_document`) and read one with
  `get_document`. A CLI without them asks the person to add the document.
- **Attach it to the project it serves**, or to the Consola team when no
  project fits, and link it from the issues it is for.
- **Title it `Area · Kind: subject`**, for example
  `Automations · Spec: Waiting and long runs (slice 4)`. Put the date it was
  written on its first line, and add it to the index under its section.
- **Upload images to the document.** Zip HTML mocks and link the zip.
- **Point code comments and `AGENTS.md` files at Linear** by the document's
  title and URL, never at a local path.

Direction (where the product is heading, not a spec):
- [North star · Automations](https://linear.app/consola/document/north-star-automations-bba97f65f331) - **The north star for automations**: CI-shaped pipelines defined in files, run by desktop, headless and cloud runners. Read its invariants and decisions before designing anything that touches automations, triggers, connections, runs, agents, factory files, environments, runners, or sharing across an org
- [North star · Automations roadmap](https://linear.app/consola/document/north-star-automations-roadmap-45cd43ac0bf0) - The slice order toward that north star, what each slice delivers, and the contracts each slice must leave true for later ones. Read a slice's entry and its contracts before writing that slice's spec
- [North star · Factories (the earlier direction)](https://linear.app/consola/document/north-star-factories-the-earlier-direction-11a3fbefdb39) - The earlier local + cloud direction ("factories"). Its cloud runner, identity and Run record still stand; its "no workflow engine", "confirm every run" and "org ⊕ repo merge" rules are superseded by the automations north star
- [Cloud roadmap](https://linear.app/consola/document/cloud-roadmap-dbb1abc3c24d) - The plan for Consola Cloud: its projects in order, and which are unblocked

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
