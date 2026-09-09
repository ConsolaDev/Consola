---
date: 2026-08-25T16:23:24+02:00
git_commit: 4c92e9d74581d7db8a13dc742c2937b9ae85f417
branch: feat/inbox-v2
repository: ConsolaDev/Consola
topic: "What in Consola is bound to the local machine, and what that implies for managing it from the cloud (hosted or self-hosted)"
tags: [research, codebase, architecture, harnesses, github, gh, persistence, pty, conductor, cloud]
status: complete
---

# Research: Local-machine coupling map for a cloud-managed Consola

**Date**: 2026-08-25 16:23 CEST
**Git Commit**: 4c92e9d74581d7db8a13dc742c2937b9ae85f417
**Branch**: feat/inbox-v2
**Repository**: ConsolaDev/Consola

## Research Question

> Looking at this codebase, how could we make everything eventually be able to be managed in the cloud? Say you eventually want to deploy stuff into a cloud (either we offer ours or people can self host), so you have all these utilities. Take into consideration things like the harnesses and all the gh / etc configuration and how these would work in the cloud.

The bulk of this document is a **map of what exists today** and exactly where it touches the local machine: binaries, home directory, login shell, filesystem, OS APIs, sockets. The final section (§6) answers the "how could we" part by stating, per coupling, what a cloud deployment would have to provide — grounded in the code, not a design.

## Summary

Consola is, by design, a **thin coordinator of local CLIs**. It stores no credentials of its own, makes zero HTTP calls from JavaScript, and delegates every network interaction to a child process: `claude` (via PTY, headless `-p`, and a stream-json handshake), `gh` (auth broker, GraphQL, clone, checkout), and `git`. Its own state is three JSON files under Electron's `userData`, plus worktrees under `~/.consola/worktrees`, plus files it writes into the user's own repos (conductor briefs). Everything else it knows — signed-in accounts, session names, slash commands, models — it **reads from other programs' on-disk storage** (`~/.claude.json`, `<configDir>/projects/**`, `gh`'s keyring via `gh auth token`).

The consequence for cloud management: there is a clean seam already (the ten `*Bridge.ts` files and the `IPC_CHANNELS` table), and the main process is already the single authority for state. But the *meaning* of almost every record is a path or binary on one specific machine: a harness is `binaryPath` + `configDir`; a scope is an absolute folder; a session is a UUID whose transcript lives inside one harness's `configDir` and only resumes there. Moving management to the cloud therefore means deciding, per record, whether it names something on the user's machine, on a cloud worker, or is machine-independent — the code currently has no such distinction.

Key on-disk facts (details in §2–§4):

| What | Where | Who owns it |
|---|---|---|
| Workspaces/sessions/scopes/groups | `<userData>/workspaces.json` v6 | `WorkspaceService` (main) |
| Harness records | `<userData>/harnesses.json` v1 | `HarnessService` (main) |
| Window layout | `<userData>/windows.json` | `window-manager` |
| Conductor MCP configs | `<userData>/conductor-mcp/<sessionId>.json` (0600) | `ConductorControlServer` |
| Conductor briefs | `<scopePath>/conductor/<name>/{CLAUDE.md,POLICY.md,state.json}` | user's repo |
| Work-item worktrees | `~/.consola/worktrees/<repo>-<type>-<n>` | `WorktreeService` |
| Conversations | `<configDir or ~/.claude>/projects/<enc>/<sessionId>.jsonl` | **the `claude` CLI** |
| Signed-in Claude account | `<configDir>/.claude.json` or `~/.claude.json` (`oauthAccount`) | **the `claude` CLI** |
| GitHub credentials | `gh`'s keyring, borrowed via `gh auth token --user` | **the `gh` CLI** |
| UI prefs (theme, font, sidebar) | renderer `localStorage` | zustand persist |

## Detailed Findings

### 1. Process model and the renderer/main seam

Three processes, one contract. Channel names live only in `src/shared/constants.ts:5-107`; the preload exposes nine globals (`src/preload/preload.ts:47-357`): `terminalAPI`, `harnessAPI`, `harnessStateAPI`, `githubAPI`, `workspaceAPI`, `conductorAPI`, `dialogAPI`, `fileAPI`, `gitAPI`, `windowAPI`. Each has a one-file renderer wrapper in `src/renderer/services/*Bridge.ts`, and CLAUDE.md mandates bridges over direct `window.*API` access.

