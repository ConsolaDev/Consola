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
  (`checkPassClaims`), when the host is idle (`isIdle`: no client, no running
  turn, nothing done for the idle minutes) and `SessionSpec`. No
  `node:` builtin, no `effect/process`, `ws` or `jose`, and no global that
  touches the machine (`process`, `fetch`, `WebSocket`, timers). It may name the
  vendored `@t3tools/contracts` and `@consola/runner-protocol` (below). The
  runner's decisions live here too (`runnerDecisions.ts`, "The `runner`
  command"), and the host's stdout lines (`hostLine.ts`: `HostLine` and its
  reader).
- `src/runtime/` holds Effect services over the vendored t3 packages. It may
  import them (by package name, or `t3/<path>.ts` for a lifted server file) and
  `core/`, never `adapters/`.
- `src/adapters/` is everything that touches the outside: the WebSocket server,
  verifying a pass's signature, the dev pass (`devPass.ts`), the lines on
  stdout (`stdoutEvents.ts`), and the runner's sandboxes (`sandboxSessions.ts`)
  and its socket to the cell (`cellSocket.ts`). It may import `core/` and
  `runtime/`.
- `src/bin.ts` is the only wiring: it parses the command line, builds the
  adapters and hands them the runtime (`consola-host session`, below), or a
  sandbox provider (`consola-host runner`, below).
- `src/testing/` is what tests share: `machine.ts` (a machine of a test's own,
  with fake CLIs), `setup.ts` (Vitest's setup file, which isolates the whole
  test process; "Tests" below), `replay.ts` (sessions whose Claude driver
  replays one of t3's recorded fixtures), `t3Client.ts` (t3's RPC client,
  connected as `@t3tools/client-runtime` connects it), `replaySession.ts`
  (the session command over a replay, which `bin.test.ts` starts with node),
  `localProvider.ts` (a `SandboxProvider` whose sandboxes are a temporary
  folder and a `replaySession.ts` process, its ports `http://127.0.0.1:<port>`)
  and `replayRunner.ts` (the runner command over it).
  No other ring reaches it, so only `*.test.ts` files, `vite.config.ts` and a
  test's `node` use it; it may use the test runner, t3's test kits and test
  seams, and reach `bin.ts` to run its command.

  `@consola/agent-ui`'s browser tests use it too, by path, so a change here can
  break them: their global setup (`packages/agent-ui/src/testing/hostSession.ts`)
  imports `machine.ts` (`writeFakeClis`, `readCalls`, `cliVariablesIn`,
  `homeVariables`, `pathWith`) and spawns `replaySession.ts` with node, passing
  `simple full-access session --pass-public-key … --session-id … --harness claude
  --port 0`; its `sendFixtureMessage.ts` imports `t3Client.ts` (`hostSocketUrl`,
  `connectT3Client`) and `replay.ts` (`loadReplay`, `sendMessage`). Run
  `pnpm --filter @consola/agent-ui test` after changing any of these.

To add a ring, add a row to `LAYERS` and a case to the table in
`boundary.test.ts`. Test files are exempt from the layer rules.

No file imports another `@consola/*` package, tests included, but two, each by
its own name and never a path inside it (`@consola/sandbox/dist/index.js` is
refused): `@consola/runner-protocol` (MIT), what a runner and its cell say to
each other, which does no I/O, so every ring may name it; and
`@consola/sandbox`, the interface the runner starts sandboxes through, in
`adapters`, `testing` and `bin.ts` only, never `core` or `runtime`. A test file
takes the list of the module it sits beside (`adapters/x.test.ts`
`adapters`'s, `bin.test.ts` `bin`'s). Each is its layer's `consola` list in
`LAYERS`, with a case in the table for every ring.

## Vendored t3 code is imported, never copied

The agent adapters, contracts and chat RPC come from `vendor/t3code/` and are
imported by their package names. Never copy t3 code into `packages/host`, and
never edit a vendored file from here. A change to a vendored file is recorded in
`vendor/t3code/UPSTREAM.md` with its reason, in the same commit.

One exception, and only this one: `src/adapters/rpcServer.ts` reproduces a few
small helpers private to t3's `apps/server/src/ws.ts`, which is not lifted (it
is t3's whole RPC server) and exports none of them: `withoutWorkspaceSnapshots`
(less its machine-catalog branches), `withProviderStatusDeltas`,
`hasCompatibleOrchestrationProtocol`, `readSettingsClient`, the values of
`WS_RPC_SERVER_OPTIONS` and `PROVIDER_STATUS_DEBOUNCE_MS`, the `426` answer to an
incompatible protocol, and the frame-parts wrapping of the socket. Each is
marked with its `ws.ts` lines in the code, and `vendor/t3code/UPSTREAM.md`
("The host RPC server lift") lists them with those lines, so a re-sync diffs
them. Anything else `ws.ts` reaches for is imported from the lifted tree; a
helper that lives in its own module is lifted, never reproduced.

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
  `ProviderInstanceRegistry` hydrated from one driver, the session's harness's
  (`hostDriverFor`), with t3's `ProviderRegistry` (its provider list) over it.
  t3's Codex installation service is composed only for a Codex session
  (`layerNoCodexInstallation`, "Stand-ins").
  `startOrchestration` runs t3's startup order (`serverRuntimeStartup.ts`):
  settings, recovery, delegated tasks, then the effect worker; closing the
  scope shuts the providers down.
