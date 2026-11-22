# AGENTS.md

This file guides coding agents working in `packages/host` (`@consola/host`).
`CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads it too. The
repository's guide is the root `CLAUDE.md`. Paths below are relative to
`packages/host`.

The host runs t3code's agent adapters (vendored under `vendor/t3code/`) for one
Consola session and serves t3's chat RPC to a browser.

## The rings

Imports point inward only; `src/boundary.test.ts` fails on any that does not.

- `src/core/` holds the pure decisions and the types they speak of: which
  commands are offered (`decideCommand`), whether a session pass's claims hold
  (`checkPassClaims`), when the host is idle (`isIdle`) and `SessionSpec`. No
  `node:` builtin, no `effect/process`, `ws` or `jose`, and no global that
  touches the machine (`process`, `fetch`, `WebSocket`, timers). It may name the
  vendored `@t3tools/contracts`.
- `src/runtime/` holds Effect services over the vendored t3 packages. It may
  import them (by package name, or `t3/<path>.ts` for a lifted server file) and
  `core/`, never `adapters/`.
- `src/adapters/` is everything that touches the outside: the WebSocket server,
  verifying a pass's signature, process I/O. It may import `core/` and
  `runtime/`.
- `src/bin.ts` is the only wiring: it builds the adapters and hands them to the
  runtime.
- `src/testing/` is what tests share: `machine.ts` (a machine of a test's own,
  with fake CLIs) and `setup.ts` (Vitest's setup file, which isolates the whole
  test process; "Tests" below). No other ring reaches it, so only `*.test.ts`
  files and `vite.config.ts` use it; it may use the test runner and t3's test
  kits.

To add a ring, add a row to `LAYERS` and a case to the table in
`boundary.test.ts`. Test files are exempt from the layer rules, but never import
another `@consola/*` package: the host stands alone.

## Vendored t3 code is imported, never copied

The agent adapters, contracts and chat RPC come from `vendor/t3code/` and are
imported by their package names. Never copy t3 code into `packages/host`, and
never edit a vendored file from here. A change to a vendored file is recorded in
`vendor/t3code/UPSTREAM.md` with its reason, in the same commit.

## The thread runtime

`src/runtime/` runs one t3 thread per Consola session, the thread id being the
session id. It composes t3's production orchestration and writes no command
handling, ingestion or projection of its own.

- `orchestration.ts`: `layerOrchestration`, t3's `runtimeLayer.ts` `layer` (the
  orchestration core: orchestrator, ingestion, run execution, provider
  sessions, effect worker, title generation) plus its
  `layerEventInfrastructure` and t3's provider-continuation worker, over the
  infrastructure t3's `server.ts` builds for it, less the HTTP server: t3's
  `ServerConfig` paths under the state folder (`<stateDir>/userdata/…`),
  in-memory `node:sqlite`, t3's settings service (shipped defaults,
  `<stateDir>/userdata/settings.json`), t3's `ProviderHostLive` over that same
  config and settings, the model manifest, git and source control, and t3's
  `ProviderInstanceRegistry` hydrated from `HOST_DRIVERS`.
  `startOrchestration` runs t3's startup order (`serverRuntimeStartup.ts`):
  settings, recovery, delegated tasks, then the effect worker; closing the
  scope shuts the providers down.
- `threadRuntime.ts`: `ThreadRuntime.open(spec)` builds that in the caller's
  scope, files the session's folder as its project (t3 takes a turn's cwd from
  its project) and dispatches `thread.create`.
- `drivers.ts`: `HOST_DRIVERS`, t3's `BUILT_IN_DRIVERS` for the five harnesses
  (never Cursor), each wrapped by `withoutCliCredentialsDriver`, and each
  harness's default model. The unguarded list is not exported, and
  `layerOrchestration` takes no drivers: it always hydrates `HOST_DRIVERS`.
- `credentials.ts`: the guard that keeps every driver off a CLI's login (below).
- `standIns.ts`: services that are not t3's own (below, with the rest).

### The handle

```ts
type ThreadHandle = {
  snapshot(): OrchestrationV2ThreadProjection; // t3's getThreadSnapshot, kept current
  snapshotSequence(): number; // the last stored event snapshot() holds
  events(afterSequence?: number): Stream<OrchestrationV2StoredEvent, ThreadRuntimeError>;
  dispatch(command: OrchestrationV2Command): Effect<void, NotOfferedError | ThreadRuntimeError>;
  lastActivityMs(): number;
};
```

- `snapshot()` is refreshed on every stored event by t3's unbounded
  `streamStoredEvents`, so a pending approval is there with no client
  connected. Project it for the wire before sending, as t3's `ws.ts` does.
- `events(after)` is t3's `streamStoredEventsFrom({ threadId, afterSequence })`:
  stored events replayed, then live, projected for the wire. To join a
  snapshot, read `snapshotSequence()` and `snapshot()` together and pass that
  sequence: no event is missed or repeated (Review Focus 2).
- `dispatch` asks `decideCommand` first and refuses anything not offered with
  `NotOfferedError`, before t3 sees it.

### The host never starts a CLI in full access

Every thread opens in `approval-required` (`HOST_RUNTIME_MODE`): the CLI asks
before running a command or writing a file, and the chat shows the request.
t3's own default (`DEFAULT_RUNTIME_MODE`) is `full-access`, which asks nothing;
the host never uses it, and `SessionSpec` has no field to ask for it.
Tests that replay a fixture recorded in another mode, or substitute t3's replay
adapter, use `layerForTests(options, { drivers, runtimeMode })`, which builds on
`layerOrchestrationForTests(options, drivers)`. `boundary.test.ts` refuses
every use of a name ending in `ForTests` outside `*.test.ts` (a call, a
namespace member, an import under another name), except in the body of another
seam that is a function (code that runs only when a test calls it, never as a
module loads), so no host code can reach a seam; `layer(options)` takes
neither, and `layerOrchestration(options)` always hydrates `HOST_DRIVERS`.

### The CLIs inherit the host's environment

`ThreadRuntimeOptions` is the state folder alone: there is no environment
option. Each CLI inherits the host process's environment, as in t3, which is
where it finds its own login. t3 reads that environment two ways. Claude's
driver (`apps/server/src/provider/Drivers/ClaudeDriver.ts:124`) and
`mergeProviderInstanceEnvironment` (OpenCode's and Pi's drivers;
`packages/provider-core/src/server/instanceEnvironment.ts:9`) read
`process.env` itself. Codex's and the ACP registry's drivers, the run adapters
(Claude, Codex, OpenCode, Pi), Claude's maintenance probe and every home lookup
read t3's `HostProcess.Environment` and `HostProcess.HomeDirectory`: Effect
context references whose defaults (`process.env`, `os.homedir()`) are computed
once and cached for the process. The composition provides both from
`process.env` and `os.homedir()` each time it is built (`layerServerBase`), so
the two ways agree: the `HOME` a CLI starts with is t3's home directory (on
macOS and Linux `os.homedir()` is `$HOME`). For the drivers, t3's managed
policy may drop launch overrides from that environment, as in t3's own
hydration.

### The host never reads a CLI's login

A CLI keeps its own login and is the only thing that reads it. t3's drivers
read some logins themselves; the host keeps them from it:

- **Claude.** `ClaudeDriver.ts:288` passes `readClaudeResetCredits` into its
  status probe, and `:373` calls `consumeClaudeResetCredit`. Off macOS (which
  keeps the login in the keychain) they read `<configDir>/.credentials.json`
  → `claudeAiOauth.accessToken` (`claudeResetCredits.ts:194`) and send it as
  `Authorization: Bearer` to `api.anthropic.com/api/oauth/usage` (`:216`) and
  `…/api/organizations/<org>/reset_rate_limits` (`:285`). The driver reads the
  file and the network through the file system and HTTP client in its
  environment, so `withoutCliCredentialsDriver` creates it with a file system
  on which a login file (`.credentials.json`, `auth.json`) reads as missing and
  an HTTP client that refuses `api.anthropic.com`, `opencode.ai`,
  `api.openai.com` and `auth.openai.com`. The probe then finds no token and
  sends nothing (`credentials.test.ts`).
- **OpenCode.** Its status probe reads OpenCode Go usage
  (`usageLimits.ts`): the API key from `<XDG_DATA_HOME>/opencode/auth.json`
  (`:107`) and from OpenCode's own `opencode.db` `credential` table, opened
  directly with `node:sqlite` (`:55`, `:128`), sent as a bearer token to
  `opencode.ai/zen/go/v1/usage` (`:139`). The database read has no seam, so
  Consola's copy of `provider-opencode/src/server/driver.ts:470` passes
  `enabled: false` to it (a local change, `vendor/t3code/UPSTREAM.md`); the
  guard also blocks the file and the host.
- **Codex.** In its default (`existing`) mode t3 reads no login: usage and
  reset credits go through `codex app-server` (`CodexDriver.ts:369`), and
  `auth.json` is only watched by name (`:406-409`). Its `managed` mode
  (`CodexDriver.ts:171`) has t3 sign a ChatGPT account in itself, keep the
  tokens in its secret store and send them to OpenAI
  (`CodexManagedProvider.ts:148`, `CodexManagedTokenBroker.ts:162`); the host
  never hydrates a managed Codex instance (`isManagedCodex`), and its secret
  store keeps nothing anyway.
- **Pi.** None: it asks `pi auth check` (`status.ts:355`).
- **ACP registry.** None: an agent signs itself in, and the env-var methods
  read secret-backed settings fields, which the host's secret store never
  holds.

What the host does read is account metadata, not a credential: Claude's
`.claude.json` (`<configDir>/.claude.json`, or `~/.claude.json` with no custom
config folder), `oauthAccount.organizationUuid` and `oauthAccount.accountUuid`
(`claudeResetCredits.ts:238`, `ClaudeSkills.ts:445-452`). The organization id
becomes the provider snapshot's `auth.workspaceId` (`ClaudeDriver.ts:221`), so
it reaches the browser with the provider list; the account id names the folder
of the account's synced plugins.

### What `open` does on the person's machine

Each `open` hydrates t3's provider instances from `HOST_DRIVERS`, as t3's
server does. With t3's defaults those are Claude and Codex: OpenCode and Pi
are off until enabled (`DEFAULT_DISABLED_PROVIDER_DRIVERS`,
`packages/contracts/src/settings.ts`), and the ACP registry has no instance
until an agent is configured (`hasDefaultInstance: false`). For each enabled
CLI it finds (on the `PATH`, or at a configured `binaryPath`), its driver:

- runs it to read its version (`claude --version`, `codex --version`,
  `opencode --version`, `pi --version`); Codex's also starts
  `codex app-server -c thread_unload_delay_secs=0`;
- for Claude, once `--version` answers, runs t3's capabilities probe
  (`apps/server/src/provider/ClaudeProvider.ts:271-305`, `:520-575`): the Agent
  SDK starts `claude` with `persistSession: false`, `settings:
  { disableAllHooks: true }` (no hook runs, `SessionStart` included), the
  user, project and local setting sources (for slash commands), `allowedTools: []`,
  `mcpServers: {}` with `strictMcpConfig` and claude.ai MCP servers off
  (`ENABLE_CLAUDEAI_MCP_SERVERS=false`), and a prompt that never yields, so no
  turn reaches the API; it reads the CLI's initialization result (commands,
  agents, models, account), then its usage and settings;
- works out how the CLI was installed, which can run the tool that installed
  it (`mise`, `npm`, `pnpm`, `bun`, Vite+'s `vp`, Homebrew's `brew`, MacPorts'
  `port`; `packages/provider-core/src/server/maintenanceResolver.ts`), and
  reads Claude's managed settings and their drop-ins (`managed-settings.json`,
  `managed-settings.d/`; `ClaudeMaintenance.ts:58-68`);
- with `enableProviderUpdateChecks` on (t3's default), looks up the CLI's
  latest version (npm, mise, `downloads.claude.ai`, `releases.openai.com`), and
  t3 fetches its model manifest from GitHub (`raw.githubusercontent.com`).

It also reads Claude's account metadata (above). A thread's first message asks
t3's title model (Codex by default, `textGenerationModelSelection`; the first
enabled instance in t3's fallback order when Codex's is not,
`packages/shared/src/serverSettings.ts:63-108`) for a title:
`codex mcp list --json`, then
`codex exec --ephemeral --skip-git-repo-check -s read-only …`
(`apps/server/src/textGeneration/CodexTextGeneration.ts`).

### Stand-ins

Everything in the composition is t3's own, but these. Each is the smallest
version that keeps what is built on it working.

- `layerSecretStore` for `ServerSecretStore`: t3's keeps logins and API keys
  on disk. The host keeps none: reading finds nothing, writing fails; the
  random values t3 makes for itself (an environment id) live in memory.
- `layerMcp` for `McpSessionRegistry` and `McpProviderSessions`: t3 gives each
  provider session an MCP server of its own tools, served by its HTTP server
  (`McpSessionRegistry.layer` needs `HttpServer`). The host serves none, so it
  records no provider MCP session and a CLI starts without one.
- `layerTerminals` for `TerminalManager`: t3's terminals are PTYs
  (`node-pty`), which the host does not carry; it runs no project setup script.
  Every terminal reads as not running.
- `withoutCliCredentialsDriver` around each of t3's drivers (`credentials.ts`,
  above), and the managed-Codex filter on the instance configs.
- `ServerConfig`'s values (its paths are t3's `deriveServerPaths`).
- `HostPowerMonitor` from t3's own `make()`, with no desktop app reporting the
  host's power state (t3's `layer` reads a desktop telemetry channel).
- `PortScanner.layerTest`, t3's `Layer.mock`: `trackAgent` and
  `watchAgentCommandStops` do nothing; `scan` and `subscribe` are not
  implemented and die if called (only t3's preview RPC calls them).
- `ProviderEventLoggers.NoOpProviderEventLoggers`, t3's no-op value.

Not composed: t3's HTTP server and routes, keybindings, legacy thread import, the settings watcher
that re-hydrates providers on a settings change, and the rest of
`layerProduction` (scheduled tasks, guest shares, worktree branch sync,
usage-limit recovery, agent session import).

t3 logs go to stderr (`Logger.LogToStderr`), so stdout stays free for the
host's own output.

### The Cursor SDK is in the runtime's module graph

`threadRuntime.ts` reaches `@cursor/sdk` through static imports, because t3's
orchestration does (a transitive import walk finds 19 files that import it):

- `t3/orchestration-v2/Orchestrator.ts` → `RunExecutionService.ts` →
  `RunFinalizationService.ts` → `vcs/VcsStatusBroadcaster.ts` →
  `git/GitWorkflowService.ts` → `git/GitManager.ts` →
  `project/ProjectSetupScriptRunner.ts` → `terminal/Manager.ts` →
  `provider/ProviderInstanceRegistryHydration.ts` →
  `provider/ProviderOrchestrationAdapterInfrastructure.ts` →
  `@t3tools/provider-cursor/server/CursorAgentSdk` (and
  `CursorAgentSdkProcessRunner`); also `ProviderInstanceRegistryHydration.ts`
  → `provider/builtInDrivers.ts` → `@t3tools/provider-cursor/server`.
- `orchestration.ts` → `provider/ProviderOrchestrationAdapterInfrastructure.ts`
  (for `layerIdAllocator`) → the same modules; `standIns.ts` →
  `terminal/Manager.ts` → the same.

`drivers.ts` and `credentials.ts` reach none of it. Nothing here is bundled:
the host runs from source, and nothing it runs calls the Cursor SDK (no Cursor
driver is hydrated). The host bundle (Track B, CON-93) must keep `@cursor/sdk`
out, by marking it external or stubbing `@t3tools/provider-cursor/server*`, and
must check the output (no `@cursor/sdk` in the bundle) before it ships.

### Tests

The drivers read the test process's own environment (above), so the tests
isolate that process, not the runtime's options, in two layers:

- **The process** (`src/testing/setup.ts`, Vitest's `setupFiles`). Before
  each test file is imported, so before any t3 module could read the
  environment, `HOME`, `USERPROFILE` and the XDG folders become a temporary
  home of the process's; every CLI config, login or install variable is
  deleted (the ones t3's five drivers and the install probes read, listed in
  `machine.ts` from their source: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `OPENCODE_*`, `PI_CODING_AGENT_DIR`, `MISE_*`, `VP_HOME`, API keys, …, and
  every variable under t3's own test prefixes, `ANTHROPIC_`, `CLAUDE_`,
  `CODEX_`, `OPENAI_`, `T3CODE_`); and `PATH` becomes a trap: fake `claude`,
  `codex`, `opencode` and `pi` before `/usr/bin:/bin`. A CLI started outside a
  test's own machine (from an environment copied as a module loaded, or by
  work that outlives a test) lands on the trap, and the test file fails.
- **Each test** that composes the orchestration (`isolateMachine`,
  `src/testing/machine.ts`, with `vi.stubEnv`, restored after the test):
  another temporary home and a `PATH` of fresh fakes before `/usr/bin:/bin`,
  with the same variables cleared. A fake records its call (its `HOME`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and arguments) and exits 1. After each test
  every recorded call must have seen that test's home and no config folder.
  The probe test turns OpenCode and Pi on, so all four drivers run against the
  fakes; the missing-CLI tests take the fake `claude` away
  (`withoutCli('claude')`) or point `binaryPath` nowhere, and check that no
  `claude` ran.

No CLI of the developer's can run: every `PATH` a test process has holds only
fakes, `/usr/bin` and `/bin`, and no home it has is the developer's.
`CONSOLA_HOST_CLI_RECORD=<file>` copies both records out (a line per call, or
`(no CLI ran)`). t3's settings file turns update checks off, `fetch` is
stubbed, and any request fails the test.

The replay tests compose the same production orchestration through
`layerForTests`, with one change: the host's guarded Claude driver whose
adapter is t3's Claude replay adapter. Test kits (`@t3tools/provider-testing`, any `…/testing` entry, any
`testkit` module) are imported only from `*.test.ts` files; `boundary.test.ts`
refuses them anywhere else.

## Running it

```bash
pnpm --filter @consola/host test        # vp test run (Vite+), config in vite.config.ts
pnpm --filter @consola/host typecheck   # effect-tsgo, hoisted by publicHoistPattern
```

## Licensing

`@consola/host` is AGPL-3.0-only, Consola's own code. The vendored packages keep
t3's MIT licence (`vendor/t3code/LICENSE`).

- The host runs the person's installed CLI with its existing login. It never
  shows a sign-in, never stores a credential, never reads a CLI's login file
  or token, and never sends one ("The host never reads a CLI's login", above);
  it reads Claude's account metadata (`.claude.json` `oauthAccount`
  organization and account ids), and the organization id reaches the browser
  in the provider snapshot. It passes `pathToClaudeCodeExecutable` for Claude,
  never the SDK's bundled copy.
- The Cursor SDK (`@cursor/sdk`) is never bundled into anything the host builds.
- Nothing that bundles `@anthropic-ai/claude-agent-sdk` is published or released
  (Linear CON-21). Local builds are fine.
- Fixtures and examples use Acme, Sprocket and the `sprocket` org, never real
  names.