Two styles coexist: older bridges (`dialog`, `file`, `git`, `github`) do a defensive `getAPI()` returning `null` when the global is missing; newer ones (`terminal`, `workspace`, `harness`, `window`, `conductor`) touch `window.xAPI` directly.

Direction matters for anything remote:
- **invoke/handle** (request/response): all state mutations, probes, file/git reads.
- **push, owner-only**: `terminal:data` goes to the one window that owns the PTY (`src/main/TerminalManager.ts:137-163`).
- **push, broadcast**: `terminal:{activity,awaiting-confirmation,exit,status}`, `workspace:changed`, `harness:changed`, `github:inbox-changed` to every window (`TerminalManager.ts:144-190`, `ipc-handlers.ts:114-127, 279-285, 344-350`).
- **edge-triggered → snapshot endpoints**: because status pushes are edges, `terminal:status-snapshot` exists for late-joining windows (`TerminalManager.ts:104-114`).
- **Launch argument**: window identity arrives as `--consola-window=<json>` in `additionalArguments`, not IPC (`window-manager.ts:59-62`, `preload.ts:346-355`).

The main process is already the **single writer** for workspace and harness state; renderers send *intents*, never snapshots (`src/main/state/WorkspaceService.ts:23-30`, `workspaceBridge.ts:17-22`). Update payloads are rebuilt from allow-lists in `src/main/state/updateFilters.ts` because `Pick<>` is gone after IPC.

Prior research (`research/2026-02-17-platform-architecture-migration-analysis.md:65-74`) already observed that the bridge pattern makes the React frontend portable "by replacing these files with HTTP/WebSocket clients"; that document proposed a separate self-hosted monorepo and was **not adopted** — `research/2026-08-18-agent-deck-conductor-listeners-actions.md:5-8` explicitly reversed it in favour of growing inside Consola.

### 2. Harnesses: what a harness *is* on disk

`Harness` (`src/shared/harness.ts:38-64`): `id` (user-chosen, immutable), `driverId: 'claude'` (only member of the union, `src/shared/types.ts:15`), `name`, `accentColor`, `enabled`, `archived`, `isBuiltIn`, `binaryPath?`, `configDir?`, `extraArgs`, timestamps. Persisted at `<userData>/harnesses.json` as `{version: 1, harnesses}` (`src/main/state/HarnessService.ts:10-15`, path at `ipc-handlers.ts:272-274`). No credential is ever stored (`harness.ts:30-36`); a harness is purely a launch description.

**Binary resolution** (`src/main/drivers/ClaudeDriver.ts:131-157`): explicit `binaryPath` verbatim (no fallback, because a different install is a different account); else walk the **login-shell PATH**; else `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` (`:28-32`); else bare `'claude'`.

**Login-shell environment** (`src/main/LoginEnvironment.ts:63-97`): `execFileSync($SHELL, ['-ilc','env -0'])` once per app lifetime, 5 s timeout, merged over `process.env` with login PATH winning; win32 skips the probe. It strips eight `CLAUDE_CODE_*`/`CLAUDECODE`/`CLAUDE_PID` vars (`:23-32`) so Consola-spawned sessions aren't treated as nested children. Every driver, `gh`, and PTY spawn starts from this object.

**Env composition** (`ClaudeDriver.ts:185-188`): sets `CLAUDE_CONFIG_DIR` only when the harness pins one; `GH_TOKEN` layered on top at spawn (`src/main/github/GhBroker.ts:92-94`). Tilde expansion happens once, in `toHarnessConfig`/`expandHome` (`src/main/drivers/HarnessDriver.ts:118-138`).

**argv** (`ClaudeDriver.ts:167-176`): `--session-id <uuid>` first launch, `--resume <uuid>` after (`Session.hasStarted`); `--model` if pinned; `--mcp-config <path>` for conductors only; harness `extraArgs` last so a user's `--model` wins.