- `threadRuntime.ts`: `ThreadRuntime.open(spec)` builds that for the session's
  harness in the caller's scope, points t3's thread titles at the session's
  provider (below), files the session's folder as its project (t3 takes a
  turn's cwd from its project) and dispatches `thread.create`.
- `drivers.ts`: `HOST_DRIVERS`, t3's `BUILT_IN_DRIVERS` for the five harnesses
  (never Cursor), each wrapped by `withoutCliCredentialsDriver`; `hostDriverFor`,
  the one of them a harness runs; each harness's default model; and
  `titleModelSelection`, where its titles go. The unguarded list is not
  exported, and `layerOrchestration` takes no drivers: it hydrates
  `hostDriverFor(harness)` alone.
- `credentials.ts`: the guard that keeps every driver off a CLI's login (below).
- `standIns.ts`: services that are not t3's own (below, with the rest).

### The handle

```ts
type ThreadHandle = {
  snapshot(): OrchestrationV2ThreadProjection; // t3's getThreadSnapshot, kept current
  snapshotSequence(): number; // the last stored event snapshot() holds
  snapshots(): Stream<OrchestrationV2ThreadProjection>; // snapshot() now, then each newer one
  events(afterSequence?: number): Stream<OrchestrationV2StoredEvent, ThreadRuntimeError>;
  dispatch(
    command: OrchestrationV2Command,
  ): Effect<{ sequence: number }, NotOfferedError | ThreadRuntimeError>;
  commandOutput(itemId: TurnItemId): Stream<OrchestrationV2CommandOutputFrame, OrchestrationV2CommandOutputError>;
  server: ThreadServerView; // what the server-config and provider RPCs read
  lastActivityMs(): number;
};

type ThreadServerView = {
  providers: ProviderRegistry; // t3's, over the hydrated ProviderInstanceRegistry
  settings: Effect<ServerSettings, ServerSettingsError>; // t3's settings service
  settingsChanges: Effect<Stream<ServerSettings>, never, Scope>;
  cwd: string; // the session's folder
  keybindingsConfigPath: string; // t3's config paths
  logsDir: string;
};
```

- `snapshot()` is refreshed on every stored event by t3's unbounded
  `streamStoredEvents`, so a pending approval is there with no client
  connected. Project it for the wire before sending, as t3's `ws.ts` does.
  `snapshots()` is the same projection as a stream: the current one, then
  each that replaces it, after the refresh, so a reader never sees an event
  before `snapshot()` holds it.
- `events(after)` is t3's `streamStoredEventsFrom({ threadId, afterSequence })`:
  stored events replayed, then live, projected for the wire. To join a
  snapshot, read `snapshotSequence()` and `snapshot()` together and pass that
  sequence: no event is missed or repeated (Review Focus 2).
- `dispatch` asks `decideCommand` first and refuses anything not offered with
  `NotOfferedError`, before t3 sees it. It answers t3's dispatch result, the
  sequence the command's events were stored at; a command id t3 already
  accepted is not run again (t3 answers its first sequence).
- `commandOutput(itemId)` is t3's `CommandOutputHub.subscribe` for one of the
  thread's command rows: the hub its provider sessions write to.
- `server` hands out the services of the composition t3's `ws.ts` builds its
  server config and provider list from, so nothing served is made up: t3's
  `ProviderRegistry` (one snapshot per provider instance, its changes and
  refreshes), its settings and their changes, the session's folder and t3's
  config paths.

## The WebSocket server

`src/adapters/rpcServer.ts` serves one session's thread to t3's chat UI at
`ws://<host>:<port>/ws`, with Effect's RPC server over t3's own `WsRpcGroup`,
one RPC server per connection, as t3's `ws.ts` runs it. `listenHost(options)`
listens in the caller's scope and answers the port (`0` asks for an ephemeral
one) and `connectedClients()`, the connections open now (each counts from the
moment its pass lets it in until its socket closes; a refused one never
counts); `serveHost` is `listenHost` then never. `host` is the caller's: the
server adds no default bind address. `ws.ts` itself is not lifted; the
handlers are host glue that calls the helpers `ws.ts` calls
(`vendor/t3code/UPSTREAM.md`, "The host RPC server lift").

- **The key at start.** `listenHost` parses `publicKeyPem` once
  (`parsePassKey`), before it binds the port, and fails with `PassKeyInvalid`
  when it is not an Ed25519 public key in SPKI PEM form (the error names the
  problem, never the key). Every connection's pass is verified against that
  parsed key, so a misconfigured key stops the host instead of refusing
  everyone in silence.
