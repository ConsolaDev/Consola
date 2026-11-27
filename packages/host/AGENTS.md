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
  commands are offered (`decideCommand`), what a session pass is and whether its
  claims hold (`readPass`, `checkPassClaims`), which addresses are loopback
  (`isLoopback`), when the host is idle (`isIdle`: no client, no running
  turn, nothing done for the idle minutes) and `SessionSpec`. No
  `node:` builtin, no `effect/process`, `ws` or `jose`, and no global that
  touches the machine (`process`, `fetch`, `WebSocket`, timers). It may name the
  vendored `@t3tools/contracts` and `@consola/runner-protocol` (below). The
  runner's decisions live here too (`runnerDecisions.ts`, "The `runner`
  command"), and the host's stdout lines (`hostLine.ts`: `HostLine` and its
  reader), and an agent run's (`agentRun.ts`, `agentRunTools.ts`,
  `mcpProtocol.ts`, and `followUp.ts`, a person's follow-up as the orchestrator
  reads it; "Agent runs").
- `src/runtime/` holds Effect services over the vendored t3 packages. It may
  import them (by package name, or `t3/<path>.ts` for a lifted server file) and
  `core/`, never `adapters/`.
- `src/adapters/` is everything that touches the outside: the WebSocket server,
  verifying a pass's signature, the socket's tickets (`socketTickets.ts`), the
  dev pass (`devPass.ts`), the lines on
  stdout (`stdoutEvents.ts`), an agent run's `/mcp` (`mcpHttp.ts`) and its follow-ups
  (`followUpHttp.ts`), and the runner's sandboxes (`sandboxSessions.ts`)
  and its socket to the cell (`cellSocket.ts`). It may import `core/` and
  `runtime/`.
- `src/main.ts` is the bin: it listens for SIGTERM and SIGINT, then imports
  `bin.ts` and calls its `main` ("Signals", below). It imports no package and
  nothing else (its `LAYERS` row reaches `bin` alone), so its listeners are
  there before anything loads.
- `src/bin.ts` is the only wiring: it parses the command line, builds the
  adapters and hands them the runtime (`consola-host session`, below), or a
  sandbox provider (`consola-host runner`, below).
- `src/testing/` is what tests share: `machine.ts` (a machine of a test's own,
  with fake CLIs), `setup.ts` (Vitest's setup file, which isolates the whole
  test process; "Tests" below), `replay.ts` (sessions whose Claude driver
  replays one of t3's recorded fixtures), `t3Client.ts` (t3's RPC client,
  connected as `@t3tools/client-runtime` connects it), `replaySession.ts`
  (the session command over a replay, which `bin.test.ts` starts with node),
  `cellPass.ts` (a pass signed as the cell's `passSigner` signs one),
  `localProvider.ts` (a `SandboxProvider` whose sandboxes are a temporary
  folder and a `replaySession.ts` process, its ports `http://127.0.0.1:<port>`)
  and `replayRunner.ts` (the runner command over it).
  No other ring reaches it, so only `*.test.ts` files, `vite.config.ts` and a
  test's `node` use it; it may use the test runner, t3's test kits and test
  seams, and reach `bin.ts` to run its command.

  `@consola/agent-ui`'s browser tests use it too, by path, so a change here can
  break them: their global setup (`packages/agent-ui/src/testing/hostSession.ts`)
  imports `machine.ts` (`writeFakeClis`, `readCalls`, `cliVariablesIn`,
  `homeVariables`, `pathWith`) and `cellPass.ts` (`PASS_MAX_LIFETIME_SECONDS`;
  its `passKeys.ts`, and through it its `vite.config.ts`, sign passes with
  `cellPass.ts`), and spawns `replaySession.ts` with node, passing
  `simple full-access session --pass-public-key … --session-id … --harness claude
  --port 0`; its `sendFixtureMessage.ts` imports `t3Client.ts` (`connectHost`:
  a ticket for the pass, then the socket) and `replay.ts` (`loadReplay`,
  `sendMessage`). Run
  `pnpm --filter @consola/agent-ui test` after changing any of these.

  `@consola/cloud-session-e2e`'s test (`packages/cloud-session-e2e`, a cloud
  session end to end against the built cloud app) uses it too, by path: its
  `vite.config.ts` takes `setup.ts` as its setup file, and its
  `src/cloudSession.test.ts` imports `machine.ts` (`writeFakeClis`, `readCalls`,
  `cliVariablesIn`, `homeVariables`, `pathWith`), `replay.ts` (`loadReplay`,
  `sendMessage`, `REPLAY_TITLE`), `t3Client.ts` (`connectHost`) and
  `localProvider.ts` (`RUNNER_SECRET_VARIABLES`, which it re-exports from
  `core/runnerDecisions.ts`, so no secret of the developer's shell reaches the
  runner), and spawns
  `replayRunner.ts` with node (`runner --cell-url ws://127.0.0.1:<port>/api/runner
  --runner-id …`), whose sandboxes are `localProvider.ts`'s. Run
  `pnpm exec turbo run test --filter=@consola/cloud-session-e2e` after changing
  any of these, or the runner command.

To add a ring, add a row to `LAYERS` and a case to the table in
`boundary.test.ts`. Test files are exempt from the layer rules.