**Health probe** (`ClaudeDriver.ts:190-233`): reads `<configDir>/.claude.json` or `~/.claude.json` → `oauthAccount.{emailAddress,displayName,organizationName,organizationType}` for display; runs `claude --version`. Never cached.

**Capabilities probe** (`src/main/drivers/claudeCapabilities.ts:75-187`): spawns `claude --input-format stream-json --output-format stream-json --verbose -p --no-session-persistence` **from `os.homedir()`**, writes one `control_request{subtype:'initialize'}` line, parses the strict `control_response` (commands, agents, models, output styles, account). It runs the user's `SessionStart` hooks as a side effect, hence a 15 s backstop and a main-process cache keyed by `JSON.stringify([driverId, binaryPath, configDir, extraArgs])` — the *launch signature*, never the record id or cwd (`src/main/HarnessCapabilitiesCache.ts:90-97`). Failures are not cached.

**Session naming** reads the CLI's storage: `<configDir or $CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/sessions-index.json` and `<sessionId>.jsonl`, scanning every project dir because the dir-name encoding is lossy (`src/main/ClaudeSessionIndex.ts:39-88`). Renderer polls every 5 s until a `summary` arrives (`ContentView.tsx:25-26`).

**Invariants** (CLAUDE.md, enforced by absence from allow-lists): a session's `harnessId` and `model` are immutable; harnesses are archived, never deleted (`HarnessService.ts:87-107`), because the transcript lives in that harness's `configDir` and `--resume` only finds it there. The built-in harness pins nothing and cannot be archived.

The renderer keeps a parallel, IPC-free descriptor table `HARNESS_DRIVERS` (`src/shared/constants.ts:117-160`: `binaryName`, `configDirEnvVar`, `defaultConfigDir: '~/.claude'`, `supportsSessionNaming`, `supportsCapabilities`).

### 3. Sessions: PTY, screen model, delivery guard