- **The pass first.** `GET /ws` is the socket, and the three calls t3's
  client makes before it are answered over HTTP (`hostHttp.ts`, below); any
  other method or path gets a `404` before the pass is looked at. A
  connection's `pass` query parameter, or `wsTicket` (the ticket t3's client
  was issued, which is the pass), is verified (`verifyPassWith`) before
  anything else is answered:
  a compact JWS signed with EdDSA by the cell's key (jose, `algorithms:
  ['EdDSA']`, so `none`, HMAC and every other algorithm are refused), whose
  payload decodes as a pass's claims; then `checkPassClaims` judges them. A
  refused WebSocket is upgraded and closed with `passCloseCode`: `4403` for a
  pass signed by the cell's key that names another session (`sid` is checked
  first, so that pass may also have expired), `4401` for every other refusal
  (missing, invalid, expired, not yet valid). The pass and its claims are
  never logged, and `PassRejected` carries the reason only. No tracer sees it
  either: the server makes no HTTP request span
  (`HttpMiddleware.TracerDisabledWhen`), which would record the URL the pass
  travels in, and the RPC server traces nothing (`disableTracing`). Every
  request also runs with `pass` among effect's redacted query parameters
  (`HOST_REDACTED_URL_PARAMS`, effect's own `UrlParams.CurrentRedactedNames`
  plus `pass` and `wsTicket`), so whatever shows a URL the server handles
  redacts it. Then,
  as t3, a client must speak orchestration protocol 2 (`426` otherwise).
- **The pass bounds the connection.** A socket a pass let in is closed with
  `4401` (`The session pass has expired.`) at that pass's `exp`, as a new
  connection with it would be refused then (`serveRpc`: a timer forked in the
  connection's scope, so a socket that closes first cancels it). t3's client
  then asks for a ticket with the expired pass, is refused (`401`), and stops
  (blocked, `authentication`), which is where `@consola/agent-ui` calls
  `onPassExpired` and reconnects with the pass it answers
  (`AgentChat.passExpiry.browser.test.tsx`; `rpcServer.test.ts` "closes a
  connection it let in with 4401 when its pass expires").
- **What is served** is `SERVED_METHODS`, the one list, with why each is
  there: `orchestration.subscribeThread`, `orchestration.dispatchCommand` and
  `orchestration.subscribeCommandOutput` (the thread), `subscribeServerConfig`
  (client-runtime's session is ready only once its first snapshot arrives; it
  carries the provider list), `server.probe` (the session's liveness check)
  and `server.refreshProviders` (the composer's model picker and its folder
  snapshot). Each follows its `ws.ts` handler; what the host leaves out is
  named at the handler (keybindings, themes, usage-limit sources, bounded
  history windows, on-demand machine catalogs). Only the session's own thread
  and folder are served: another thread id is t3's typed not-found error. A
  command t3's orchestrator refuses is answered as `ws.ts` answers it: t3's
  `userFacingDispatchErrorMessage` of the refusal in `message` and `detail`.
- **Every other method** answers `NotOfferedByHost` (`{ method }`, message
  `This host does not offer <method>.`). Each method declares t3's own
  failures, and t3's unchanged client decodes only those, so the refusal
  travels as the request's defect: the client sees a defect named
  `NotOfferedByHost`, and the socket keeps serving (`disableFatalDefects`).
- **Snapshot then live.** `subscribeThread` reads `snapshotSequence()` and
  `snapshot()` together, sends the snapshot projected for the wire, then
  `events(snapshotSequence)` through t3's live coalescer: nothing missed or
  repeated (Review Focus 2). A cursor (`afterSequence`) is replayed as t3
  replays it (`decideThreadResume`), or answered with a snapshot. Each client
  is its own subscription, and a command runs once whoever sends it (Review
  Focus 4).
- **The environment is the session.** The config's environment id is the
  session id, it advertises no optional capability (what the host does not
  serve, t3's UI does not offer), and its auth descriptor says a bearer pass
  lets a client in.
- **Before the socket** (`src/adapters/hostHttp.ts`). t3's client-runtime
  connects to a backend on another origin as t3's web app connects to a
  desktop's secondary backend (`connection/resolver.ts` → `authorizeBearer`):
  it reads the environment's descriptor, asks for a socket ticket with its
  bearer token, opens the socket with that ticket, and once connected reads
  its session's scopes. The host answers each as t3's handler does, with t3's
  schemas, and the pass is the bearer token, so it stays the only credential:
  - `GET /.well-known/t3/environment`: the descriptor (the config's
    environment, above), unauthenticated as in t3. It names the session id,
    `Consola host`, the platform and t3's server version.
  - `POST /api/auth/websocket-ticket/rpc` with `Authorization: Bearer <pass>`:
    `{ ticket, expiresAt }`, the ticket being the pass itself (the host keeps
    no sessions to mint one from), expiring with it. The socket verifies it
    again. So the pass travels in the socket's URL (`wsTicket`), where a
    browser's developer tools show it; a ticket distinct from the pass
    (short-lived, used once) is a Track B decision.
  - `GET /api/auth/session` with the same header: `authenticated: true`, the
    host's auth descriptor, `HOST_SCOPES` (`orchestration:read` and
    `orchestration:operate`, all it serves, so t3's UI offers nothing more),
    `sessionMethod: 'bearer-access-token'` and the pass's expiry; a refused
    pass reads `authenticated: false`, as t3's does.
  - A refused pass at the ticket is t3's `401` `EnvironmentAuthInvalidError`
    (`missing_credential`, or `invalid_credential` for every other refusal,
    another session's pass included: the ticket call declares no other
    answer). t3's client stops on it (blocked, `authentication`), which is
    where `@consola/agent-ui` asks for a new pass.
  - Every answer, a `404` included, carries t3's browser API CORS headers
    (`HttpMiddleware.cors` with the lifted `t3/httpCors.ts` lists: any origin,
    no cookies), so a page on another origin can make these calls and read a
    `404` (t3's HTTP snapshot loaders, `/api/orchestration/shell` and
    `…/threads/:id/bounded`, then fall back to the socket, as against an older
    t3 server).
  - A failure of the host's own while answering (not a refused pass, which is
    an answer) is logged to stderr, the request's pass taken out of it, and
    answered `500` (`hostHttp.test.ts`).
- **Methods the chat calls and the host refuses.** Running t3's copied chat
  (`@consola/agent-ui`) against a replay host, the chat calls three methods
  beyond `SERVED_METHODS`: `orchestration.subscribeShell` (the thread list's
  shell; the chat has a shell-less path and renders the thread from its
  projection), `subscribeDeviceState` (the phone preview) and
  `subscribeProjectClones` (project clones). Each stays refused: the chat
  shows the thread, its composer and its model without them, and the latter
  two are parts of t3 the plan leaves out. Sending from the composer is not
  yet exercised against the host by a test.
- **No client tracking in `ws`.** The HTTP server makes its `ws`
  WebSocketServer at the first upgrade and closes it with the scope, before
  its own finalizer closes the sockets; with `ws`'s client tracking that close
  waits for every socket to end, so a scope closed with a client connected
  would hang. `listenHost` turns it off (`websocket: { clientTracking: false }`).

Nothing under `adapters/` reaches the Cursor SDK beyond the runtime: of the
lifted modules `rpcServer.ts` imports, only `serverSettings.ts` and
`orchestration-v2/ThreadManagementService.ts` reach `@t3tools/provider-cursor`
at all, through modules the runtime already imports (`serverSettings.ts` →
`settingsSecrets.ts` → `@t3tools/provider-cursor/client`, which does not import
`@cursor/sdk`; `ThreadManagementService.ts` → the orchestrator's graph, below).

### The host never starts a CLI in full access

Every thread opens in `approval-required` (`HOST_RUNTIME_MODE`): the CLI asks
before running a command or writing a file, and the chat shows the request.
t3's own default (`DEFAULT_RUNTIME_MODE`) is `full-access`, which asks nothing;
the host never uses it, and `SessionSpec` has no field to ask for it.

That holds for a state folder with t3's default settings. t3 lets a provider
instance's settings carry launch arguments, and for Claude a `launchArgs` in
`<stateDir>/userdata/settings.json` naming `--permission-mode <mode>` or
`--dangerously-skip-permissions` overrides the thread's mode
(`ClaudeAdapterV2.ts:2325-2326`, `:2412-2416`: `bypassPermissions` asks
nothing). The state folder is the runner's (`--state-dir`, or a temporary one
the host makes), so the runner must not write such settings; the host does not
check them.
Tests that replay a fixture recorded in another mode, or substitute t3's replay
adapter, use `layerForTests(options, { drivers, runtimeMode })`, which builds on
`layerOrchestrationForTests(options, drivers)`. `boundary.test.ts` refuses
every use of a name ending in `ForTests` outside `*.test.ts` and `src/testing/`
(a call, a namespace member, an import under another name), except in the body
of another seam that is a function (code that runs only when a test calls it,
never as a module loads), so no host code can reach a seam (`bin.ts` included);
`layer(options)` takes neither, and `layerOrchestration(options)` always
hydrates the session's guarded driver alone (`hostDriverFor`).

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

It also reads Claude's settings files for their `env` (`readClaudeSettingsEnv`,
`provider/Drivers/ClaudeSkills.ts:676-700`: the user's `<configDir>/settings.json`
and the managed settings, later files winning). Such an `env` may hold a
secret, `ANTHROPIC_API_KEY` say: t3 reads each file whole, but decodes and keeps
only `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_PLUGIN_DIRS`
and the two gateway model-discovery flags (`SettingsEnv`, `:663-670`); the rest
is dropped with the file's text.

### What `open` does on the person's machine

Each `open` hydrates t3's provider instances from one driver, the session's
harness's (`hostDriverFor`), where t3's server hydrates every built-in one.
Whatever else the state folder's settings enable, no other provider instance
exists in the session's composition, so:

- only the session's CLI is probed (no `codex` runs in a Claude session: t3's
  Codex installation service, which runs `codex --version` as it is built, is
  composed only for a Codex session, "Stand-ins");
- t3's provider list (`ProviderRegistry`, which `subscribeServerConfig` and
  `server.refreshProviders` serve, and the composer's model picker reads) names
  only the session's provider, so the picker offers no other provider to switch
  the thread to (t3's `ProviderSwitchService`; switching is a spec §3 non-goal),
  and a command naming another provider's instance fails as t3 fails it for an
  instance it has not registered;
- nothing, a thread title included, can reach another provider.

The session's own instance is there only when enabled: with t3's defaults
Claude and Codex are, OpenCode and Pi are off until enabled
(`DEFAULT_DISABLED_PROVIDER_DRIVERS`, `packages/contracts/src/settings.ts`),
and the ACP registry has no instance until an agent is configured
(`hasDefaultInstance: false`). If it finds the CLI (on the `PATH`, or at a
configured `binaryPath`), its driver:

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

It also reads Claude's account metadata (above).

**Titles.** A thread's first message asks t3's title model
(`textGenerationModelSelection`) for a title. t3 defaults it to Codex whatever
the thread runs on, so `open` sets it, through t3's own settings service
(`updateSettings`, which writes `<stateDir>/userdata/settings.json`), to the
session's own instance (its `modelSelection.instanceId`, or the harness's
default one) on the model t3 picks for that driver's text generation
(`titleModelSelection`: t3's per-driver text model, else the driver's default
model; for Claude `claude-haiku-5-5`). A selection the state folder already
puts on that instance is kept. The session's driver then generates the title
as t3 has it do. Claude: `claude -p --output-format json --json-schema …
--model <title model> --settings {"disableAllHooks":true} --tools ""
--disable-slash-commands --strict-mcp-config --permission-mode dontAsk`, the
message on stdin, in the session's folder
(`apps/server/src/textGeneration/ClaudeTextGeneration.ts:255-320`). Codex:
`codex mcp list --json`, then `codex exec --ephemeral --skip-git-repo-check -s
read-only …` (`CodexTextGeneration.ts`). Where t3 has no title
generation for a harness (the ACP registry's is `makeUnsupportedTextGeneration`),
or the session's instance cannot run it, t3's title generation fails, logs a
warning, and the thread keeps the title seeded from the first message. t3's
fallback to another provider's title model finds no other instance to use.

### What a turn does on the person's machine

A turn runs the person's CLI, as the person, in the session's folder. From t3's source:

- **Claude loads the folder's settings and hooks, with no trust prompt.** A turn's Agent SDK
  options (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:2408-2489`) name no
  `settingSources`, which the SDK reads as all of them (`sdk.d.ts`: "When omitted, all sources
  are loaded"): user, project and local, so `.claude/settings.json` and
  `.claude/settings.local.json` in the folder, hooks included, as t3 itself resolves them
  (`settingSources: ["user", "project", "local"]`, `ClaudeAdapterV2.ts:5806`, `:5839`). Unlike
  the capabilities probe and title generation, a turn does not set `disableAllHooks`. The SDK
  shows no folder-trust dialog, so nothing asks whether the folder is trusted.
- **t3 writes into the folder's git repository.** Before a run t3 captures a baseline
  checkpoint (`orchestration-v2/RunExecutionService.ts:1055`, `CheckpointService.captureBaseline`),
  and captures checkpoints as turns end (`orchestration-v2/CheckpointCaptureService.ts:143`); each stages the whole worktree into a temporary index, writes its
  objects into the repository's object store and points a ref under
  `refs/t3/orchestration-v2/checkpoints` at it (`CheckpointService.ts:35`,
  `vcs/GitVcsDriver.ts:1177`). The folder's files and branches are not changed by it.
- **A pass holder approves commands that run as the person.** In `approval-required` the CLI
  asks before running a command or writing a file, and whoever holds the session's pass answers
  from the chat. An approved command runs with the person's user, environment and login; Claude's
  Bash is not confined to `--cwd` (the folder is the working directory and the file tools'
  allowed root, not a sandbox).

So `consola-host session` writes one human warning line on stderr as it starts, before any CLI
runs (`folderWarning`, `bin.ts`): the folder's project settings and hooks will load with no
trust prompt, and t3 writes checkpoint refs and objects into its git repository. The host does
not check that the folder is trusted: giving it only trusted folders is Track A's check (spec
§7.4, folder trust), made before a host is started.