No file imports another `@consola/*` package, tests included, but two, each by
its own name and never a path inside it (`@consola/sandbox/dist/index.js` is
refused): `@consola/runner-protocol` (MIT), what a runner and its cell, the
cloud app, say to each other, which does no I/O, so every ring may name it; and
`@consola/sandbox`, the interface the runner starts sandboxes through, in
`adapters`, `testing` and `bin.ts` only, never `core` or `runtime`. One entry
point of `@consola/sandbox` is named on its own: `@consola/sandbox/e2b`, the E2B
provider, which `bin.ts` alone makes (`productionProvider`, "The `runner`
command"), and loads only as a runner starts, with a dynamic `import()`: the
session host runs the same `bin.ts` (and the bundle holds E2B's SDK, "The
bundle and the session template"), but never loads it (`boundary.test.ts`). A
test file takes the list of the module it sits beside (`adapters/x.test.ts`
`adapters`'s, `bin.test.ts` `bin`'s). Each is its layer's `consola` list in
`LAYERS`, with a case in the table for every ring. `scripts/`, outside `src/`
and the rings, holds the two build scripts ("The bundle and the session
template") and `agent-run-smoke.ts` ("The `runner` command"); `scripts/build-template.ts` imports `@consola/sandbox/e2b` to build
the session template.

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
  shell: ThreadShellView; // the session's rows of t3's shell, for the shell routes
  lastActivityMs(): number;
  ended: Effect<never, ThreadStreamEnded>; // fails once snapshot() would stop following the thread
  agentRun: AgentRunSession | null; // an agent run's children, tools and report ("Agent runs")
};

type ThreadShellView = {
  snapshot: Effect<OrchestrationV2ShellSnapshot, ThreadRuntimeError>; // its project and thread, now
  thread: Effect<OrchestrationV2ThreadShell | null, ThreadRuntimeError>; // t3's getThreadShell
  events(afterSequence: number): Stream<OrchestrationV2StoredEvent, ThreadRuntimeError>; // every listed thread's
  row(threadId: string): Effect<OrchestrationV2ThreadShell | null, ThreadRuntimeError>; // a listed thread's row
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
- `ended` fails with `ThreadStreamEnded` once the stream that keeps
  `snapshot()` current (t3's `streamStoredEvents`, which runs as long as the
  orchestration does) ends or fails: from then on the snapshot, and the status
  and title the host prints from it, would go stale. The session command then
  stops with exit 1 (below). Its interruption as the scope closes is the
  session's own stop, and logs nothing. `layerForTests`'s `endEventsAfter`
  ends it early, for the tests.
- `server` hands out the services of the composition t3's `ws.ts` builds its
  server config and provider list from, so nothing served is made up: t3's
  `ProviderRegistry` (one snapshot per provider instance, its changes and
  refreshes), its settings and their changes, the session's folder and t3's
  config paths.
- `shell` reads the session's rows of t3's shell (the thread list t3's client
  keeps beside a thread) from the store the projection is read from: the
  thread's row (t3's `getThreadShell`) and its project's (`ProjectService`
  `getShell`). `snapshot` holds those two and nothing else (no subagent's row,
  no archived one), at `snapshotSequence()` read before them, so each row holds
  at least every event through that sequence.

## The WebSocket server

`src/adapters/rpcServer.ts` serves one session's thread to t3's chat UI at
`ws://<host>:<port>/ws`, with Effect's RPC server over t3's own `WsRpcGroup`,
one RPC server per connection, as t3's `ws.ts` runs it. `listenHost(options)`
listens in the caller's scope and answers the port (`0` asks for an ephemeral
one) and `connectedClients()`, the connections open now (each counts from the
moment its ticket lets it in until its socket closes; a refused one never
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
- **The pass first, then a ticket.** `GET /ws` is the socket, and the three
  calls t3's client makes before it, and the two orchestration reads it makes
  once connected, are answered over HTTP (`hostHttp.ts`, below); any other
  method or path gets a `404` before anything is looked at, and a request
  whose target no URL can be made of (`GET // HTTP/1.1`) a `400`.
  The pass travels only in the `Authorization: Bearer` header of those calls,
  where it is verified (`verifyPassWith`) before anything else is answered:
  a compact JWS signed with EdDSA by the cell's key (jose, `algorithms:
  ['EdDSA']`, so `none`, HMAC and every other algorithm are refused), that
  `readPass` takes for a pass: its header's `typ` is `PASS_TYPE` and its
  payload the protocol's claims, read by `@consola/runner-protocol`'s
  `readPassClaims` (`aud` `PASS_AUDIENCE`, the fields it names and no other,
  a lifetime of `PASS_MAX_LIFETIME_SECONDS`, 300 s, or less). So a pass is
  exactly what the cell's `passSigner` signs (`passVerifier.test.ts` signs one
  with `passClaims` and that header), and another audience, no `typ`, or a
  longer life is `invalid`. Then `checkPassClaims` judges the time and the
  session: `exp <= now` is expired, 60 s of clock skew for `iat` only, `sid`
  first. A `--dev` host alone takes its own longer pass (`PassLifetime`
  `dev`, below).

  The socket opens with a **ticket** alone (`wsTicket`, where t3's client puts
  the one it was issued), never with a pass (`socketTickets.ts`). A ticket is
  32 random bytes the host issued for a pass it just verified, held in memory
  only, good for one socket once, for `TICKET_LIFETIME_MS` (30 s) or until its
  pass expires if that comes first; the host holds `MAX_TICKETS` (64) at most,
  dropping the oldest. No ticket, one it never issued, one used already or
  expired, and a pass in a ticket's place or in a `pass` parameter are all
  refused alike: the WebSocket is upgraded and closed with `4401` (`A valid
  socket ticket is required.`). So what a socket's URL carries, which a
  browser's developer tools and a proxy's logs show, opens nothing once used
  or a moment old. The pass and its claims are never logged, and
  `PassRejected` carries the reason only. No tracer sees either: the server
  makes no HTTP request span (`HttpMiddleware.TracerDisabledWhen`), which
  would record a request's URL, and the RPC server traces nothing
  (`disableTracing`). Every request also runs with `pass` and `wsTicket` among
  effect's redacted query parameters (`HOST_REDACTED_URL_PARAMS`, effect's own
  `UrlParams.CurrentRedactedNames` plus those two), so whatever shows a URL
  the server handles redacts them. Then, as t3, a client must speak
  orchestration protocol 2 (`426` otherwise).
- **The pass bounds the connection.** A socket a ticket let in is closed with
  `4401` (`The session pass has expired.`) at the `exp` of the pass the ticket
  was issued for, as a ticket for that pass would be refused then (`serveRpc`: a timer forked in the
  connection's scope, so a socket that closes first cancels it). t3's client
  then asks for a ticket with the expired pass, is refused (`401`), and stops
  (blocked, `authentication`), which is where `@consola/agent-ui` calls
  `onPassExpired` and reconnects with the pass it answers
  (`AgentChat.passExpiry.browser.test.tsx`; `rpcServer.test.ts` "closes a
  connection it let in with 4401 when its pass expires").
- **What is served** is `SERVED_METHODS`, the one list, with why each is
  there: `orchestration.subscribeThread`, `orchestration.dispatchCommand` and
  `orchestration.subscribeCommandOutput` (the thread),
  `orchestration.subscribeShell` (the thread list's shell, "The shell" below),
  `subscribeServerConfig`
  (client-runtime's session is ready only once its first snapshot arrives; it
  carries the provider list), `server.probe` (the session's liveness check)
  and `server.refreshProviders` (the composer's model picker and its folder
  snapshot). Each follows its `ws.ts` handler; what the host leaves out is
  named at the handler (keybindings, themes, usage-limit sources, bounded
  history windows, on-demand machine catalogs). Only the session's own thread
  and folder are served (and, read-only, an agent run's dispatched agents'
  threads, "Agent runs"): another thread id is t3's typed not-found error. A
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
  its session's scopes (it asks for a new ticket for every connection it
  opens). The host answers each as t3's handler does, with t3's schemas, and
  the pass is the bearer token, the only credential the host takes:
  - `GET /.well-known/t3/environment`: the descriptor (the config's
    environment, above), unauthenticated as in t3. It names the session id
    and `Consola host`. Since anyone who reaches the port reads it, a host
    bound past loopback (a sandbox's public port) names no platform or
    version: `os` `unknown`, `arch` `other`, `serverVersion` `unknown`
    (`GENERIC_SERVER_VERSION`; t3's client only shows it, and whether it can
    talk to a host is the orchestration protocol's to say). On loopback or
    with `--dev` it names its own and t3's server version (`hostEnvironment`).
    The config a pass holder reads carries the same environment.
  - `POST /api/auth/websocket-ticket/rpc` with `Authorization: Bearer <pass>`:
    `{ ticket, expiresAt }`, a new ticket (above), `expiresAt` its own end.
    The pass never reaches the socket's URL.
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
    `404`.
  - **Once connected**, t3's client reads two orchestration routes over HTTP
    (t3's `orchestration-v2/http.ts`). The host answers them with the same
    pass in the same header (a refused one is the `401` above), then checks
    t3's orchestration protocol header, which t3's endpoints declare
    (`x-t3-orchestration-protocol: 2`; without it an empty `400`, as t3's
    schema answers a header it refuses):
    - `GET /api/orchestration/shell`: the session's shell ("The shell",
      below) as t3's `OrchestrationV2ShellHttpSnapshot`, or
      `{ resumable: true }` for a `resumeFrom` cursor the socket can resume
      from. t3's client loads it for every environment it connects and then
      follows it over the socket (`state/shell.ts`); no t3 option skips it.
    - `GET /api/orchestration/threads/:threadId/bounded`: the session's thread
      as one window that holds all of it (`historyCursor: null`,
      `hasMoreHistory: false`: t3's bounded history windows are left out, so
      there is nothing older to page), shaped by t3's
      `boundedSnapshotResponseFields` as the client's flags ask
      (`compactTurnItems`, `dedupeBodies`, `compactIds`; `deferWork` defers
      nothing). The config says `threadSnapshotPagination: true`, so t3's
      client opens a cold thread over the socket alone the first time
      (`state/threads.ts`, `socketOnly`); a later cold open, after a failure
      or a first session that dropped before its data arrived, asks this
      route. Another thread id is t3's `404` `EnvironmentResourceNotFoundError`
      (`thread_not_found`), which t3's client reads as a thread that is not
      there.

    Every other route t3's contract names (a thread's full snapshot, its
    transcript and history pages, the project list) is a `404`: the chat
    `@consola/agent-ui` mounts asks none of them of this host.
    `AgentChat.console.browser.test.tsx` and
    `AgentChat.droppedOpen.browser.test.tsx` there record every response of
    400 or more and everything the page's console says at warning level or
    above (Playwright's console, Effect's warnings), from mount until the
    thread shows, a dropped first socket included, and find nothing.
  - A failure of the host's own while answering (not a refused pass, which is
    an answer) is logged to stderr, the request's pass taken out of it, and
    answered `500` (`hostHttp.test.ts`).
- **The shell** (`src/adapters/hostShell.ts`): t3's
  `subscribeOrchestrationV2Shell` (`ws.ts`) and its HTTP snapshot, from the
  handle's `shell`, composed with the lifted `ShellStream.ts` helpers for one
  thread. It lists the session's thread and its project and nothing else (but
  an agent run's dispatched agents, after it, "Agent runs"): an
  empty shell would tell t3's chat the thread is not there, and another row
  would be a thread the host does not serve. With no cursor it sends the
  snapshot, the completion marker the client asks for, then the thread's row
  after each batch of its stored events (`events(snapshotSequence)`, gathered
  for up to 50 ms as t3's `toShellStream` gathers them, an unchanged row not
  sent again within t3's window, the tail buffered by t3's budget). A cursor
  at or behind the thread's last event resumes (`canResumeShell`, which the
  HTTP route's `resumeFrom` asks too): the row as it is now if anything
  followed the cursor, the marker, then the same updates. A cursor past it
  (another host's) is `snapshot-required` for a client that asked for that
  (`httpSnapshotFallback`), else the snapshot. Once its row is listed, t3's
  chat reads the thread's title and status from it (`ChatView`'s
  `serverThread`) rather than from the projection, so the row is read from
  the store the projection is read from and sent again after every event of
  the thread: what the chat renders follows the thread (`rpcServer.test.ts`
  "follows the thread over the socket", `@consola/agent-ui`'s
  `AgentChat.console.browser.test.tsx`). Left out, as the host offers none of
  them: repository identities and their enrichment refreshes, idle subagents
  and older settled threads (`omitIdleSubagents`, `omitOlderSettled`, which
  t3's client sends only to a server that advertises them), and the archive.
- **Methods the chat calls and the host refuses.** Running t3's copied chat
  (`@consola/agent-ui`) against a replay host, the chat calls two methods
  beyond `SERVED_METHODS`: `subscribeDeviceState` (the phone preview) and
  `subscribeProjectClones` (project clones). Both stay refused: the chat
  shows the thread, its composer and its model without them, and both are
  parts of t3 the plan leaves out. Sending from the composer is not yet
  exercised against the host by a test.
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
the host never uses it, and `SessionSpec` has no field to ask for it, with one
deliberate exception: an agent run (`SessionSpec.agentRun`, `--agent-run`),
whose threads all open in `full-access` (`AGENT_RUN_RUNTIME_MODE`), since
nobody watches or approves them. It runs only in a sandbox, which is its
boundary: `--agent-run` with `--dev` is a start failure ("Agent runs").

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
  records no provider MCP session and a CLI starts without one. An agent run
  replaces it with its own (`agentRunMcp.ts`, "Agent runs").
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

`drivers.ts` and `credentials.ts` reach none of it. Nothing the host runs
calls the Cursor SDK (no Cursor driver is hydrated). The host's bundle keeps it
out ("The bundle and the session template"): it stubs
`@t3tools/provider-cursor/server*`, and its build fails on any `@cursor/sdk` in
what it writes.

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

`src/main.ts` is the package's `consola-host` bin (it loads `src/bin.ts`), run by
Node 26 straight from source (type stripping; no build step), or from its bundle
in the session template ("The bundle and the session template"):

```
consola-host session --session-id <id> --harness <claude|codex|opencode|pi|acp> --cwd <dir>
  [--port <n, default 7420; 0 for a free one>] [--bind <address, default 127.0.0.1>]
  --pass-public-key <Ed25519 public key, SPKI PEM file> | --dev
  [--idle-minutes <n, default 10; fractions allowed>] [--state-dir <dir>]
  [--agent-run <JSON file: an AgentRun; never with --dev>]
```

The runner role (`consola-host runner`) starts it in a sandbox and reads its stdout. It opens the
session's thread (`ThreadRuntime.open`), then listens (`listenHost`), so
`ready` means a client can connect now.

- **Stdout is JSON lines and nothing else** (`HostLine`,
  `adapters/stdoutEvents.ts`), each flushed before the next is written:
  `{"type":"ready","port":<n>}` (the port it got), with `--dev`
  `{"type":"dev-pass","pass":"<jwt>","expiresInSeconds":43200}`, then
  `{"type":"title","title":"…"}` and
  `{"type":"status","status":"working"|"waiting"|"idle"}` as they change, and
  `{"type":"exit","reason":"idle"}`; for an agent run, `{"type":"agent-run",…}`
  as its report changes ("Agent runs"). Every Effect log goes to stderr
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
  last said, and `ready` says idle and the thread's first title, read before
  `ready` is written (`reportSession`'s `said`), so a retitle in between is
  said too. t3 titles a
  thread twice on its first message, from the message's title seed and then
  with its generated title, so both are lines.
- **Idle exit.** Each second the host asks `isIdle` with the server's
  `connectedClients()`, whether a turn runs (`working`), and the last activity:
  the thread's (`lastActivityMs`) or the last moment a client was connected,
  whichever is later; becoming ready counts as activity. When it holds, the
  host prints `exit`, closes the session and exits 0. Closing has the
  shutdown's grace too: however a session ends (idle, a failure, a signal),
  `runSession` arms the forced exit (`HostStopping`) before anything it
  started is closed, so a stop that hangs (a provider session's, say) ends in
  exit 1 and `consola-host: the session did not stop in time.` 15 seconds
  later, within the runner's `EXIT_LINE_GRACE` (30 s from the `exit` line;
  `bin.test.ts`, with `CONSOLA_TEST_SESSION_STOP=hangs`, which
  `testing/replaySession.ts` reads). A pending approval or
  question (`waiting`) does not hold it: with no page connected and no turn
  running, the host exits once the idle minutes pass, and the request, the
  thread and its history (t3's in-memory SQLite) go with it.
- **Signals.** SIGTERM and SIGINT interrupt the program: its scope closes (the
  server, the thread, the provider session and the CLI it runs), then the
  process exits 0 (1, with a message, if that takes over 15 seconds). That
  holds from the first moment: loading the program takes seconds, and the bin
  (`main.ts`) listens for both before it loads anything, so a signal that
  comes meanwhile never ends the process by the signal. Node hands it over
  when its event loop next turns: while loading, nothing has started and the
  process exits 0; after, the program's handlers have it, as above
  (`bin.test.ts` signals a host 400 ms after spawning it, before `ready`, and
  sees exit 0). The bundle keeps this entry, its program loaded lazily behind
  it: its listeners are there once Node has parsed the file (a few hundred
  milliseconds for its 23 MB), not once the program has loaded.
- **A stale thread ends the session.** Should the thread's event stream end
  (`ThreadHandle.ended`), the host stops as from a failure: its scope closes
  under the grace, and it exits 1 with `consola-host: Session <id> stopped:
  its thread's event stream ended, so what it shows would go stale.` as the
  last line on stderr, which the runner reports as the session's `failed`
  error (`bin.test.ts`, with `CONSOLA_TEST_EVENT_STREAM=ends`).
- **Start failures** (a bad flag, a key file that cannot be read or is not an
  Ed25519 public key, `--cwd` not a folder, a port taken): a message on stderr
  (`consola-host: …`, with the usage for a bad flag), exit 1, nothing on
  stdout. The key is read and checked before any CLI starts.
- **`--dev`** stands in for the cell: an Ed25519 key pair made in memory
  (`adapters/devPass.ts`), whose private key is never returned, printed or
  written, and one pass signed with it as the cell signs one (EdDSA, `typ`
  `PASS_TYPE`, `aud` `PASS_AUDIENCE`): `sub` `dev`, `ws` `local` (names no
  person or workspace has), `sid` the session id, `iat` now, `exp` twelve hours
  later (`DEV_PASS_SECONDS`). `--pass-public-key` is ignored and `--session-id`
  defaults to `dev-session`. It listens on loopback only: `--dev` with a
  `--bind` other than `localhost`, `::1` or a `127.0.0.0/8` address is a start
  failure (`isLoopback`, `core/bind.ts`), and `listenHost` refuses a `dev`
  host bound anywhere else too. Without `--dev`, `--pass-public-key` is
  required.

  **Why a dev pass outlives the cap.** A cell's pass lives five minutes at
  most, and the cell signs a new one when the page asks (`onPassExpired`). The
  dev page has no cell to ask, so a five-minute dev pass would need a renewal
  path of its own: an endpoint on the host that signs passes, which is a new
  way in. So `--dev` is exempt from the lifetime cap and from nothing else: its
  pass carries the cell's `typ` and `aud`, is read by the protocol's rules but
  the cap (`readPass` with `PassLifetime` `dev`, held to `DEV_PASS_SECONDS`),
  and is taken only by the host that made the key, on loopback. A host started
  with `--pass-public-key` takes the protocol's lifetime and no other, whatever
  a pass says.
- **State.** t3's state and settings live in `--state-dir`
  (`<dir>/userdata/settings.json`), or in a temporary folder removed at exit.
  The tests pass one whose settings turn update checks off, so a host they
  start asks no one online.

`runSession(args, runtimeFor)` takes the runtime as a parameter; `main`
(which `main.ts` calls) passes `ThreadRuntime.layer`. `testing/replaySession.ts`
runs the same `sessionCommand` and `runHostProcess` over `layerForTests` with
the Claude replay driver, checking out the fixture's workspace as `--cwd`.
`bin.test.ts` starts both with node under the test's machine (fake CLIs on the
PATH, the test's home): the replay through a whole turn (`ready`, `dev-pass`, a
message sent through a ticket for the pass, `status` and `title` lines, exit 0 on SIGTERM), and
the real bin for `ready`, `dev-pass`, a socket opened with a ticket for the pass, SIGTERM
with no process left (a fake `claude` that stays running, as the capabilities
probe's would), the cell's key, the idle exit, and the start failures. Each
asserts that every stdout line is a `HostLine`.

## Agent runs

An experiment beside Consola's "steps": a session started by an event (a pull request) whose
first agent, the orchestrator, dispatches other agents and posts the result itself. Nobody types
and nobody approves.

- **The flag.** `--agent-run <file>`: an `AgentRun` (`@consola/runner-protocol`) as JSON, read
  with `readAgentRun` before any CLI starts; a file that cannot be read, is not JSON or is no
  agent run is a start failure, and so is `--agent-run` with `--dev`. `SessionSpec.agentRun`
  carries it. Once `ready` is written, the host sends `prompt` as the thread's first message
  itself (`AgentRunHandle.start`), past `decideCommand`, which governs RPC clients alone.
- **Full access.** Every thread of the run opens in `full-access` (`AGENT_RUN_RUNTIME_MODE`),
  the one exception to "The host never starts a CLI in full access": the sandbox is the
  boundary. Every other session is unchanged. `model` (and an agent's) is used when the
  provider lists a model with that slug or alias (waiting up to 15 s for its list), else the
  harness default, with one warning line on stderr.
- **Dispatched agents are threads of the host's own** (`runtime/agentRun.ts`): `thread.create`
  in the session's project and folder, then `message.dispatch` of the agent's instructions,
  `# Brief from the orchestrator` and the task, on the agent's model. t3's own delegated tasks
  were not used: their MCP handlers are not vendored, and host-owned threads need nothing more.
  At most 4 run at once (`MAX_RUNNING_AGENTS`), 32 in all.
- **Reports are messages.** When a dispatched agent's run ends, its final assistant message
  (or its status and t3's reason, with nothing invented) goes to the orchestrator's thread as
  `Report from agent \`<name>\` (id <thread>, status <status>):`, `queue_after_active`. One
  evaluator fiber decides every delivery under one lock with the tool calls, marks each run
  reported once, and keys the command id by the run, which t3 runs once. It is woken by t3's
  stored events and re-reads every thread after a quiet second, so a missed event costs a
  second. A follow-up (`t3_thread_send`) is the next turn of the same conversation, reported
  the same way. No tool call is held open for a turn, and nothing polls.
- **`/mcp`** (`adapters/mcpHttp.ts`): the run's `McpSessionRegistry` (`agentRunMcp.ts`, in
  place of `layerMcp`) gives each provider session t3's `t3-code` server at
  `http://127.0.0.1:<port>/mcp` with a random bearer token of its own thread, so t3's Claude and
  Codex adapters connect it and add t3's orchestration instructions. `POST` only (`405`
  otherwise), the token before the body (`401`), compared by SHA-256 in constant time, never
  logged; no CORS. Stateless MCP over JSON (`core/mcpProtocol.ts`): `initialize`, `ping`,
  `tools/list`, `tools/call`, notifications `202`. Another session has no `/mcp` (`404`).
- **The tools** (`core/agentRunTools.ts`), named as t3's instructions teach:
  `orchestrator_capabilities`, `delegate_task({agent, task})`, `t3_thread_send({threadId,
  message})`, `task_status({taskId})` (recovery only), `task_cancel({taskId})` and
  `complete_task({summary})`. A dispatched agent may call none but the first ("You cannot
  dispatch other agents.").
- **The `agent-run` line**: the run's `AgentRunReport` beside `type`, printed on every change
  (`reportAgentRun`, from `agentRunView`): `waiting` while a thread waits on a question,
  `working` while any runs, has a message queued or a report undelivered, else `done` or
  `failed` by the orchestrator's last run. `summary` is its last message, or `complete_task`'s
  while nothing followed it; each agent's is its last report, cut to 2,000 characters. The
  `status` line and the idle exit count every thread the same way (`currentStatus`).
- **Known gap: the sandbox trusts the pull request.** Every thread runs in full access, in a
  checkout of the pull request's head, whose `.claude` settings, hooks and `CLAUDE.md` the CLI
  loads, and the sandbox holds the runner's own git token as `GH_TOKEN` (today a person's), whoever
  opened the pull request. Nothing skips a fork or an author outside the organisation. So a runner
  serves agent runs only on repositories whose contributors are trusted, until runs get a
  short-lived token of their own and untrusted heads are refused.
- **A person's follow-up** (`adapters/followUpHttp.ts`, `POST /agent-run/follow-ups`, the
  protocol's `FOLLOW_UP_PATH`): the cell hands the orchestrator a message a person wrote while the
  run goes on (a reply in the Slack thread it answers in, say). Only an agent run serves the path
  (every other session's is the `404` of an unknown path), `POST` only (`405`), and the pass comes
  before the body: one the socket's ticket would refuse is `401` (another session's included). The
  body (`FOLLOW_UP_BODY_MAX_BYTES`, `413` past it) is the protocol's `readFollowUp` (`400` with the
  reader's reason): the cell's `key`, the `text` and an `authorLabel`; the person is the pass's
  `sub`. `AgentRunHandle.followUp` waits for the run's prompt to go first (`503`, `Retry-After: 5`,
  past `FOLLOW_UP_START_WAIT`, 5 s), then dispatches one `message.dispatch` into the
  orchestrator's thread, `queue_after_active`, on its model, under the run's lock, and nothing
  else. The message is composed in one place (`core/followUp.ts`, `followUpMessage`): `# Follow-up
  from a person`, who wrote it (the label and the person's id), that it is untrusted and never
  overrides the orchestrator's instructions, then the text as written in a fence it cannot close
  (`fenceFor`: one backtick more than its longest run, three at least). The command and message
  ids are made of the key (`follow-up:<key>`), so t3 runs it once whoever sends it again, and says
  so (`replayed`): the answer is the protocol's receipt, `delivered` or `already-delivered`. A
  refusal by t3 is `500`, logged with the pass and the text taken out. No CORS: the cell calls it,
  never a page. A pass holder could send the same message over the socket, unfenced; this path
  adds only the fence and the label, and the label is the sender's words, never checked.
- **What a browser reads**: the dispatched agents' threads, read-only
  (`subscribeThread`, `subscribeCommandOutput`, the bounded snapshot; `readableThread`), and
  their rows after the session's in the shell. Commands still reach only the session's thread.

Tests: `core/agentRun.test.ts`, `core/followUp.test.ts`, `runtime/agentRun.test.ts` (a fake
orchestrator: exactly-once delivery, the cap, refusals, a follow-up once per key and after the
prompt), `adapters/mcpHttp.test.ts`, `adapters/followUpHttp.test.ts` (the route alone, and through
`listenHost` with a pass signed as the cell signs one), and `stdoutEvents.test.ts` (the
`simple` replay as an agent run, without the MCP server its recording lacks: `agentRunMcp: false`).

## The `runner` command

`consola-host runner` is the host's other role: a workspace's runner. It dials
its cell, the cloud app (`apps/cloud-api/AGENTS.md`, "The runner's socket"),
and runs each session the cell asks for in a sandbox of its own, through
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
  `OPENAI_API_KEY` codex, and `E2B_API_KEY`, the key of the E2B account its
  sandboxes run on ("The provider"). `CONSOLA_SESSION_TEMPLATE` (optional, no
  secret; `sessionTemplateFrom`, `^[a-z0-9][a-z0-9-]{0,62}$`, a start failure
  otherwise) names the template to start sessions from instead of
  `consola-session`, and `template:build` builds under the same name: a branch
  can build `consola-session-orchestrator` while another runner keeps the real one.
- **Start failures** follow the session command's: `consola-host: …` on stderr,
  exit 1, nothing on stdout. A bad flag (with the usage), a `--cell-url` that is
  not `wss:` or is `ws:` to a host that is not loopback, or carries user info,
  a query or a fragment (it is logged; `cellUrlProblem`), no secret, a
  repository `isRepository` refuses, no API key (no harness to offer), and no
  sandbox provider (no `E2B_API_KEY`). No message quotes a secret.
- **The provider.** `runnerCommand(argv, env, providerFor)` takes the provider
  from a factory of the environment (`ProviderFor`). Production's
  (`productionProvider`) is E2B's (`new E2BProvider({ apiKey })`, from
  `@consola/sandbox/e2b`), on the account where the `consola-session` template
  is built, with `E2B_API_KEY`. The host's source reads the key and hands it
  over, never leaving E2B's SDK to find it in the process's environment, so it
  is one of `RUNNER_SECRET_VARIABLES`. With no key there is no provider, and
  the runner fails at start; it never falls back to a fake. Tests run
  `testing/replayRunner.ts`, the same command on `testing/localProvider.ts`,
  whose sandboxes' processes get the sandbox's variables over only
  `MACHINE_VARIABLES` of the test machine (`PATH`, the home and XDG folders,
  the temporary folder, the locale), never the runner's own environment, so a
  test can check what a sandbox was given (its `printenv`;
  `localProvider.test.ts`).