**Spawn** (`src/main/TerminalService.ts:209-293`): `statSync(cwd)` first (node-pty's `chdir` failure is silent on macOS), `await borrowGhToken()`, then `pty.spawn(binary, args, {name:'xterm-256color', cols, rows, cwd, env})`. A failed `--resume` (non-zero exit) is retried once as a fresh session. node-pty is a native module rebuilt for Electron (`package.json` postinstall) and must be `asarUnpack`ed (`electron-builder.yml:26-28`).

**PTYs outlive views**: `TerminalManager` keys one `TerminalService` per `instanceId`, reassigns the owning `WebContents` on reattach, and replays `ScreenModel.snapshot()` (headless xterm + serialize addon, `src/main/ScreenModel.ts`) on remount. `startHeadless()` launches with no owner window at all (`TerminalManager.ts:77-89`) — used by fan-out and conductors.

**Prompt delivery guard** (`TerminalService.ts:381-431`): queued prompts are pasted only when `ScreenModel.visibleText()` shows an empty composer (`/^\s*[❯>]\s*$/`) and none of `CONFIRMATION_MARKERS` (`/do you trust/i`, `/trust this folder/i`, `/do you want to proceed/i`, `/enter to confirm/i`). Status (`working|ready|needs-attention|exited`) is derived from busy/awaiting/exited flags via a 500 ms idle debounce. There are **no Claude hooks installed** anywhere; screen classification is the only turn-detection mechanism (`research/2026-08-18-agent-deck-conductor-listeners-actions.md:153-156` lists a `Stop` hook as a future hardening).

**Renderer** (`src/renderer/components/Terminal/useTerminal.ts`): xterm.js with fit/web-links/unicode11/webgl addons; keystrokes go `terminal:input`, resize `terminal:resize`, file drops become `@relative` path text pasted (never file bytes) via Electron 28's `File.path` (`useTerminalFileDrop.ts:43-56`).

### 4. GitHub and git: the `gh` broker and shelling out

**No HTTP anywhere.** Grep confirms no `fetch`, `https`, axios, or WebSocket in `src/`. Every GitHub interaction is a `gh` subprocess:

| argv | env | site |
|---|---|---|
| `gh --version`, `gh auth status` | login env | `GhBroker.ts:122,138` |
| `gh auth token --user <login>` | login env | `GhBroker.ts:177` (cached 5 min, `:20`) |
| `gh api graphql -f query=… -f assigned=… -f authored=… -f reviewRequested=…` | login env + `GH_TOKEN` | `GitHubService.ts:109-127` |
| `gh repo clone <owner/name> <target>` | `composeGhEnv(login)` | `cloneRepo.ts:47-50` |
| `gh pr checkout <n>` | `composeGhEnv(login)`, cwd = worktree | `WorktreeService.ts:194` |

**Credential posture** (`GhBroker.ts:7-16`): Consola stores zero GitHub credentials; `gh`'s keyring is the broker; tokens live in a `Map` for minutes and never cross IPC; `stripTokenLines` scrubs anything token-shaped from errors that reach renderers (`:78`). There is deliberately no `gh auth switch` so two workspaces on two accounts can run concurrently. Token injection happens at exactly two seams: `composeGhEnv` (`ipc-handlers.ts:327-330`) for subprocesses, and `layerGhToken` at PTY spawn (`TerminalService.ts:248-251`). A workspace with no `github` binding spawns identically to pre-binding Consola.

`gh` binary resolution: `CONSOLA_GH_PATH` (test seam), else login-shell PATH walk, no hardcoded fallbacks (`GhBroker.ts:211-225`). `gh` absent is a first-class state.

**Inbox** (`GitHubService.ts`): one GraphQL request per bound workspace with three aliased `search(type: ISSUE, first: 50)` calls (`parseInbox.ts:13-44`); polled every 3 min (`:11`) plus on `browser-window-focus` with a 30 s floor (`:13`); cached in memory only; on failure keeps the last good list and labels staleness. Parser throws on unrecognised payload shape rather than yielding an empty inbox.

**git** is assumed on PATH, unprobed:
- `WorktreeService` uses `execFile('git', …)` with argv arrays: `remote get-url origin`, `rev-parse --git-common-dir`, `worktree prune/add/remove`, `branch --list`, `status --porcelain` (`WorktreeService.ts:96-253`). Worktree root `CONSOLA_WORKTREES_DIR ?? ~/.consola/worktrees` (`:53-54`). `prune()` exists but has no caller or IPC handler.
- The git review panel uses shell `exec` with **interpolated strings** and the Electron process env (not login env): `git status --porcelain -uall`, `git diff [--cached] [--numstat]`, `git show HEAD:"f"`, `git add "f"`, `git reset HEAD "f"`, `git commit -m "…"` with `"`-escaping only (`ipc-handlers.ts:726-1022`).
- Commit-message generation is `claude -p <prompt> --output-format json --allowed-tools ''` against the **ambient** env, not any harness (`ClaudeDriver.ts:284-321`, `ipc-handlers.ts:1025-1075`).

**Repo discovery** is filesystem scanning: a scope is a repo if `<path>/.git` exists; a container scope's direct children are candidate repos (`scopeRepos.ts:13-38`); remote→clone mapping compares normalised `git remote get-url origin` per child dir, cached until workspaces change (`WorktreeService.ts:64-106`). `normalizeRemote` is host-agnostic today. **A work item cannot be launched until the repo is cloned locally** (`launchWorkItem.ts:119-120`, "not-cloned" is a return value).

**Provider seam** (designed, partially built): `src/shared/providers.ts` and `src/shared/workItems.ts` (commit `4c92e9d`) define `GitProviderId = 'github'`, `ProviderBinding`, `ProviderMeta` (cli name, login hint, seed headers), five `InboxRole`s, normalised `reviewDecision`. **Nothing outside their tests imports them yet**; `src/main/providers/` does not exist. The Phase B plan (`docs/superpowers/plans/2026-08-25-inbox-v2-phase-b-seam-and-model.md`) moves `GhBroker`/`parseInbox`/`GitHubService` behind a `GitProviderDriver` with `tokenEnvVar`, `probe`, `token`, `fetchInbox`, `checkout`, `cloneRepo`, `matchesRemote`, `workItemUrl`, `seedHeader`, and renames `github:*` channels to `provider:*`/`inbox:*`.

### 5. Persistence, windows, OS surface

**State files** all go through `JsonStateFile` (`src/main/state/JsonStateFile.ts`): `.bak` copy if parseable → `.tmp` with fsync → rename; read falls back to `.bak`; both unreadable → `StateFileCorruptError` → `dialog.showErrorBox` + `app.exit(1)` (`ipc-handlers.ts:86-100`). `userData` is suffixed ` Dev`/` Test` by `NODE_ENV` (`index.ts:27-32`); `app.setName('Consola')` must match `productName` or installed state is stranded.

**Workspace model** (`src/shared/workspace.ts`): `Workspace{id, name, defaultHarnessId, scopes[], groups[], github?, sessions[]}`; `Scope{id, name, path (absolute), isGitRepo}`; `Group{…, conductorSessionId?, archivedAt?}`; `Session{id, name, nameIsUserSet?, instanceId, claudeSessionId (UUID), hasStarted, harnessId, model?, scopeId, cwd?, groupId?, kind: 'interactive'|'conductor', workItem?}`. Record ids are `Math.random`+`Date.now` base36 (`:88-119`); only `claudeSessionId` is a real UUID. Migration ladder v<4/v<5/v<6 in `migrateWorkspaceState` (`:241-341`); Inbox v2 plans v7.

**Renderer localStorage**: live keys `consola-settings` (theme, font size), `consola-navigation` (sidebar prefs only — active workspace/session deliberately excluded because they are per-window identity), `react-resizable-panels:content-view-split`. Legacy `consola-workspaces`/`consola-harnesses` are read once for one-shot import into main (`workspaceStore.ts:118-168`, `harnessStore.ts:154-194`).

**Windows** (`src/main/window-manager.ts`): a workspace lives in at most one window, arbitrated in main (`'took' | 'focused-elsewhere'`); layout saved to `windows.json` on `before-quit`, restored with display-bounds validation; `lastHeldContext` so macOS "all windows closed, app alive, PTYs running" can reopen where it was.

**No file watching.** No chokidar/fs.watch anywhere; git status refreshes on focus (2 s debounce) and after actions; file tree lists on expand; index files are mtime-checked.

**OS APIs used in main**: `app.{setName,setPath,getPath,requestSingleInstanceLock,setBadgeCount,dock.hide,exit,quit}`, `dialog.{showOpenDialog,showErrorBox}`, `Notification` (rings once per needs-attention episode only while no window is focused, `attention.ts:13-29`, `ipc-handlers.ts:455-471`), `shell.openExternal` (one site, `window-manager.ts:67-72`), `screen.getAllDisplays`. Not used: `nativeTheme`, `clipboard`, `safeStorage`, keychain, `electron-store`.

**Conductor** (`src/main/conductor/`): a `kind:'conductor'` session whose "intelligence" is three template-rendered files at `<scopePath>/conductor/<name>/`; the CLI is given `--mcp-config <userData>/conductor-mcp/<sessionId>.json` pointing at `process.execPath` + `conductorShim.js` with `ELECTRON_RUN_AS_NODE=1`; the shim pipes stdio to a **Unix domain socket** at `os.tmpdir()/consola-conductor-<hex>.sock` (named pipe on Windows), authenticated by a per-conductor token on the first line; `ConductorControlServer` hosts an `McpServer` per connection with four tools (`consola_spawn_session`, `consola_send_prompt`, `consola_session_status`, `consola_group_status`), authority scoped to the calling conductor's group and re-resolved from records on every call (`ConductorControlServer.ts:26-29, 231-371`). The shim must be a real file on disk (`asarUnpack`).

**Packaging** (`electron-builder.yml`): mac arm64 only, `target: dir`, ad-hoc signed (`identity: null`), no publish, no auto-update. Electron 28, main is CommonJS.

**Tests**: `tests/fixtures/stub-gh/gh` stubs every `gh` argv (exit 64 on drift); e2e seeds `workspaces.json` directly and uses a **real `git`** on the host (`tests/e2e/inbox.spec.ts:12-24, 100-107`).

### 6. What each coupling implies for cloud management

The user explicitly asked how this could work in the cloud. This section stays at the level of "what the code binds, and what a hosted or self-hosted deployment would need to supply in its place" — the choices themselves are design work for a later document.

**6.1 Two very different meanings of "cloud".** The codebase supports both readings and they have different consequences:

- *Cloud-managed, locally-executed*: a hosted control plane holds workspaces/harnesses/actions and pushes them to a user's machine, where `claude`/`gh`/`git`/PTYs still run. Almost everything in §2–§4 stays as is; what moves is `workspaces.json`/`harnesses.json` ownership and the `workspace:*`/`harness:*` intent channels (§1), which are already main-authoritative and intent-shaped.
- *Cloud-executed*: sessions run on a remote worker. Then every item below that says "machine-local" has to be re-homed onto the worker, and the renderer↔main seam becomes a network seam.

**6.2 Harnesses are machine-local by definition.** `binaryPath`, `configDir`, `extraArgs`, and the login-shell PATH walk all name things on one host (§2). Three properties follow directly from the code:
- The **conversation lives where the harness's `configDir` is** (`<configDir>/projects/**/<sessionId>.jsonl`), and `--resume` only finds it there. A harness record moved to another machine without its config directory resumes nothing; `TerminalService` would silently fall back to a fresh session (`TerminalService.ts:263-267`).
- The **Claude login lives in the same directory** (`.claude.json` `oauthAccount`, plus whatever the CLI keeps for tokens — Consola never reads that). Consola has no way to create a login; `probeHealth` only reports one. On a cloud worker, "signed in" means the CLI on that worker has been logged in, or given `ANTHROPIC_API_KEY`, or given a mounted config dir. `research/2026-02-03-claude-code-integration-and-oauth.md:172-183` records that Claude Code OAuth tokens are restricted to the official CLI, so a hosted service cannot hold users' Claude OAuth for them; it can only host a `claude` process that owns its own login.
- The **capabilities cache key is the launch signature** (`binaryPath`, `configDir`, `extraArgs`), so a per-worker cache falls out naturally; the probe itself runs user `SessionStart` hooks on whichever host executes it.

A cloud-shaped harness record would therefore need a notion of *where* it launches (this machine / worker X / a container image) that the `Harness` type does not have today; `driverId` is the only existing discriminator, and the CLAUDE.md invariant that nothing branches on a driver id is what makes a "remote driver" a plausible extension point (`HarnessDriver` in `src/main/drivers/HarnessDriver.ts`).

**6.3 `gh` is a keyring on one machine.** `gh auth token --user <login>` reads the local keyring; `GH_TOKEN` is layered into the PTY and every subprocess (§4). Nothing in Consola stores or refreshes a GitHub token, and `stripTokenLines` exists precisely because tokens must never reach a renderer. For cloud execution, the equivalent is a `gh` on the worker that is already authenticated (or a `GH_TOKEN` provisioned into the worker env, e.g. from a GitHub App installation) — `composeGhEnv`/`layerGhToken` are the two seams where that env is built. The designed `GitProviderDriver.token()`/`tokenEnvVar` (Phase B) is where a non-keyring source would plug in. Two accounts concurrently is a stated requirement (`GhBroker.ts:14-16`), so any replacement is per-binding, not global.

**6.4 Repos, scopes, and worktrees are absolute local paths.** `Scope.path` is immutable identity (`updateFilters.ts:28-42`); repo discovery is `fs.existsSync(<path>/.git)` and `readdir` one level down; work items require a local clone; worktrees live under `~/.consola/worktrees`; conductors write into `<scopePath>/conductor/`. A cloud worker needs its own clone (the `gh repo clone` path in `cloneRepo.ts` already exists and adds a scope afterwards) and its own worktree root (`CONSOLA_WORKTREES_DIR` is already an env override). The file explorer and git review panel read the same filesystem with no root confinement (`ipc-handlers.ts:694-722`), so they inherently operate on wherever main runs.

**6.5 PTY bytes and screen state are process-local.** `terminal:data` is owner-window-only and the `ScreenModel` lives beside the PTY; remount replays `snapshot()` (§3). Any remote execution needs a byte stream from worker to viewer plus a snapshot on attach — which is exactly the shape `TerminalManager.ensure()` already returns (`{replay, exited}`), and the status/attention channels are already broadcast + snapshot-on-join. The delivery guard is pure screen-text classification with no hooks, so it works identically wherever the PTY lives, but it also means Consola has no out-of-band signal from the CLI today; the research doc's unbuilt `Stop`-hook idea would require a URL/socket reachable from the CLI's host.

**6.6 Conductors use a Unix socket and the Electron binary as Node.** The MCP config hardcodes `process.execPath`, `conductorShim.js` on disk, a `tmpdir` socket, and `ELECTRON_RUN_AS_NODE` (§5). All four assume the CLI and the Consola main process share a host. The tool logic in `ConductorControlServer` is transport-independent (`StdioServerTransport(socket, socket)`), but the shim/socket pairing and the "authenticated by which socket it arrived on" model are local-host constructs.

**6.7 State that is already portable vs. not.**
- Portable as data: `Workspace` names, `Group`s, `Session` metadata (`name`, `kind`, `groupId`, `workItem`, `model`, `claudeSessionId`), `Harness` names/colours/enabled/archived, the upcoming v7 actions and provider bindings. All main-owned, intent-mutated, allow-list filtered, versioned with migrations.
- Bound to one host: `Scope.path`, `Session.cwd`, `Harness.binaryPath`/`configDir`, `windows.json`, worktree paths, conductor briefs, and — crucially — the transcripts themselves, which are the CLI's and not Consola's.
- UI-only: `localStorage` prefs.

**6.8 OS surface that has no cloud equivalent.** Native folder pickers (`dialog.showOpenDialog`), `Notification` + dock badge, `shell.openExternal`, drag-and-drop `File.path`, multi-window arbitration and `windows.json`. These are the pieces `research/2026-02-17-…:50-63` rated as Electron-coupled; they belong to whatever is the local client.

**6.9 Assumptions a self-hoster would inherit.** Login shell with `-ilc 'env -0'`; `git` on PATH unprobed; `gh` optional; `claude` resolved from PATH or three Unix fallback dirs; `os.homedir()` writable; `xterm-256color` PTY; native `node-pty` built for the exact runtime; macOS-specific reasoning in `describeCwdProblem`; packaging is mac arm64 `dir` only. `CONSOLA_GH_PATH` and `CONSOLA_WORKTREES_DIR` are the only existing environment seams; there is no `CONSOLA_GIT_PATH` or claude-path override beyond the per-harness `binaryPath`.

## Code References

- `src/shared/constants.ts:5-107` — every IPC channel; `:117-160` renderer driver descriptors
- `src/preload/preload.ts:47-357` — nine `contextBridge` globals; `:346-355` window context from launch arg
- `src/shared/harness.ts:38-64, 90-104` — `Harness` record, built-in harness
- `src/main/state/HarnessService.ts`, `WorkspaceService.ts`, `JsonStateFile.ts`, `updateFilters.ts` — single-writer state, atomic writes, allow-lists
- `src/main/LoginEnvironment.ts:23-97` — login-shell env probe and `CLAUDE_CODE_*` stripping
- `src/main/drivers/ClaudeDriver.ts:28-32, 131-157` — binary resolution; `:167-176` argv; `:185-188` env; `:190-233` health; `:284-321` headless
- `src/main/drivers/claudeCapabilities.ts:26-44, 75-187` — stream-json initialize handshake
- `src/main/HarnessCapabilitiesCache.ts:90-97` — launch-signature cache key
- `src/main/ClaudeSessionIndex.ts:39-88` — reading the CLI's `projects/` storage
- `src/main/TerminalService.ts:209-293` — PTY spawn, resume-retry; `:381-431` delivery guard
- `src/main/TerminalManager.ts:41-89, 137-190` — ensure/startHeadless, owner-vs-broadcast routing
- `src/main/ScreenModel.ts` — headless xterm snapshot
- `src/main/github/GhBroker.ts:7-16, 78, 92-94, 166-225` — credential posture, scrubbing, token layering, `gh` resolution
- `src/main/github/GitHubService.ts:11-13, 109-141` — inbox cadence, GraphQL subprocess, degrade-not-dialog
- `src/main/github/parseInbox.ts:13-44` — the one GraphQL query
- `src/main/github/cloneRepo.ts`, `launchWorkItem.ts:63-120` — clone and launch flows
- `src/main/WorktreeService.ts:18-36, 52-57, 64-106, 170-253` — remote matching, worktree root, git commands
- `src/main/scopeRepos.ts:13-38` — repo discovery
- `src/main/ipc-handlers.ts:327-330` — `composeGhEnv`; `:694-722` file reads; `:726-1075` shell git; `:500-509` conductor MCP dir and shim path
- `src/main/conductor/ConductorControlServer.ts:107-140, 173-223, 231-371, 417-422` — socket endpoint, auth, tools, socket path
- `src/main/conductor/conductorShim.ts` — 34-line stdio↔socket pipe
- `src/shared/workspace.ts:12-83, 88-119, 241-341` — records, id generators, migrations
- `src/shared/providers.ts`, `src/shared/workItems.ts` — provider-neutral vocabulary (unconsumed)
- `src/main/window-manager.ts:7-15, 59-62, 199-357` — one-workspace-per-window, layout persistence
- `src/main/attention.ts:13-34`, `ipc-handlers.ts:437-471` — notification policy, badge
- `electron-builder.yml` — mac arm64 `dir`, ad-hoc signing, `asarUnpack`
- `research/2026-02-17-platform-architecture-migration-analysis.md` — prior (unadopted) self-hosted platform proposal
- `research/2026-02-03-claude-code-integration-and-oauth.md:172-214` — Claude OAuth restriction to the official CLI
- `docs/superpowers/specs/2026-08-25-inbox-actions-and-provider-seam-design.md`, `docs/superpowers/plans/2026-08-25-inbox-v2-phase-{a,b,c,d}-*.md` — Inbox v2 phases

## Architecture Documentation

Patterns the code relies on that any cloud-shaped evolution would meet first:

1. **CLI owns the conversation; Consola owns the workspace.** No chat, permissions, or history are reimplemented. Transcripts, logins and slash-command menus are the CLI's, read from its config directory or asked over stream-json.
2. **Zero stored credentials.** Claude login lives with the CLI; GitHub tokens are borrowed from `gh` for minutes and composed into env at two seams only. Errors are scrubbed before crossing IPC.
3. **Main is the authority; renderers send intents.** State files are atomic JSON with backups; payloads are rebuilt from allow-lists; identity-bearing fields (`harnessId`, `scopeId`, `cwd`, `claudeSessionId`, `Scope.path`) are immutable by omission.
4. **Drivers hide the CLI.** `HarnessDriver` is the only place that knows `claude`'s argv/env/wire format; the provider seam is designed to do the same for `gh`. Both are `id` unions that nothing else may branch on.
5. **Everything network-shaped is a subprocess.** `gh`, `git`, `claude`; no HTTP client in JS.
6. **Edge events + snapshot endpoints.** Status pushes are edges; every consumer that can join late has a snapshot (`terminal:status-snapshot`, `getReplayBuffer`, `github:get-inbox`).
7. **Pull, not watch.** No filesystem watchers; refresh on focus/action/interval.
8. **Same-host assumptions in the conductor path**: Electron binary as Node, on-disk shim, tmpdir socket.

## Open Questions

- Which "cloud" is meant first — a hosted control plane over local execution, or remote execution of sessions? The code supports the former with far fewer moving parts (§6.1).
- Where does a cloud worker's `claude` login come from (mounted `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, per-user interactive login on the worker)? Consola currently only *reads* login state and cannot create it.
- Does the GitHub side stay on `gh` (worker-side keyring / `GH_TOKEN` in env) or move to a GitHub App? The Phase B `GitProviderDriver.token()` is the seam either way; the "two accounts at once" requirement must survive.
- Transcript ownership: sessions are only resumable beside their `configDir`. Does a hosted product treat transcripts as worker-local state, or sync them?
- The conductor MCP transport (Unix socket + Electron-as-Node shim) has no remote form today; the tool logic does.
- `Scope.path`/`Session.cwd` are absolute and immutable — a per-host path mapping does not exist in the model.
- The delivery guard is screen-text-only; the unbuilt hook-based signal would need a CLI-reachable endpoint on whichever host runs the CLI.