### Stand-ins

Everything in the composition is t3's own, but these. Each is the smallest
version that keeps what is built on it working.

- `layerSecretStore` for `ServerSecretStore`: t3's keeps logins and API keys
  on disk. The host keeps none: reading finds nothing, writing fails, and
  removing succeeds (there is none to keep; every t3 settings write removes
  the secrets its empty fields name, so a refused removal would refuse the
  title setting above); the random values t3 makes for itself (an environment
  id) live in memory.
- `layerNoCodexInstallation` for `CodexInstallation`, in every session but a
  Codex one: t3's runs the machine's `codex` as it is built (`codex --version`,
  `codex app-server --help`; `reuseLocal`, `CodexInstallation.ts`). Only
  Codex's driver (and t3's managed Codex, never hydrated) reads it; this one
  runs nothing, finds no Codex and installs none.
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
  The probe test turns OpenCode and Pi on and checks that a Claude session
  still runs only the fake `claude` and lists only Claude's provider; the
  missing-CLI tests take the fake `claude` away
  (`withoutCli('claude')`) or point `binaryPath` nowhere, and check that no
  `claude` ran.

No CLI of the developer's can run: every `PATH` a test process has holds only
fakes, `/usr/bin` and `/bin`, and no home it has is the developer's.
`CONSOLA_HOST_CLI_RECORD=<file>` copies both records out (a line per call, or
`(no CLI ran)`). t3's settings file turns update checks off, `fetch` is
stubbed, and any request fails the test.