- **A session's sandbox** (`adapters/sandboxSessions.ts`). A `session.start`
  for a repository or harness the runner does not offer is `failed`, with no
  sandbox (`offerRefusal`). Otherwise the sandbox is created from the template
  `consola-session` (or `CONSOLA_SESSION_TEMPLATE`'s) with `CONSOLA_SESSION_ID`, `CONSOLA_HARNESS`,
  `CONSOLA_REPOSITORY`, `CONSOLA_PASS_PUBLIC_KEY`,
  `CONSOLA_SESSION_IDLE_MINUTES`, `GIT_TOKEN` and the API key of that harness
  alone (`sandboxEnvFor`), and runs `consola-session-start`, its output only
  listened to (`keepOutput: false`). It is created with `publicPorts`: the
  browser reaches the host at the exposed address, and a browser's WebSocket
  cannot carry the provider's credential, so the host guards its port itself
  (a pass, then a ticket). That opens every port the sandbox listens on, a dev
  server the person approves included, until a gateway stands in front
  (Linear: "10.5 A session gateway: sandboxes stay private, the browser
  reaches the host through Consola",
  https://linear.app/consola/issue/CON-105). A second start for a session held is
  ignored; a start once the runner is stopping is `failed`, with no sandbox,
  since nothing would stop it.
- **A sandbox's own lifetime** (`sandboxLifetimeSeconds`). Its provider stops
  it when its lifetime runs out (`@consola/sandbox`, a hard maximum), which is
  what stops a sandbox whose runner died, and what stops it at the cap should
  the runner's own stop then fail (a stop is asked once). Where the provider
  renews lifetimes (`keepAlive`, as E2B does), a sandbox is leased for
  `SANDBOX_LEASE_SECONDS` (ten minutes) and renewed every
  `SANDBOX_LEASE_RENEW_SECONDS` (three) while the runner holds the session, at
  a fixed rate: each renewal is a fiber of its own, so one that hangs (up to
  `SANDBOX_CALL_TIMEOUT`) never holds back the next, a failed one is logged,
  and the lease runs out only after the three asked within it fail in a row.
  It is never given past the lifetime cap, measured from the session's start
  (what is left of it, in whole seconds, once that is shorter than the lease;
  one second at least). With a provider that cannot renew, the sandbox is made
  with all that is left of the cap. So a sandbox outlives a dead runner by ten
  minutes at most, and its cap by no more than the second a lifetime is
  counted in and the time its provider takes to answer. The provider may also
  stop it up to that second before the cap, so the runner's own stop at the
  cap comes first (`lifetimeStopAfterMs`, "Backstops").
- **What a line becomes** (`readSessionLine`, `updateForLine`; stdout arrives in
  chunks, `HostLineBuffer` makes them lines). `ready` exposes the port it names
  (never a fixed 7420) and says `{ status: 'running', hostUrl }` with the
  provider's address, once it is an origin the cell takes (`isHostUrl`); an
  address that cannot be had fails the session and stops its sandbox. `title`
  says the title, and `agent-run` the run's report (`agentRun`, below). The start script's `clone-failed` says `failed` with its
  message, and is read only before `ready` (the script prints it before the
  host runs). `status`, `dev-pass`, the host's `exit` and anything unreadable
  say nothing. Once a session's end is said, a later `ready` exposes nothing.
- **An agent run's sandbox** (a `session.start` with `agentRun`; the protocol's
  `AGENTS.md`, "Agent runs"). Nothing else about an ordinary session changes.
  - Its variables (`sandboxEnvFor`) add `CONSOLA_AGENT_RUN`
    (`/workspace/.consola/agent-run.json`, `AGENT_RUN_FILE`), `CONSOLA_CHECKOUT_REF`
    and `CONSOLA_CHECKOUT_SHA` when the run names a `checkout`, and `GH_TOKEN`, the
    git token's value, when the runner has one, so `gh` acts as the token's user.
  - Once the sandbox is made and before its start script runs, the runner writes
    each of the run's `files` at `/workspace/factory/<path>`
    (`AGENT_RUN_FACTORY_DIR`) and the whole run as JSON at `AGENT_RUN_FILE`
    (`agentRunFilesFor`, eight at a time), all within `SANDBOX_CALL_TIMEOUT`. A
    write that fails or takes longer fails the session, naming the file, and
    stops its sandbox, like a failed `create`.
  - The start script fetches the checkout's ref after the clone, through the same
    helper, checks its commit out detached and starts nothing unless `HEAD` is
    that commit (a failure is its one `clone-failed` line), then passes
    `--agent-run "$CONSOLA_AGENT_RUN"` to the host.
  - The host's `{"type":"agent-run","state":…,"summary"?:…,"agents"?:[…]}` line
    (`HostLine`, read by `readAgentRunReport`) becomes `session.update { sessionId,
    agentRun }`, scrubbed (`scrubAgentRunReport`: summaries and ids, then bounded
    to `AGENT_RUN_SUMMARY_MAX`; a dispatched agent whose name holds a secret is
    left out). The last report is kept and said again with the session's
    `running` state after every `hello`.
  - `scripts/agent-run-smoke.ts` plays the cell for one run against the real
    runner, from the repository's root: `node --env-file=packages/host/.env
    packages/host/scripts/agent-run-smoke.ts --repository <owner/name> --agent-run
    <file.json> [--harness claude] [--timeout-minutes 45]`. It prints each update as
    a line, the run's summary at its end, and an `@consola/agent-ui` dev page URL
    with a fresh pass every four minutes (and on SIGUSR1); it stops the session and
    the runner, and exits 0 only for `done`.
- **What an end becomes** (`updateForExit`), said once, the cell's stop always
  `stopped`. Before `ready`, any end the cell did not ask for is `failed` (the
  cell keeps a starting session starting on a `stopped`), with the last line on
  stderr for a non-zero exit. After it, the host's own exit (its `exit` line) and
  the runner's stop are `stopped`; a non-zero exit is `failed` with the last line
  on stderr; a signal from elsewhere is `failed` ("The session's sandbox
  ended."), and so is exit 0 with no `exit` line, since the host ends that way
  only when something in the sandbox stopped it. A provider's failure (quota, a
  missing template's `not-found`) is `failed` with its message.
- **Backstops.** The sandbox is stopped whenever its session ends: when its
  command ends, and at once when the session fails while its command runs on
  (a failed clone, a port that cannot be exposed), since an ended session is
  in no `hello` and the cell could never ask for that stop. The
  runner also stops it on the cell's `session.stop`, `EXIT_LINE_GRACE` (30 s,
  over the host's 15 s shutdown grace) after the host's `exit` line, at the
  lifetime cap (`--max-session-minutes`), and on SIGTERM or SIGINT, when it says
  each session's end while the socket is still open, then stops every sandbox,
  then closes the socket (1001) and exits 0. Its stop for the cap comes
  `SANDBOX_STOP_TIMEOUT` (30 s) before it (halfway to a cap under a minute;
  `lifetimeStopAfterMs`): the provider stops the sandbox at the cap, or up to a
  second before it, and were it first the session's command would end before
  the runner's stop, and read as a sandbox that ended by itself (`failed`). So
  the runner's stop is asked first, and over by the cap, and the session is
  `stopped` (`sandboxSessions.test.ts`, a provider whose sandboxes end in real
  time at their lifetime). A sandbox's stop is asked once per
  session, and a stop that fails is asked again (`STOP_ATTEMPTS`, 3, after
  0.5 s then 1 s), each failure logged with its reason; all of it within
  `SANDBOX_STOP_TIMEOUT` (30 s) while running. Once the runner begins to stop,
  a deadline is set `SHUTDOWN_STOP_TIMEOUT` (10 s) from that moment, and every
  sandbox's stop and every wait for a stopped sandbox's command (otherwise up
  to 10 s, `STOPPED_COMMAND_WAIT`) ends by it, however late it began: a stop
  that begins 1 s into the shutdown gets the 9 s left. That leaves the
  socket's close its 3 s inside the 15 s grace. Past either bound, it is
  logged and the session's end is said anyway.
- **A provider's calls are bounded.** `create`, `start` and `exposePort` (E2B
  makes network calls for each) fail the session past `SANDBOX_CALL_TIMEOUT`
  (60 s): `The sandbox was not made within 60 s.`, `… did not start the
  session …`, `… did not expose the session's port …`, and the sandbox, if
  there is one, is stopped. A provider cannot be told to give up a call, so a
  sandbox made after its create timed out is stopped as it arrives (logged).
  These bounds are not the shutdown's: a call still pending when the runner
  stops can outlast the grace, and the forced exit is what ends that.
- **The forced exit.** However the runner begins to stop (a signal, a
  replacement, a failure), it first arms it (`HostStopping`, which
  `runHostProcess` provides), the backstop should stopping still hang: past
  15 s it exits 1, saying "the runner did not stop in time" (`bin.test.ts`,
  a sandbox whose create never returns: `CONSOLA_TEST_SANDBOX_CREATE=hangs`,
  `LocalProvider`'s `createHangsForTests`).
- **The socket** (`adapters/cellSocket.ts`, on `ws`: Node's own WebSocket cannot
  portably send `Authorization`). Each connection opens with `hello` (the offer,
  `runningSessionIds`, and `endedSessions`), then every live session's state
  again (`running`, its address and title), since the cell may drop updates
  that went on a socket it replaced. An update while the socket is down is not
  queued; an end is held for the next `hello` (`EndedSessions`). Once it went
  out, a ping follows it, and it is heard only when that ping's pong comes back
  (the cell reads a socket's frames in order); should the connection close
  first, however long it was open, the end goes again in the next `hello`. An
  id is never listed as running and ended at once. A `hello` over the socket's
  frame limit (`RUNNER_SOCKET_FRAME_LIMIT_BYTES`, the protocol's 4 MiB) sends
  its ends without their messages. A drop is dialled again
  after a jittered wait doubling to 30 s (`reconnectDelayMs`), starting over
  once a connection has held 10 s. A close with 4000 means another process with
  this secret said hello and replaced this one: it stops its sandboxes (as at
  SIGTERM, within the shutdown's bound), stops dialling and exits 1 saying so,
  so two runners sharing a secret never take the socket from each other in a
  loop. Frames over 4 MiB close the socket (1009); a frame
  `readCellMessage` refuses is logged with its reason and dropped. A failure of
  the runner's own while connected ends that connection, never the dialling.
  **The heartbeat** (`Pings`): a ping at least every `HEARTBEAT_INTERVAL_MS`
  (25 s), each carrying its number, which the pong echoes; a ping unanswered
  for `PONG_TIMEOUT_MS` (10 s) drops the socket (`terminate`) and dials again,
  so a socket that died without a close (a NAT that forgot it, a laptop that
  slept, a cell gone without a reset) is not written into for the minutes TCP
  takes to notice. The cell answers pings as `ws` does by default.
- **Secrets.** It never logs its environment. Its secret variables are one
  list, `RUNNER_SECRET_VARIABLES` (`core/runnerDecisions.ts`): the runner
  secret, the git token (and `GH_TOKEN`, which an agent run's sandbox gets),
  each harness's API key and `E2B_API_KEY`, and
  `bin.test.ts` fails on a secret-named variable the host's source reads that
  the list lacks. Its log lines (stderr, `consola-host runner: …`)
  and every update are scrubbed of those variables' values (`secretValuesOf`,
  `scrubSecrets`, as they are and URL-encoded), errors and
  titles before they are bounded to 1000 characters, an agent run's report
  before it is bounded to the protocol's caps (`scrubUpdate`), and a
  command's stderr as it arrives, before its tail is cut (`StderrTail` holds back
  what may start a secret split across chunks). `hostUrl` is the provider's
  address, checked as an origin, never the sandbox's text. Stdout stays empty.

`bin.test.ts` runs `testing/replayRunner.ts` under the test's machine against a
cell of its own (a `ws` server on loopback): the secret in the upgrade, `hello`,
a `session.start` with a real key, `running` at `http://127.0.0.1:<port>` where
the replayed host answers, then SIGTERM: `stopped`, the socket closed with 1001,
exit 0, no process left, and no secret on stderr. With
`CONSOLA_TEST_SANDBOX_STOP=hangs` (`LocalProvider`'s `stopHangsForTests`) no
sandbox's stop returns: SIGTERM still says `stopped` and exits 0, and a
replacement (4000) exits 1 saying why, both within the grace. With
`CONSOLA_TEST_SANDBOX_CREATE=hangs` no create returns: SIGTERM exits 1 past
the grace, saying the runner did not stop in time.
It runs the real bin for each start failure. `sandboxSessions.test.ts` drives the sessions over the fake
provider, and `cellSocket.test.ts` the socket against a `ws` server.
`@consola/cloud-session-e2e` runs the same runner against the built cloud app, end to end
(`packages/cloud-session-e2e/AGENTS.md`).

## The bundle and the session template

A cloud session's host runs in a sandbox made from the `consola-session`
template (`sandbox-template/`, whose `README.md` lists what it holds, how to
build it and its id), from a bundle rather than from source.

- **The bundle.** `pnpm --filter @consola/host bundle` (`scripts/bundle.ts`,
  esbuild: platform `node`, format `esm`, target `node26`) writes
  `dist/consola-host.mjs`, one ESM file from the bin (`src/main.ts`), and
  `dist/claude-history-worker.mjs` from t3's `claude-history-worker.ts`: t3's
  Claude adapter runs that worker as a process of its own, from beside the file
  it runs in (`./claude-history-worker.mjs`, as t3's own build lays it out), to
  read a Claude conversation it resumes. It also writes esbuild's metafile,
  `dist/consola-host.meta.json`. Each file holds everything it runs but Node's
  own modules (and `ws`'s optional `bufferutil` and `utf-8-validate`, required
  inside a `try`), with these exceptions:
  - **External:** `@ff-labs/fff-node` (t3's workspace file search) and
    `ffi-rs` (the native bridge it loads). t3 requires both at run time with
    `createRequire(import.meta.url)`, so from beside the bundle:
    `WorkspaceSearchIndex.ts` loads fff-node as the host starts, and
    `CheckoutCloner.ts`, `ManagedPolicy.ts` and `antigravityUsageLimits.ts`
    load ffi-rs on demand. The template installs both under
    `/opt/consola/node_modules`, at the workspace's versions, with their
    `linux-x64-gnu` builds and pnpm's patch to fff-node
    (`patches/@ff-labs__fff-node@0.11.0.patch`, which points its CommonJS entry
    at the async search methods t3 calls).
  - **Absent on purpose:** `@napi-rs/keyring`, which t3's Antigravity driver
    requires the same way (`antigravityUsageLimits.ts`) to read Antigravity's
    sign-in from the system keyring. The host never hydrates that driver (a
    sandbox runs claude or codex), so nothing reaches the require, and the
    template does not install it. `bundle.test.ts` lists every package the
    bundle requires as it runs (its `createRequire` calls, which the metafile
    does not show, and its `__require`s) and fails on any it does not name.
  - **Stubbed:** `@t3tools/provider-cursor/server*` (`CURSOR_STUBS`), so the
    Cursor SDK is never in it ("The Cursor SDK is in the runtime's module
    graph"). Each stub has the exports its importers read as they load, and
    throws if Cursor is ever used; a path with no stub fails the build, and so
    does any `@cursor/sdk` left in what it writes.
  - **Bundled: the Claude Agent SDK.** It goes in at the version and with the
    peers the lockfile resolves (0.3.321, `@anthropic-ai/sdk` 0.93.0), with no
    native CLI of its own (the workspace's overrides drop those, and the host
    always passes `pathToClaudeCodeExecutable`), where an install in the
    template would resolve its peers again and fetch a native CLI nothing runs.
    So the bundle, like the template, is never published or released
    ("Licensing"); `bundle.test.ts` asserts the SDK is in it, so undoing this is
    a decision, not an accident.
  - A banner gives the CommonJS modules in it `require`, `__filename` and
    `__dirname` for the bundle's own file, and names are kept (`keepNames`).
- **The template**, `sandbox-template/`: a `Dockerfile` in the format
  `@consola/sandbox/e2b` builds (one stage; `packages/sandbox/AGENTS.md`,
  "Templates") holding Node 26.13.1, git, `gh`, the Claude Code and Codex CLIs at
  pinned versions, the two bundled files in `/opt/consola`, and
  `consola-session-start`. No version goes in an `ARG`, which E2B keeps as a
  variable of every command the sandbox runs, and it writes no t3 settings: a
  `launchArgs` there would override the host's approval mode ("The host never
  starts a CLI in full access"). `pnpm --filter @consola/host template:build`
  (`scripts/build-template.ts`) bundles, stages the folder with the bundled
  files and the fff-node patch in `dist/sandbox-template/`, and builds it on
  E2B with `buildE2BTemplate` under `SESSION_TEMPLATE` (or the name
  `CONSOLA_SESSION_TEMPLATE` gives), with `E2B_API_KEY` from
  the environment or `packages/sandbox/.env`.
- **The start script**, `consola-session-start` (POSIX `sh`), run by the runner
  in each sandbox: it clones `https://github.com/$CONSOLA_REPOSITORY.git` into
  `/workspace/repo` (the whole URL, so an owner starting with `-` is no option)
  with a credential helper for github.com that answers with `$GIT_TOKEN` as the
  environment holds it, so the token is never in a URL, on a command line, in
  `.git/config` or in git's error text; the repository keeps that helper (an
  empty one first, so no helper of the machine's is asked or stores the token),
  `user.name` `Consola session` and `user.email` `session@consola.invalid`. A
  failed clone prints one `clone-failed` line (`StartScriptLine`), git's words
  with the token, as it is and URL-encoded, taken out by `node -e`, and exits 1.
  With `CONSOLA_CHECKOUT_REF` (an agent run's) it then fetches that ref, checks
  `CONSOLA_CHECKOUT_SHA` out detached and requires `HEAD` to be it, a failure
  printing the same one line. It writes `$CONSOLA_PASS_PUBLIC_KEY` to `/workspace/.consola/pass-public-key.pem`,
  signs Codex in for a Codex session (`codex login --with-api-key`, the key on
  stdin: Codex reads no API key from its environment, where Claude Code reads
  `ANTHROPIC_API_KEY`), and then `exec`s `node /opt/consola/consola-host.mjs
  session … --cwd /workspace/repo --bind 0.0.0.0 --port 7420 --pass-public-key
  … --idle-minutes ${CONSOLA_SESSION_IDLE_MINUTES:-10}`, with `--agent-run
  "$CONSOLA_AGENT_RUN"` added for an agent run (the file must be there). Bound past loopback,
  the host's descriptor names no platform or version ("Before the socket").
  Stdout is the runner's: nothing else is printed there.
- **Tests** (`src/bundle.test.ts`) build the bundle, read its metafile (only
  Node's modules imported, no Cursor provider module or SDK, Claude's SDK in),
  and run it from a temporary folder holding the two files and the run-time
  packages (the workspace's own), with `NODE_PATH` taken out of its
  environment: pnpm sets it for the test runner, and with it a bundle finds
  packages in the workspace's store that no sandbox has. There a claude and a
  codex session each run to `ready` and `dev-pass` against fake CLIs and exit
  0 on SIGTERM, it fails to start without the run-time packages, and its
  history worker reads a Claude conversation. They list what the bundle
  requires as it runs (above), check the Dockerfile's instructions, versions
  and patch against the workspace's (Node unpacked whole, once the base
  image's own Node is gone; Claude Code's postinstall allowed; and a Claude Code
  no older than the one the bundled SDK names, `sandbox-template/README.md`), and
  run the start script under `sh` with stand-ins for `git`, `node` and
  `codex`.

## Running it

```bash
pnpm --filter @consola/host test        # vp test run (Vite+), config in vite.config.ts
pnpm --filter @consola/host typecheck   # effect-tsgo, hoisted by publicHoistPattern
node packages/host/src/main.ts session --dev --harness claude --cwd <folder>   # from the repo root
pnpm --filter @consola/host bundle      # dist/consola-host.mjs ("The bundle and the session template")
```

The host loads its two Consola dependencies, `@consola/runner-protocol` and `@consola/sandbox`,
from their built `dist/`, which a fresh checkout does not have. Build them once first, and after
changing either: `pnpm exec turbo run build --filter=@consola/host^...` (the package's own
`test` and `typecheck` through Turborepo do it for you, as `pnpm test` does).

### Running it with the chat

`packages/agent-ui`'s dev page renders `AgentChat` full-window against a host on this Mac, with
the person's own signed-in `claude`. Two commands, from the repository root, in two terminals:

```bash
node packages/host/src/main.ts session --dev --session-id demo-1 --harness claude --cwd <folder>
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

## Local cloud session demo

A cloud session by hand, on this Mac: the cloud app (`apps/cloud-api`) and its
web app run locally, and the runner starts each session in an E2B sandbox. The
automated version, with no credential and no provider, is
`packages/cloud-session-e2e`. Every secret below lives in a local `.env`, which
git ignores (`.env*`) and which is never committed; `pnpm install` links a
worktree's to the main checkout's.

Each process reads its own `.env`, made by copying the `.env.example` beside
it, which says what every line is for, how to make its value, and which value
must match another file's:

| File | Process | For the demo |
| --- | --- | --- |
| `apps/cloud-api/.env` | the API (3100) and the web app (5175), `pnpm dev:cloud` | its REQUIRED block (Google sign-in) and its RUNNER block: `RUNNER_SECRET`, `RUNNER_WORKSPACE_ID`, `PASS_PRIVATE_KEY` |
| `packages/host/.env` | the runner, through Node's `--env-file` (step 3) | `CONSOLA_RUNNER_SECRET`, `CONSOLA_RUNNER_REPOSITORIES`, `E2B_API_KEY`, `ANTHROPIC_API_KEY`, `GIT_TOKEN` |
| `packages/sandbox/.env` | `template:build`, the sandbox package's live tests | `E2B_API_KEY`, only to rebuild the `consola-session` template |

The web app has no `.env`: it reaches the API on 3100. One value is shared:
the runner's `CONSOLA_RUNNER_SECRET` is the API's `RUNNER_SECRET`. The
template is already built on Consola's account (`sandbox-template/README.md`
records its id); rebuild it only after changing the host's code or the
template.

Then, from the repository root:

1. `pnpm dev:cloud` (the API on 3100, the web app on
   `http://localhost:5175`). Sign in with Google and make a workspace. Its id
   is in `http://localhost:5175/api/workspaces`, opened in the signed-in
   browser: put it in the API's `RUNNER_WORKSPACE_ID`, with its other two
   RUNNER settings (all three or none, or the API refuses to start), and start
   `pnpm dev:cloud` again.
2. `pnpm exec turbo run build --filter=@consola/host^...` once, then
   `node --env-file=packages/host/.env packages/host/src/main.ts runner --cell-url ws://127.0.0.1:3100/api/runner --runner-id demo-runner`.
   Its log on stderr says `connected to the cell` once it is.
3. In the web app, open Sessions (`http://localhost:5175/#/sessions`), choose
   New session (`#/sessions/new`), and start a Claude session on the test
   repository. Its page says "Starting the sandbox…" until the runner reports
   the host ready, then shows the chat. Its sandbox is created with public
   ports, as every session sandbox is until a gateway stands in front
   (Linear: "10.5 A session gateway: sandboxes stay private, the browser
   reaches the host through Consola", https://linear.app/consola/issue/CON-105):
   anyone with the sandbox's address reaches every port it listens on, though
   the host's own still asks for a pass.

The check: ask the agent to add a line to the README and push a branch named
`consola/demo`, approving what it asks; the branch appears on GitHub. Close the
page, since a connected chat keeps the host from going idle. After 10 minutes,
reopening the session shows "This session has stopped.", and E2B's dashboard
lists no sandbox still running.

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
  (Linear CON-21). Local builds are fine. The host's bundle holds it ("The
  bundle and the session template"), so the bundle and the `consola-session`
  template stay in Consola's own E2B account.
- Fixtures and examples use Acme, Sprocket and the `sprocket` org, never real
  names.