The replay tests compose the same production orchestration through
`layerForTests`, with one change: the host's guarded Claude driver whose
adapter is t3's Claude replay adapter. Test kits (`@t3tools/provider-testing`, any `…/testing`
entry, `effect-codex-app-server/replay`, any `testkit` module) are imported only from `*.test.ts` files; `boundary.test.ts`
refuses them anywhere else.

## The `session` command

`src/bin.ts` is the package's `consola-host` bin, run by Node 26 straight from
source (type stripping; no build step):

```
consola-host session --session-id <id> --harness <claude|codex|opencode|pi|acp> --cwd <dir>
  [--port <n, default 7420; 0 for a free one>] [--bind <address, default 127.0.0.1>]
  --pass-public-key <Ed25519 public key, SPKI PEM file> | --dev
  [--idle-minutes <n, default 10; fractions allowed>] [--state-dir <dir>]
```

Track B's runner starts it in a sandbox and reads its stdout. It opens the
session's thread (`ThreadRuntime.open`), then listens (`listenHost`), so
`ready` means a client can connect now.

- **Stdout is JSON lines and nothing else** (`HostLine`,
  `adapters/stdoutEvents.ts`), each flushed before the next is written:
  `{"type":"ready","port":<n>}` (the port it got), with `--dev`
  `{"type":"dev-pass","pass":"<jwt>","expiresInSeconds":43200}`, then
  `{"type":"title","title":"…"}` and
  `{"type":"status","status":"working"|"waiting"|"idle"}` as they change, and
  `{"type":"exit","reason":"idle"}`. Every Effect log goes to stderr
  (`Logger.LogToStderr` over the whole program), and so does every error.
- **The folder warning.** One line on stderr as it starts, once `--cwd` is known to be a folder
  and before any CLI runs: `consola-host: warning: turns in <cwd> load its project settings and
  hooks with no trust prompt (…), and t3 writes checkpoint refs (…) into its git repository.`
  ("What a turn does", above).
- **Status and title** follow `handle.snapshots()` (`reportSession`): a
  pending runtime request (an approval or a question, t3's
  `runtimeRequests[].status`) is `waiting`, an active run (t3's own
  `isActiveRun`) is `working`, anything else `idle`; the title is the
  projection's `thread.title`. A line is printed only on a change from what was
  last said, and `ready` says idle and the thread's first title. t3 titles a
  thread twice on its first message, from the message's title seed and then
  with its generated title, so both are lines.
- **Idle exit.** Each second the host asks `isIdle` with the server's
  `connectedClients()`, whether a turn runs (`working`), and the last activity:
  the thread's (`lastActivityMs`) or the last moment a client was connected,
  whichever is later; becoming ready counts as activity. When it holds, the
  host prints `exit`, closes the session and exits 0. A pending approval or
  question (`waiting`) does not hold it: with no page connected and no turn
  running, the host exits once the idle minutes pass, and the request, the
  thread and its history (t3's in-memory SQLite) go with it.
- **Signals.** SIGTERM and SIGINT interrupt the program: its scope closes (the
  server, the thread, the provider session and the CLI it runs), then the
  process exits 0 (1, with a message, if that takes over 15 seconds).
- **Start failures** (a bad flag, a key file that cannot be read or is not an
  Ed25519 public key, `--cwd` not a folder, a port taken): a message on stderr
  (`consola-host: …`, with the usage for a bad flag), exit 1, nothing on
  stdout. The key is read and checked before any CLI starts.
- **`--dev`** stands in for the cell: an Ed25519 key pair made in memory
  (`adapters/devPass.ts`), whose private key is never returned, printed or
  written, and one pass signed with it: `sub` `dev`, `ws` `local` (names no
  person or workspace has), `sid` the session id, `iat` now, `exp` twelve hours
  later. `--pass-public-key` is ignored and `--session-id` defaults to
  `dev-session`. It listens on loopback only: `--dev` with a `--bind` other than
  `localhost`, `::1` or a `127.0.0.0/8` address is a start failure (`isLoopback`). Without `--dev`, `--pass-public-key` is required.
- **State.** t3's state and settings live in `--state-dir`
  (`<dir>/userdata/settings.json`), or in a temporary folder removed at exit.
  The tests pass one whose settings turn update checks off, so a host they
  start asks no one online.

`runSession(args, runtimeFor)` takes the runtime as a parameter; the entry at
the bottom of `bin.ts` passes `ThreadRuntime.layer`. `testing/replaySession.ts`
runs the same `sessionCommand` and `runHostProcess` over `layerForTests` with
the Claude replay driver, checking out the fixture's workspace as `--cwd`.
`bin.test.ts` starts both with node under the test's machine (fake CLIs on the
PATH, the test's home): the replay through a whole turn (`ready`, `dev-pass`, a
message sent with the pass, `status` and `title` lines, exit 0 on SIGTERM), and
the real bin for `ready`, `dev-pass`, a socket that takes the pass, SIGTERM
with no process left (a fake `claude` that stays running, as the capabilities
probe's would), the cell's key, the idle exit, and the start failures. Each
asserts that every stdout line is a `HostLine`.

## The `runner` command

`consola-host runner` is the host's other role: a workspace's runner. It dials
its regional cell (`apps/cloud-region/AGENTS.md`, "The runner's socket") and
runs each session the cell asks for in a sandbox of its own, through
`@consola/sandbox`, where the template's start script clones the repository and
runs `consola-host session`. The messages are `@consola/runner-protocol`'s; read
its `AGENTS.md` first.

```
consola-host runner --cell-url <wss://…/api/runner, or ws: to loopback> --runner-id <id>
  [--idle-minutes <n, default 10; the session hosts'>] [--max-session-minutes <n, default 480>]
```

- **Environment.** `CONSOLA_RUNNER_SECRET` (sent only in the socket's upgrade,
  as `Authorization: Bearer`; printable characters with no space),
  `CONSOLA_RUNNER_REPOSITORIES` (the repositories it offers, `owner/name`,
  comma-separated), `GIT_TOKEN` (optional, for the clone), and the API keys,
  each offering its harness (`harnessesFromEnv`): `ANTHROPIC_API_KEY` claude,
  `OPENAI_API_KEY` codex. The E2B provider (Task 6) adds `E2B_API_KEY`.
- **Start failures** follow the session command's: `consola-host: …` on stderr,
  exit 1, nothing on stdout. A bad flag (with the usage), a `--cell-url` that is
  not `wss:` or is `ws:` to a host that is not loopback, or carries user info,
  a query or a fragment (it is logged; `cellUrlProblem`), no secret, a
  repository `isRepository` refuses, no API key (no harness to offer), and no
  sandbox provider. No message quotes a secret.
- **The provider.** `runnerCommand(argv, env, providerFor)` takes the provider
  from a factory of the environment (`ProviderFor`). Production's
  (`productionProvider`) has none yet, so the shipped runner fails at start
  until Task 6 fills it with E2B; it never falls back to a fake. Tests run
  `testing/replayRunner.ts`, the same command on `testing/localProvider.ts`.
- **A session's sandbox** (`adapters/sandboxSessions.ts`). A `session.start`
  for a repository or harness the runner does not offer is `failed`, with no
  sandbox (`offerRefusal`). Otherwise the sandbox is created from the template
  `consola-session` with `CONSOLA_SESSION_ID`, `CONSOLA_HARNESS`,
  `CONSOLA_REPOSITORY`, `CONSOLA_PASS_PUBLIC_KEY`,
  `CONSOLA_SESSION_IDLE_MINUTES`, `GIT_TOKEN` and the API key of that harness
  alone (`sandboxEnvFor`), and runs `consola-session-start`, its output only
  listened to (`keepOutput: false`). A second start for a session held is
  ignored; a start once the runner is stopping is `failed`, with no sandbox,
  since nothing would stop it.
- **What a line becomes** (`readSessionLine`, `updateForLine`; stdout arrives in
  chunks, `HostLineBuffer` makes them lines). `ready` exposes the port it names
  (never a fixed 7420) and says `{ status: 'running', hostUrl }` with the
  provider's address, once it is an origin the cell takes (`isHostUrl`); an
  address that cannot be had fails the session and stops its sandbox. `title`
  says the title. The start script's `clone-failed` says `failed` with its
  message. `status`, `dev-pass`, the host's `exit` and anything unreadable say
  nothing.
- **What an end becomes** (`updateForExit`), said once, the cell's stop always
  `stopped`. Before `ready`, any end the cell did not ask for is `failed` (the
  cell keeps a starting session starting on a `stopped`), with the last line on
  stderr for a non-zero exit. After it, the host's own exit (its `exit` line) and
  the runner's stop are `stopped`; a non-zero exit is `failed` with the last line
  on stderr; a signal from elsewhere is `failed` ("The session's sandbox
  ended."), and so is exit 0 with no `exit` line, since the host ends that way
  only when something in the sandbox stopped it. A provider's failure (quota, a
  missing template's `not-found`) is `failed` with its message.
- **Backstops.** The sandbox is stopped whenever its session ends, and the
  runner stops it itself on the cell's `session.stop`, `EXIT_LINE_GRACE` (30 s,
  over the host's 15 s shutdown grace) after the host's `exit` line, at the
  lifetime cap (`--max-session-minutes`), and on SIGTERM or SIGINT, when it stops
  every sandbox and says each end while the socket is still open, then closes
  the socket (1001) and exits 0 (1, with a message, past 15 s).
- **The socket** (`adapters/cellSocket.ts`, on `ws`: Node's own WebSocket cannot
  portably send `Authorization`). Each connection opens with `hello` (the offer,
  `runningSessionIds`, and `endedSessions`), then every live session's state
  again (`running`, its address and title), since the cell may drop updates
  that went on a socket it replaced. An update while the socket is down is not
  queued; an end is held for the next `hello` (`EndedSessions`), and goes again
  when the connection it went on closed within `END_CONFIRM_MS` (5 s) of it; an
  id is never listed as running and ended at once. A `hello` over the cell's
  64 KiB frame limit sends its ends without their messages. A drop is dialled again
  after a jittered wait doubling to 30 s (`reconnectDelayMs`), starting over
  once a connection has held 10 s. A close with 4000 means another process with
  this secret said hello and replaced this one: it stops its sandboxes, stops
  dialling and exits 1, so two runners sharing a secret never take the socket
  from each other in a loop. Frames over 64 KiB close the socket (1009); a frame
  `readCellMessage` refuses is logged with its reason and dropped. A failure of
  the runner's own while connected ends that connection, never the dialling.
  There is no heartbeat yet, on either side.
- **Secrets.** It never logs its environment. Its log lines (stderr, `consola-host
  runner: …`) and every update are scrubbed of the runner secret, the git token
  and the API keys (`scrubSecrets`, as they are and URL-encoded), errors and
  titles before they are bounded to 1000 characters (`scrubUpdate`), and a
  command's stderr as it arrives, before its tail is cut (`StderrTail` holds back
  what may start a secret split across chunks). `hostUrl` is the provider's
  address, checked as an origin, never the sandbox's text. Stdout stays empty.

`bin.test.ts` runs `testing/replayRunner.ts` under the test's machine against a
cell of its own (a `ws` server on loopback): the secret in the upgrade, `hello`,
a `session.start` with a real key, `running` at `http://127.0.0.1:<port>` where
the replayed host answers, then SIGTERM: `stopped`, the socket closed with 1001,
exit 0, no process left, and no secret on stderr. It runs the real bin for each
start failure. `sandboxSessions.test.ts` drives the sessions over the fake
provider, and `cellSocket.test.ts` the socket against a `ws` server.

## Running it

```bash
pnpm --filter @consola/host test        # vp test run (Vite+), config in vite.config.ts
pnpm --filter @consola/host typecheck   # effect-tsgo, hoisted by publicHoistPattern
node packages/host/src/bin.ts session --dev --harness claude --cwd <folder>   # from the repo root
```

### Running it with the chat

`packages/agent-ui`'s dev page renders `AgentChat` full-window against a host on this Mac, with
the person's own signed-in `claude`. Two commands, from the repository root, in two terminals:

```bash
node packages/host/src/bin.ts session --dev --session-id demo-1 --harness claude --cwd <folder>
pnpm --filter @consola/agent-ui dev      # http://localhost:5176
```

Open `http://localhost:5176/?host=ws://127.0.0.1:7420&pass=<dev-pass>&session=<session-id>`
(`&theme=dark|light` optional; it defaults to the system's). `host` is the `--port` (default
7420), `session` is the `--session-id`, and `<dev-pass>` is the `pass` of the `dev-pass` line the
host prints on stdout after `ready`. It is a dev pass, valid 12 hours (`expiresInSeconds` 43200);
past that, or after a restart (the key pair is new each time), restart the host and open the URL
with the new pass. The page names any parameter missing and never shows the pass, and takes
`pass` out of its address as soon as it has read it (`history.replaceState`, keeping `host`,
`session` and `theme`), so the pass is not left in the address bar or the history; a reload
then names `pass` as missing, so open the URL with it again. Point `--cwd` only at a folder
you trust: Claude loads its project and local settings and their hooks with no trust prompt,
t3 writes checkpoint refs and objects into its git repository, and a command you approve in the
chat runs as you, not confined to that folder ("What a turn does on the person's machine"). The dev page has no `onPassExpired`, so an
expired pass shows the chat's "host refused this chat's pass" notice. The host exits
once no page has been connected for `--idle-minutes` (default 10) and no turn runs, a
pending approval included (it is lost); start it again for a new session.

## Licensing

`@consola/host` is AGPL-3.0-only, Consola's own code. The vendored packages keep
t3's MIT licence (`vendor/t3code/LICENSE`).

- The host runs the person's installed CLI with its existing login. It never
  shows a sign-in, never stores a credential, never reads a CLI's login file
  or token, and never sends one ("The host never reads a CLI's login", above);
  it reads Claude's account metadata (`.claude.json` `oauthAccount`
  organization and account ids), and the organization id reaches the browser
  in the provider snapshot. It reads Claude's `settings.json` files, whose
  `env` may hold an API key, and keeps only their non-secret `env` keys
  (`readClaudeSettingsEnv`, above). It passes `pathToClaudeCodeExecutable` for Claude,
  never the SDK's bundled copy.
- The Cursor SDK (`@cursor/sdk`) is never bundled into anything the host builds.
- Nothing that bundles `@anthropic-ai/claude-agent-sdk` is published or released
  (Linear CON-21). Local builds are fine.
- Fixtures and examples use Acme, Sprocket and the `sprocket` org, never real
  names.
