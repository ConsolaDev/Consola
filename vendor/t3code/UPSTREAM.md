# t3code, vendored

This folder holds packages copied from t3code, unchanged except where listed
under "Local changes". They keep t3's names, layout and toolchain (Effect 4,
`effect-tsgo`, Vite+), so a later re-sync is a diff rather than a port. It
also holds the files Consola lifted out of t3's server, once, at t3's own
`apps/server` path, and the thin packages that re-export them (see "Lifted by
Consola").

- Upstream: https://github.com/pingdotgg/t3code
- Commit: `d51d8c4766f6c8760d5db9428596b98c4f81eab1` (`d51d8c47`, 2026-11-21)
- Copied: 2026-11-22
- Licence: MIT. `LICENSE` is t3's, verbatim ("Copyright (c) 2026 T3 Tools Inc.").
  Every copied package is MIT; t3 leaves the `license` field unset, so each
  copied `package.json` gains `"license": "MIT"` (below).

## Copied packages

The closure of t3's packaged libraries: the sixteen below, plus every package
they name with a `workspace:` value in `dependencies` or `devDependencies`,
followed until no new package appeared (computed in the clone at `d51d8c47`).
Each directory is copied whole, at the same path it has in t3.

Asked for:

| Package | Path |
|---|---|
| `@t3tools/contracts` | `packages/contracts` |
| `@t3tools/shared` | `packages/shared` |
| `@t3tools/provider-core` | `packages/provider-core` |
| `@t3tools/client-runtime` | `packages/client-runtime` |
| `effect-acp` | `packages/effect-acp` |
| `effect-codex-app-server` | `packages/effect-codex-app-server` |
| `@t3tools/provider-acp` | `packages/provider-acp` |
| `@t3tools/provider-acp-registry` | `packages/provider-acp-registry` |
| `@t3tools/provider-opencode` | `packages/provider-opencode` |
| `@t3tools/provider-pi` | `packages/provider-pi` |
| `@t3tools/provider-cursor` | `packages/provider-cursor` |
| `@t3tools/provider-grok` | `packages/provider-grok` |
| `@t3tools/provider-kiro` | `packages/provider-kiro` |
| `@t3tools/provider-fx` | `packages/provider-fx` |
| `@t3tools/provider-muse` | `packages/provider-muse` |
| `@t3tools/provider-testing` | `packages/provider-testing` |

Pulled in by those (`workspace:` dependencies, transitively):

| Package | Path | First reached from |
|---|---|---|
| `@t3tools/issue-tracker-linear` | `packages/issue-tracker-linear` | `client-runtime` |
| `@t3tools/secret-provider-definitions` | `packages/secret-provider-definitions` | `client-runtime` |
| `@t3tools/secret-provider-core` | `packages/secret-provider-core` | `secret-provider-definitions` |
| `@t3tools/secret-provider-onepassword` | `packages/secret-provider-onepassword` | `secret-provider-definitions` |
| `@t3tools/source-control-core` | `packages/source-control-core` | `client-runtime` |
| `@t3tools/source-control-definitions` | `packages/source-control-definitions` | `client-runtime` |
| `@t3tools/source-control-azure-devops` | `packages/source-control-azure-devops` | `source-control-definitions` |
| `@t3tools/source-control-bitbucket` | `packages/source-control-bitbucket` | `source-control-definitions` |
| `@t3tools/source-control-cursor-origin` | `packages/source-control-cursor-origin` | `source-control-definitions` |
| `@t3tools/source-control-forgejo` | `packages/source-control-forgejo` | `source-control-definitions` |
| `@t3tools/source-control-gitcafe` | `packages/source-control-gitcafe` | `source-control-definitions` |
| `@t3tools/source-control-github` | `packages/source-control-github` | `source-control-definitions` |
| `@t3tools/source-control-gitlab` | `packages/source-control-gitlab` | `source-control-definitions` |
| `@t3tools/source-control-tanstack-source` | `packages/source-control-tanstack-source` | `source-control-definitions` |
| `@t3tools/source-control-testing` | `packages/source-control-testing` | `source-control-azure-devops` (devDependency) |

31 packages, 1497 files. No source file in them imports a t3 file outside this
set by a relative path.

Pulled in by the lifted server files (`apps/server`, below), which import
them and which none of the 31 needs:

| Package | Path | First reached from (a lifted file) |
|---|---|---|
| `@t3tools/ssh` | `packages/ssh` | `src/device/SshDeviceHost.ts` |
| `@t3tools/tailscale` | `packages/tailscale` | `src/policy/managedLimits.ts` |

Their own `workspace:` dependencies (`contracts`, `shared`) are already here.
33 copied packages in all.

## Copied root files

At the same relative paths, so `../../vite.config.ts` and
`../../tsconfig.base.json` resolve from each package exactly as in t3:

- `LICENSE`
- `tsconfig.base.json`, `tsconfig.effect.json`
- `vite.config.ts`, the test config most packages borrow
  (`vp test run --config ../../vite.config.ts --dir .`)
- `infra/task-cache/src/remoteCache.ts` and `scripts/lib/cached-tests.ts`,
  which `vite.config.ts` imports. Both import only Node built-ins. Neither
  needs a network service when the config loads: `remoteCacheUrl` reads
  `VP_REMOTE_CACHE_URL`, `.task-cache.json` and a credentials file under
  `~/.config/t3-task-cache`, and returns nothing when they are missing, so
  `vite.config.ts` is copied unchanged. `cachedTestTasks` returns nothing
  unless `T3_CACHED_TESTS` is set.

Not copied: t3's `.task-cache.json` (the endpoint of t3's own remote task
cache; without it Vite+ caches locally only), and the rest of `infra/` and
`scripts/`. `vite.config.ts` also names `./oxlint-plugin-t3code/index.ts`,
`@shadcn/lint` and `./apps/web/src` as strings, for `vp lint` and the web
app; nothing here loads them.

## Lifted by Consola

t3 has not moved its Claude and Codex adapters out of its server yet ("Drivers
not moved yet still live in provider/Drivers"). Consola lifts the server files
they need, and gives them entry packages shaped like `provider-pi`. The rules:

- **Each lifted server file lives once, at its upstream path:**
  `vendor/t3code/apps/server/` mirrors t3's `apps/server/` (`src/…`,
  `scripts/…`, `schema/…`), so every relative import resolves unchanged. Each
  file is copied byte for byte from `d51d8c47`.
- When a lifted file imports another server file, that file is lifted too,
  transitively. Nothing is stubbed or rewritten to avoid a copy. Imports of
  the copied packages (`@t3tools/*`, `effect-acp`, …) stay package imports. A
  later lift (Codex, the orchestration) adds what its closure lacks to the
  same tree; files already there are not copied again.
- `apps/server/` is one private workspace package named `t3`, the name t3
  gives it (copied packages keep their names), with a manifest of Consola's
  (below). It exposes its source as `t3/<path under src/>`. It stays
  `private`, so it is never published, and no Consola package depends on
  npm's `t3`.
- An entry package (`packages/provider-claude`, `provider-codex`,
  `server-orchestration`) holds only Consola's `package.json`, `tsconfig.json`,
  test selection (`vitest.config.ts`) and entry files, which re-export from `t3/…` under t3's names.

### `t3` (`apps/server`)

- `package.json` is Consola's: `version` `0.1.11` (t3's server version at
  `d51d8c47`; thirteen lifted files read `.version`, and nothing else, from
  `../package.json` or `../../package.json`, which is this file), `"license":
  "MIT"`, `"exports": { "./*": "./src/*" }`, `provider-pi`'s `typecheck` script, a
  `test` script that runs `vitest.config.ts` (below), and only the dependencies the lifted files import, each at
  the version t3's lockfile resolves for its `apps/server` importer
  (`@anthropic-ai/claude-agent-sdk` 0.3.321, `@effect/platform-node` and
  `-shared` 4.1.5, `@ff-labs/fff-node` 0.11.0, `@napi-rs/keyring` 1.3.0,
  `diff` 8.0.3, `effect` 4.1.5, `ffi-rs` 1.3.2, `proper-lockfile` 4.1.2,
  `stream-chain` 4.2.5, `stream-json` 3.7.0 (added by the host runtime lift,
  below), `yaml` 2.9.0, `yauzl` 3.4.0; dev: `@effect/vitest` 4.1.5, `@types/node`
  24.12.4, `@types/proper-lockfile` 4.1.4, `@types/yauzl` 3.4.0, `vite-plus`
  1.4.0), plus `workspace:*` for the copied packages. None of them moves what
  Consola's own packages (`.`, `apps/*`, `packages/*`) resolve to: their
  importers and every package they reach are the same as before the lift (900
  snapshots, compared entry by entry). t3's own server manifest lists far more
  (`node-pty`, `playwright-core`, `@cursor/sdk`, …); the lifted files import
  none of them.
- `tsconfig.json` is t3's, byte for byte. Because the package keeps t3's
  name, the lifted files' service keys (`"t3/provider/…"`) are the ones
  effect-tsgo's `deterministicKeys` rule expects (`<package name>/<path under
  src>`), as in t3. Under another name the same tsconfig fails with 135
  `deterministicKeys` errors.
- `vitest.config.ts` is Consola's: the shared `../../vite.config.ts` plus
  one `testNamePattern` that skips the tests listed in `NOT_RUN_HERE` (today
  one, see "The lifted server's tests"). The entry packages' test configs
  spread it.
- t3's `apps/server/vite.config.ts` is not copied: it does not load here. It
  imports `../../scripts/lib/public-config.ts`, `tagged-source-version.ts`,
  `cli-external-packages.ts` and `./src/testUtils/weightedShardSequencer.ts`,
  none of them here, and reads `engines.node` from the root `package.json`.
  Most of it is t3's executable packaging. Its test part runs the server's
  tests one file at a time (`fileParallelism: false`, against SQLite and git
  flakes under load), with two setup files and 120 s timeouts. The package's
  `test` uses the shared `../../vite.config.ts` (through `vitest.config.ts`)
  instead, as every copied package does; its setup files cover the same git and provider environment,
  and the tests pass with it.

### `@t3tools/provider-claude` (`packages/provider-claude`)

Claude's adapter, driver and replay testkit, re-exported.

| Export | Re-exports | From |
|---|---|---|
| `./server` | `ClaudeDriver`, `type ClaudeDriverEnv`; the module as `ClaudeAdapterV2` (as t3's server imports it); `CLAUDE_PROVIDER`, `createClaudeAdapterV2`, `type ClaudeAdapterV2DriverEnv` | `t3/provider/Drivers/ClaudeDriver.ts`, `t3/orchestration-v2/Adapters/ClaudeAdapterV2.ts` |
| `./settings` | `ClaudeSettings` | `@t3tools/contracts`, where t3 defines it |
| `./testing` | everything `ClaudeAdapterV2.testkit.ts` exports (`ClaudeOrchestratorReplayHarness`, `makeClaudeRestartReplayHarness`, `recordClaudeAgentSdkReplayTranscript`, the replay errors) | `t3/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts` |

No `./client`: t3 has no Claude client module. Claude's client entry is an
unnamed object inside `@t3tools/client-runtime`'s `providerClients` registry
(`packages/client-runtime/src/providerClients.ts`), read with
`getProviderClient("claudeAgent")`; a new `defineProviderClient` here would be
code t3 does not have.

Its `test` runs the Claude tests of the lifted tree with the server's own
Vitest:
`pnpm --dir ../../apps/server exec vp test run --config ../../packages/provider-claude/vitest.config.ts --dir .`.
That config is the shared `../../vite.config.ts` with one `include`,
`src/**/{Claude,claude}*.test.ts`, a glob on the path under `apps/server/`:
every Claude test file's name starts with `Claude` or `claude`, and no other
file is matched (Codex's or the orchestration's tests, once lifted, are not),
wherever the checkout lives. (It replaced a positional filter, `claude`,
which Vitest matches as a lower-cased substring of each path under `--dir`: it
selected the same 16 files, but would also take any later test with `claude`
anywhere in its path.) CI does not run it (see "Consola's side"). `tsconfig.json` is `provider-pi`'s with t3's server `lib`,
since its typecheck also checks the server files its entries reach; under
the name `t3` those files pass the Effect checks unchanged here too.

What each entry reaches matters to anything that bundles it. `./server` reaches
67 lifted files and, among native or vendor code, the Claude Agent SDK,
`ffi-rs` (through `src/policy/ManagedPolicy.ts`) and only the `client`
subpaths of the other providers, so not the Cursor SDK. `./testing` reaches
the whole Claude closure below, `@t3tools/provider-cursor/server` (and with it
`@cursor/sdk`) included, and is for tests only. The table under `server-orchestration`, "What each entry
reaches", lists every entry of the three entry packages.

### `@t3tools/provider-codex` (`packages/provider-codex`)

Codex's adapter, driver and replay testkit, re-exported. A thin entry package
like `provider-claude`: `package.json`, `tsconfig.json`, `vitest.config.ts`
and three entry files that only re-export from `t3/…`.

| Export | Re-exports | From |
|---|---|---|
| `./server` | `CodexDriver`, `type CodexDriverEnv`; the module as `CodexAdapterV2` (as t3's server imports it); `CODEX_DRIVER_KIND`, `createCodexAdapterV2`, `type CodexAdapterV2DriverEnv` | `t3/provider/Drivers/CodexDriver.ts`, `t3/orchestration-v2/Adapters/CodexAdapterV2.ts` |
| `./settings` | `CodexSettings` | `@t3tools/contracts`, where t3 defines it |
| `./testing` | everything `CodexAdapterV2.testkit.ts` exports (`CodexOrchestratorReplayHarness`, `withCodexReplayChildMetadata`, `layer`, the replay errors) | `t3/orchestration-v2/Adapters/CodexAdapterV2.testkit.ts` |

No `./client`, for the reason `provider-claude` has none: t3 has no Codex
client module (Codex's client is an object in `@t3tools/client-runtime`'s
`providerClients` registry). t3 does not export a `CODEX_PROVIDER` constant
(`CodexAdapterV2.ts` keeps it module-private); `CODEX_DRIVER_KIND`, which is
that value, is exported instead.

Its `test` runs the Codex tests of the lifted tree with the server's own
Vitest, as `provider-claude`'s does, with `include`
`src/**/{Codex,codex}*.test.ts`: the 20 test files whose names start with
`Codex` or `codex`, and no other (Claude's glob, `{Claude,claude}*`, selects
none of them, and its 16 files are unchanged). The config spreads the
server's `vitest.config.ts`, so the test that is not run here is skipped in
both. CI needs no edit: it runs every lifted test once, in `t3`, and leaves out
the packages that depend on `t3` (`--filter "!...^t3"`), which includes this one.

What each entry reaches matters to anything that bundles it. `./server`
reaches 211 lifted files and, among native or vendor code, only `ffi-rs`
(through `src/policy/ManagedPolicy.ts`) and the `client` and `server/driver`
subpaths of the other providers and source-control packages: neither the
Claude Agent SDK nor the Cursor SDK. `./testing` reaches the whole lifted
tree's testkit (the same one `provider-claude`'s does, Cursor SDK included) and
is for tests only.

### `@t3tools/server-orchestration` (`packages/server-orchestration`)

t3's event ingestion, run-lifecycle services, projection reducers and shared
replay testkit, re-exported. A thin entry package like `provider-codex`:
`package.json`, `tsconfig.json`, `vitest.config.ts` and three entry files that
only re-export from `t3/…` (and, for one reducer, from the copied
`@t3tools/client-runtime`). Every module is exported as a namespace, as t3's
server imports it (`import * as X from "./X.ts"`), so the `layer`, `make` and
errors of one do not collide with another's.

| Export | Re-exports | From |
|---|---|---|
| `./server` | `ProviderEventIngestor` (turns `ProviderAdapterV2Event`s into `OrchestrationV2DomainEvent`s: `ProviderEventIngestorV2`, `layer`, `ProviderEventIngestInput`), `ProviderCommitBatch` (`make`, `enabled`, `CommitBatchError`), `RunExecutionService` (`RunExecutionServiceV2`, `layer`, `routeProviderEvent`, `makeInterruptResultTurnItem`, …), `ProviderSessionManager` (`ProviderSessionManagerV2`, `layer`, `layerWithOptions`, …), `EventSink`, `EventStore`, `ProjectionStore` (the services the ingestion needs); `makeAssistantStreamingFilter`, `splitBufferedAssistantText` | `t3/orchestration-v2/{ProviderEventIngestor,ProviderCommitBatch,RunExecutionService,ProviderSessionManager,EventSink,EventStore,ProjectionStore,assistantStreaming}.ts` |
| `./projection` | `applyToProjection`, `emptyProjection`, `ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION` (the server's reducer); `applyOrchestrationV2ProjectionEvent`, `getProjectionArrayReplacementIndex`, `type ApplyOrchestrationV2ProjectionEventOptions` (the reducer clients apply to what the wire sends) | `t3/orchestration-v2/ProjectionStore.ts`; `@t3tools/client-runtime/state/orchestration-v2-projection` |
| `./testing` | everything `OrchestratorScenario.ts` exports (`runOrchestratorV2Scenario`, the step types and error); namespaces `ProviderReplayHarness`, `ProviderReplayFixtures`, `ProjectionReplay`, `ReplayFixtureShared` (`fixtures/shared.ts`: the prompts, model selections, policies and `assert*` helpers the scenarios use); `ORCHESTRATOR_REPLAY_FIXTURES` | `t3/orchestration-v2/testkit/…` |

**Where the reducers live.** t3 has two. The server's is `applyToProjection`
(with `emptyProjection`), defined in `ProjectionStore.ts` but not called by it
or by `EventSink.ts`: `ProjectionStoreV2` writes its SQL rows itself when
`EventSinkV2` hands it events. The function is applied in memory by
`Orchestrator.ts` (not in an entry of this package), which folds events into a
whole `OrchestrationV2ThreadProjection` (`emptyProjection` at line 1939,
`applyToProjection` at lines 1947, 7304, 7336, 7360 and 7416; its only
non-test callers). It is a plain function, but its file also holds the SQLite
layer, so importing it loads `effect/sql`. The reducer clients apply to what
the wire sends is `applyOrchestrationV2ProjectionEvent` in
`@t3tools/client-runtime` (already copied). `./projection` exports both.

**What the ingestion needs from persistence** (the host's thread runtime must
provide in-memory versions; nothing here builds them), read from the
`yield*`s of each layer:

- `ProviderEventIngestor.layer` (`ProviderEventIngestor.ts` lines 252-261)
  requires `EventSinkV2`, `GitVcsDriver`, `IdAllocatorV2`, `ProjectionStoreV2`,
  `ThreadCommandExecutor` and `ProviderInstanceRegistry`; it also reads
  `ProviderTurnAnalytics`, `AgentScope` and `UsageLimitResetFallback`
  (references with defaults).
- `EventSinkV2.layer` (`EventSink.ts` lines 286-293) requires `SqlClient`,
  `ThreadViewers`, `CommandReceiptStoreV2`, `EffectOutboxV2`, `EventStoreV2`,
  `ProjectionStoreV2`, `ProjectStoreV2` and `TurnItemPositionStoreV2`.
  The ingestor's output goes through its `write`, `writeWithEffects`,
  `writeIfRunCurrent`, `withProviderBatch` and `consumeProviderEvents`
  (batched by `ProviderCommitBatch`); the ingestor reads current state back
  through `ProjectionStoreV2` (the control reads its `ProjectionStoreV2Shape`
  lists).
- `EventStoreV2` holds the stored events (append, read, a sequence, publish
  after commit); the other stores beneath `EventSinkV2` are SQLite-backed
  (`persistence/…`). `RunExecutionService` and `ProviderSessionManager` sit
  above these, plus the adapter registry.

An in-memory host therefore replaces `EventStoreV2` and `ProjectionStoreV2`
(the two that own the data), and either fakes the other stores beneath
`EventSinkV2` or runs t3's own layers over an in-memory `SqlClient`
(`node:sqlite` `:memory:` works here: the tests do exactly that).

**What each entry reaches** (does a bundle of it contain `@cursor/sdk`?).
Derived by a transitive import walk, not by reasoning: a breadth-first
walk from each entry file over every `import`, `export … from` (with `export *
as` namespaces) and `new URL(…, import.meta.url)`, resolving relative paths,
`t3/…` and each vendored package's own `exports` map (type-only imports count,
so it over-approximates), and recording any file that imports `@cursor/sdk`.
The walker was a throwaway script (TypeScript's `preProcessFile` plus a regex
for `export … from`), not committed; a file's count is its reachable files in
the lifted tree and the copied packages.

| Package | Entry | Reaches `@cursor/sdk`? | Through |
|---|---|---|---|
| `provider-claude` | `./server` (414 files) | no | the Claude Agent SDK, `ffi-rs`, and only the other providers' `client` subpaths |
| `provider-claude` | `./settings` (81) | no | |
| `provider-claude` | `./testing` (972) | yes, 19 files import it | `ClaudeAdapterV2.testkit.ts` → `testkit/ProviderReplayHarness.ts` → `ThreadManagementService.ts` → `workspace/restoreMissingWorktree.ts` → `terminal/Manager.ts` → `provider/ProviderInstanceRegistryHydration.ts` → `provider/ProviderOrchestrationAdapterInfrastructure.ts` → `@t3tools/provider-cursor/server/CursorAgentSdk` (and `CursorAgentSdkProcessRunner`); also `provider/builtInDrivers.ts` → `provider-cursor/server` |
| `provider-codex` | `./server` (567) | no | `ffi-rs`, the `client` and `server/driver` subpaths of other providers |
| `provider-codex` | `./settings` (81) | no | |
| `provider-codex` | `./testing` (973) | yes, 19 files | the same chain, from `CodexAdapterV2.testkit.ts` |
| `server-orchestration` | `./projection` (280) | no | |
| `server-orchestration` | `./server` (904) | yes, 19 files | `RunExecutionService.ts` → `RunFinalizationService.ts` → `vcs/VcsStatusBroadcaster.ts` → `git/GitWorkflowService.ts` → `git/GitManager.ts` → `project/ProjectSetupScriptRunner.ts` → `terminal/Manager.ts` → `provider/ProviderInstanceRegistryHydration.ts` → `provider/ProviderOrchestrationAdapterInfrastructure.ts` → `provider-cursor/server/CursorAgentSdk` and `CursorAgentSdkProcessRunner` |
| `server-orchestration` | `./testing` (1,253) | yes, 19 files | the same chain, from `ProviderReplayHarness.ts` |

Walked one level down, from the modules `./server` re-exports (each its own
start): `ProviderCommitBatch.ts` (1 file), `assistantStreaming.ts` (83),
`EventStore.ts` (85), `ProjectionStore.ts` (276), `EventSink.ts` (292),
`ProviderEventIngestor.ts` (489) and `ProviderSessionManager.ts` (650) reach no
`@cursor/sdk`; `RunExecutionService.ts` (903) does, through
`RunFinalizationService.ts` as above. (`ProviderInstanceRegistryHydration.ts`
itself reaches it through `ProviderOrchestrationAdapterInfrastructure.ts` and
`builtInDrivers.ts`.) So a bundle that must not contain the Cursor SDK can
take: `provider-claude`'s `./server` and `./settings`, `provider-codex`'s
`./server` and `./settings`, `server-orchestration`'s `./projection`, and,
by deep path rather than the `./server` barrel (`t3/orchestration-v2/<file>.ts`,
with a bundler that follows imports exactly), `ProviderEventIngestor`,
`ProviderCommitBatch`, `ProviderSessionManager`, `EventSink`, `EventStore`,
`ProjectionStore` and `assistantStreaming`. It cannot take
`server-orchestration`'s `./server` barrel (because of `RunExecutionService`),
nor any `./testing`. A barrel that omits `RunExecutionService` would need a new
entry file in Consola's own package, a later task's call.

**Replay scenarios** are under `testkit/fixtures/<scenario>/` (`input.ts`, and
per driver `<driver>_output.ts` and `<driver>_transcript.ndjson`). All 94
scenario folders are lifted. These have a Claude transcript (35):
`claude_background_monitor_wake`, `claude_background_subagent_after_root`,
`claude_background_subagent_lifecycle`, `claude_background_task_after_root`,
`claude_background_task_interrupt`, `claude_background_task_wake`,
`claude_background_wake_before_queued_prompt`,
`claude_background_wake_before_queued_prompt_no_echo`,
`claude_compact_after_peer_turn`, `claude_compact_after_peer_turn_no_echo`,
`claude_compact_after_resume_wake`, `claude_idle_resume`,
`claude_local_bash_task`, `claude_mcp_tool_presentation`,
`claude_nested_background_subagent_wake`, `claude_nested_subagent_model`,
`claude_result_is_error`, `command_output_streaming`, `message_steering`,
`multi_turn`, `multi_turn_restart`, `queued_turn`, `simple`, `subagent`,
`thread_rollback`, `tool_call_denied_write`, `tool_call_read_only`,
`tool_call_read_only_on_request`, `tool_call_restricted_granular`,
`tool_call_workspace_never`, `turn_interrupt`, `turn_interrupt_mid_tool`,
`turn_interrupt_restart`, `usage_limit`, `web_search`. These have a Codex
transcript (24): `codex_model_reroute`, `command_output_streaming`,
`message_steering`, `multi_turn`, `plan_questions`, `proposed_plan`,
`queued_turn`, `simple`, `subagent`, `subagent_continue`, `subagent_v2`,
`subagent_v2_approval`, `subagent_v2_nested`, `subagent_v2_nested_approval`,
`thread_rollback`, `thread_rollback_after_restart`,
`thread_rollback_to_stopped_turn`, `todo_list`,
`tool_call_read_only_on_request`, `tool_call_restricted_granular`,
`tool_call_workspace_never`, `turn_interrupt`, `turn_interrupt_mid_tool`,
`web_search`. `fixtures/index.ts` (`ORCHESTRATOR_REPLAY_FIXTURES`) lists them
all, for every driver; only Claude's and Codex's transcripts are lifted.

Its `test` runs the ingestion and projection tests of the lifted tree with the
server's own Vitest, as the other entry packages' do. Its `include` names the
15 files one by one, since their names share no prefix:
`orchestration-v2/{EventSink,ProjectionControlReads,ProjectionMaintenance,ProjectionRecovery,ProjectionSettlement,ProjectionStore,ProviderCommitBatch,ProviderEventIngestor,ProviderSessionManager,RunExecutionService,SubagentProjection,ThreadLiveEventCoalescer,WireProjection}.test.ts`,
`orchestration-v2/assistantStreaming.test.ts` and
`orchestration-v2/testkit/ProviderReplayHarness.test.ts`. The three entry
packages' selections are disjoint (checked with `vp test list --filesOnly`: no
file is in two) and together they are all 51 test files of the lifted tree, so
none is in no selection. CI needs no edit: it runs every lifted test once, in
`t3`, and leaves out the packages that depend on `t3`.

### What is lifted, and why

Seeds, as the Claude lift asked for them (paths under `src/`):

- `orchestration-v2/Adapters/`: `ClaudeAdapterV2.ts`, its tests
  (`ClaudeAdapterV2.test.ts`, `ClaudeAgentSdkQueryRunner.test.ts`),
  `ClaudeAdapterV2.testkit.ts`, `ClaudeTaskOutputTail.ts` (+ test),
  `ProviderTextDeltaCoalescer.ts`, `claudeWorkflowProgress.ts` (+ test)
- `provider/Drivers/Claude*.ts` (`ClaudeDriver`, `ClaudeExecutable`,
  `ClaudeHome`, `ClaudeMaintenance`, `ClaudeSkillDispatch`, `ClaudeSkills`,
  with their tests)
- `provider/Claude*.ts` (`ClaudeCapabilitiesProbe.test`,
  `ClaudeCodeModelRoutes`, `ClaudeModelCatalog`,
  `ClaudeModelCatalog.testFixtures`, `ClaudeModelManifest`, `ClaudeProvider`,
  `ClaudeTurnTokenUsage`, with their tests)
- `provider/claudeUsageLimits.ts`, `provider/claudeResetCredits.ts` (+ tests)
- `claudeModelOptions.ts` (+ test), `claudeHistoryWorker.ts`,
  `claude-history-worker.ts` (the script `ClaudeAdapterV2.ts` runs by path,
  `new URL("../../claude-history-worker.ts", import.meta.url)`)
- `orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts`, the
  test that runs Claude's replay fixtures through the testkit

And one for a copied package's tests: `cli/sshHelper.ts`.
`packages/ssh/src/launcherTestHarness.ts` runs
`<t3 root>/apps/server/src/cli/sshHelper.ts`, a path it builds from its own
location, so without it two `ssh` tests fail on every OS. Its closure is
otherwise inside the Claude one.

From the seeds, every relative `import`, `export … from` and `import()` (read
with TypeScript's own import scanner, so nothing in a comment counts), every
`new URL("<relative path>", import.meta.url)` and every `vi.mock("<relative
path>")` was followed until no new file appeared. Data files: the 35
`claude_transcript.ndjson` replay transcripts `fixtures/index.ts` names for
`claudeAgent`. The other drivers' transcripts it names are not copied (no
lifted test reads them), nor the five Claude transcripts only t3's other
orchestrator tests read (`claude_subagent_resume_after_restart`,
`thread_fork_native`, `thread_fork_native_fork_local_rollback`,
`thread_fork_native_prior_turn`, `thread_merge_back_siblings`).

756 files: 721 source files (258,087 lines) and 35 transcripts (2,318 lines).
By directory:

| Files | Lines | Directory |
|---:|---:|---|
| 250 | 15,330 | `src/orchestration-v2/testkit/fixtures` (215 scenario `input.ts`/`output.ts`, 35 transcripts) |
| 126 | 6,574 | `src/persistence` (SQLite and its migrations) |
| 91 | 120,081 | `src/orchestration-v2` (the rest: OrchestratorV2, its services, adapters, testkit) |
| 89 | 29,818 | `src/provider` |
| 24 | 6,638 | `src/*.ts` |
| 20 | 7,623 | `src/mcp` |
| 18 | 8,249 | `src/device` |
| 14 | 13,364 | `src/vcs` |
| 11 | 4,308 | `src/project` |
| 10 | 5,125 | `src/workspace` |
| 8 | 4,020 | `src/cloud` |
| 8 | 2,037 | `src/textGeneration` |
| 7 | 1,373 | `src/sourceControl` |
| 6 | 3,196 | `src/scheduledTasks` |
| 5 each | | `src/git`, `src/peer`, `src/policy`, `src/preview`, `src/pullRequest` |
| 1–4 each | | `src/resourceTelemetry`, `secrets`, `telemetry`, `auth`, `checkpointing`, `environment`, `htmlRender`, `process`, `usage`, `background`, `desktopUpdate`, `mcpApps`, `observability`, `scheduling`, `terminal`, `assets`, `cli` (2), `speech`, `utils`; `scripts/dev-replay-agent.ts`, `schema/expo.graphql.ts` |

The Claude adapter and driver alone reach 67 of these files. The rest comes
through the tests and the testkit, and a few imports pull in most of it:

- `ClaudeAdapterV2.testkit.ts` → `orchestration-v2/testkit/ProviderReplayHarness.ts`,
  which builds t3's whole OrchestratorV2 over SQLite: `persistence/Sqlite.ts`
  with every migration, `Orchestrator`, `EffectWorker`, the checkpoint, run,
  thread and provider services, the MCP session registry, VCS and git. 448
  files hang off this one import. Through it, too:
  `EffectWorker.ts` → `ResourceCleanupService.ts` → `device/DeviceService.ts`
  (Expo, EAS and SSH device hosts, hence `@t3tools/ssh` and
  `schema/expo.graphql.ts`), and `RunFinalizationService.ts` →
  `workspace/WorkspaceEntries.ts` → `WorkspaceSearchIndex.ts`
  (`@ff-labs/fff-node`).
- `ClaudeAdapterV2.test.ts` → `mcp/toolkits/project/tools.ts` →
  `ThreadLaunchService.ts` → `terminal/Manager.ts` →
  `provider/ProviderInstanceRegistryHydration.ts`, which reaches
  `provider/builtInDrivers.ts` (every built-in driver: Codex with
  `CodexAdapterV2.ts`, Antigravity, and the packaged providers' `server`
  entries) and `scripts/dev-replay-agent.ts`.
- `ClaudeAdapterV2.ts` → `serverSettings.ts` → `policy/ManagedPolicy.ts`
  (`ffi-rs`) → `policy/managedLimits.ts` (`@t3tools/tailscale`).
- `ClaudeReplayFixtures.integration.test.ts` → `testkit/fixtures/index.ts`,
  which imports every replay scenario's `input.ts` and `output.ts`, for every
  driver.

Every lifted file is byte-identical to `d51d8c47` (checked by comparing each
one with the clone). The paths, relative to `apps/server/`:

<details>
<summary>All 827 lifted paths</summary>

```
schema/expo.graphql.ts
scripts/dev-replay-agent.ts
src/assets/MediaFile.ts
src/attachmentPaths.ts
src/attachmentStore.ts
src/auth/ServerSecretStore.ts
src/auth/serverInternalPaths.ts
src/auth/utils.ts
src/background/BackgroundPolicy.ts
src/background/HostPowerMonitor.ts
src/checkpointing/CheckpointStore.ts
src/checkpointing/Diffs.ts
src/checkpointing/Errors.ts
src/claude-history-worker.ts
src/claudeHistoryWorker.ts
src/claudeModelOptions.test.ts
src/claudeModelOptions.ts
src/cli/invocation.ts
src/cli/sshHelper.ts
src/cloud/bootService.ts
src/cloud/config.ts
src/cloud/pinnedRuntime.ts
src/cloud/selfUpdate.ts
src/cloud/serviceLauncherClient.ts
src/cloud/servicePreflight.ts
src/cloud/serviceProtocol.ts
src/cloud/serviceSelectionLock.ts
src/codexModelOptions.test.ts
src/codexModelOptions.ts
src/config.ts
src/desktopUpdate/DesktopAppUpdate.ts
src/desktopUpdate/DesktopUpdateMarker.ts
src/device/AgentDeviceShim.ts
src/device/AgentDeviceTarget.ts
src/device/DeviceActions.ts
src/device/DeviceHost.ts
src/device/DeviceHubOperations.ts
src/device/DeviceService.ts
src/device/DeviceToolchain.ts
src/device/EasDeviceHost.ts
src/device/ExpoApi.graphql.ts
src/device/ExpoApi.ts
src/device/LocalDeviceHost.ts
src/device/SimlockDeviceHost.ts
src/device/SshDeviceHost.ts
src/device/deviceToolMaintenance.ts
src/device/deviceToolVersions.json
src/device/easProjectId.ts
src/device/localSshDeviceHost.ts
src/device/sshDeviceScript.ts
src/environment/ServerEnvironment.ts
src/environment/ServerEnvironmentLabel.ts
src/environment/ServerEnvironmentMachine.ts
src/environmentTheme.ts
src/git/GitManager.ts
src/git/GitWorkflowService.ts
src/git/detachStackFrame.ts
src/git/linkCreatedPullRequest.ts
src/git/remoteRefs.ts
src/htmlRender/HtmlRender.ts
src/htmlRender/headlessChrome.ts
src/htmlRender/publicProxy.ts
src/imageMime.ts
src/legacyServerOwner.ts
src/mcp/McpInvocationContext.ts
src/mcp/McpSessionRegistry.testkit.ts
src/mcp/McpSessionRegistry.ts
src/mcp/OrchestratorMcpService.ts
src/mcp/PreviewAutomationBroker.ts
src/mcp/ThreadMetadataMcpService.ts
src/mcp/WorktreeMcpService.ts
src/mcp/delegatedTaskModes.ts
src/mcp/linkOrigin.ts
src/mcp/threadAccess.ts
src/mcp/toolkits/attachment/input.ts
src/mcp/toolkits/environment/tools.ts
src/mcp/toolkits/html/tools.ts
src/mcp/toolkits/message/tools.ts
src/mcp/toolkits/orchestrator/tools.ts
src/mcp/toolkits/previewControls/tools.ts
src/mcp/toolkits/project/tools.ts
src/mcp/toolkits/theme/tools.ts
src/mcp/toolkits/thread/tools.ts
src/mcp/toolkits/worktree/tools.ts
src/mcpApps/McpAppModelContext.ts
src/mcpApps/McpAppSnapshot.ts
src/noCopyOnWrite.ts
src/observability/Attributes.ts
src/observability/Metrics.ts
src/orchestration-v2/Adapters/AntigravityAdapterV2.ts
src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts
src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.test.ts
src/orchestration-v2/Adapters/ClaudeTaskOutputTail.test.ts
src/orchestration-v2/Adapters/ClaudeTaskOutputTail.ts
src/orchestration-v2/Adapters/CodexAdapterV2.test.ts
src/orchestration-v2/Adapters/CodexAdapterV2.testkit.ts
src/orchestration-v2/Adapters/CodexAdapterV2.ts
src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts
src/orchestration-v2/Adapters/claudeWorkflowProgress.test.ts
src/orchestration-v2/Adapters/claudeWorkflowProgress.ts
src/orchestration-v2/CheckpointCaptureService.ts
src/orchestration-v2/CheckpointRestoreSafety.ts
src/orchestration-v2/CheckpointRollbackService.ts
src/orchestration-v2/CheckpointService.ts
src/orchestration-v2/CommandOutputHub.ts
src/orchestration-v2/CommandPolicy.ts
src/orchestration-v2/CommandReceiptStore.ts
src/orchestration-v2/ContextHandoffDelivery.ts
src/orchestration-v2/ContextHandoffService.ts
src/orchestration-v2/DispatchModeLimit.ts
src/orchestration-v2/EffectOutbox.ts
src/orchestration-v2/EffectWorker.ts
src/orchestration-v2/EventSink.test.ts
src/orchestration-v2/EventSink.ts
src/orchestration-v2/EventStore.ts
src/orchestration-v2/GuestShareDecider.ts
src/orchestration-v2/LiveStreamBudget.ts
src/orchestration-v2/NotificationMailbox.ts
src/orchestration-v2/Orchestrator.ts
src/orchestration-v2/ProjectCommands.ts
src/orchestration-v2/ProjectStore.ts
src/orchestration-v2/ProjectionControlReads.test.ts
src/orchestration-v2/ProjectionMaintenance.test.ts
src/orchestration-v2/ProjectionMaintenance.ts
src/orchestration-v2/ProjectionRecovery.test.ts
src/orchestration-v2/ProjectionSettlement.test.ts
src/orchestration-v2/ProjectionStore.test.ts
src/orchestration-v2/ProjectionStore.ts
src/orchestration-v2/ProviderAdapterRegistry.ts
src/orchestration-v2/ProviderCommitBatch.test.ts
src/orchestration-v2/ProviderCommitBatch.ts
src/orchestration-v2/ProviderContinuationService.ts
src/orchestration-v2/ProviderEventIngestor.test.ts
src/orchestration-v2/ProviderEventIngestor.ts
src/orchestration-v2/ProviderRuntimeRecoveryService.ts
src/orchestration-v2/ProviderSessionManager.test.ts
src/orchestration-v2/ProviderSessionManager.ts
src/orchestration-v2/ProviderSessionTransitionPolicy.ts
src/orchestration-v2/ProviderSwitchService.ts
src/orchestration-v2/ProviderTurnControlService.ts
src/orchestration-v2/ProviderTurnStartService.testkit.ts
src/orchestration-v2/ProviderTurnStartService.ts
src/orchestration-v2/PullRequestSyncReactor.ts
src/orchestration-v2/QueuedRunOrder.ts
src/orchestration-v2/ResourceCleanupService.ts
src/orchestration-v2/RestartBackgroundNote.ts
src/orchestration-v2/RestartContinuation.ts
src/orchestration-v2/RunExecutionService.test.ts
src/orchestration-v2/RunExecutionService.ts
src/orchestration-v2/RunFinalizationService.ts
src/orchestration-v2/RunMetrics.ts
src/orchestration-v2/RuntimePolicy.ts
src/orchestration-v2/RuntimeRequestService.ts
src/orchestration-v2/ShellStream.ts
src/orchestration-v2/SubagentProjection.test.ts
src/orchestration-v2/ThreadCommandExecutor.ts
src/orchestration-v2/ThreadDeletion.ts
src/orchestration-v2/ThreadFind.ts
src/orchestration-v2/ThreadForkService.ts
src/orchestration-v2/ThreadLaunchService.ts
src/orchestration-v2/ThreadLiveEventCoalescer.test.ts
src/orchestration-v2/ThreadLiveEventCoalescer.ts
src/orchestration-v2/ThreadManagementService.ts
src/orchestration-v2/ThreadSearch.ts
src/orchestration-v2/ThreadSettlementService.ts
src/orchestration-v2/ThreadStream.ts
src/orchestration-v2/ThreadTitleRegenerationService.ts
src/orchestration-v2/ThreadViewers.ts
src/orchestration-v2/TurnItemPositionStore.ts
src/orchestration-v2/UsageLimitRecoveryWorker.ts
src/orchestration-v2/UserFacingErrors.ts
src/orchestration-v2/WireProjection.test.ts
src/orchestration-v2/WireProjection.ts
src/orchestration-v2/assistantStreaming.test.ts
src/orchestration-v2/assistantStreaming.ts
src/orchestration-v2/contextBoundary.ts
src/orchestration-v2/deferredCommandMessage.ts
src/orchestration-v2/delegatedTaskMessage.ts
src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts
src/orchestration-v2/messageSearchIndex.ts
src/orchestration-v2/modelSwitch.ts
src/orchestration-v2/noPullRequestRechecks.ts
src/orchestration-v2/placeholderThreadTitle.ts
src/orchestration-v2/pullRequestWatch.ts
src/orchestration-v2/runOutput.ts
src/orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts
src/orchestration-v2/testkit/CodexReplayFixtures.integration.test.ts
src/orchestration-v2/testkit/CommandOutputRecorder.ts
src/orchestration-v2/testkit/DeterministicRuntime.ts
src/orchestration-v2/testkit/OrchestratorScenario.ts
src/orchestration-v2/testkit/ProjectionReplay.ts
src/orchestration-v2/testkit/ProviderReplayFixtures.ts
src/orchestration-v2/testkit/ProviderReplayHarness.test.ts
src/orchestration-v2/testkit/ProviderReplayHarness.ts
src/orchestration-v2/testkit/ReplayRuntimeInstructions.ts
src/orchestration-v2/testkit/fixtures/acp_titled_multiselect/input.ts
src/orchestration-v2/testkit/fixtures/acp_titled_multiselect/output.ts
src/orchestration-v2/testkit/fixtures/claude_background_monitor_wake/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_background_monitor_wake/input.ts
src/orchestration-v2/testkit/fixtures/claude_background_monitor_wake/output.ts
src/orchestration-v2/testkit/fixtures/claude_background_subagent_after_root/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_background_subagent_after_root/input.ts
src/orchestration-v2/testkit/fixtures/claude_background_subagent_after_root/output.ts
src/orchestration-v2/testkit/fixtures/claude_background_subagent_lifecycle/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_background_subagent_lifecycle/input.ts
src/orchestration-v2/testkit/fixtures/claude_background_subagent_lifecycle/output.ts
src/orchestration-v2/testkit/fixtures/claude_background_task_after_root/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_background_task_after_root/input.ts
src/orchestration-v2/testkit/fixtures/claude_background_task_after_root/output.ts
src/orchestration-v2/testkit/fixtures/claude_background_task_interrupt/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_background_task_interrupt/input.ts
src/orchestration-v2/testkit/fixtures/claude_background_task_interrupt/output.ts
src/orchestration-v2/testkit/fixtures/claude_background_task_wake/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_background_task_wake/input.ts
src/orchestration-v2/testkit/fixtures/claude_background_task_wake/output.ts
src/orchestration-v2/testkit/fixtures/claude_background_wake_before_queued_prompt/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_background_wake_before_queued_prompt/input.ts
src/orchestration-v2/testkit/fixtures/claude_background_wake_before_queued_prompt/output.ts
src/orchestration-v2/testkit/fixtures/claude_background_wake_before_queued_prompt_no_echo/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_background_wake_before_queued_prompt_no_echo/input.ts
src/orchestration-v2/testkit/fixtures/claude_background_wake_before_queued_prompt_no_echo/output.ts
src/orchestration-v2/testkit/fixtures/claude_compact_after_peer_turn/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_compact_after_peer_turn/input.ts
src/orchestration-v2/testkit/fixtures/claude_compact_after_peer_turn/output.ts
src/orchestration-v2/testkit/fixtures/claude_compact_after_peer_turn_no_echo/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_compact_after_peer_turn_no_echo/output.ts
src/orchestration-v2/testkit/fixtures/claude_compact_after_resume_wake/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_compact_after_resume_wake/input.ts
src/orchestration-v2/testkit/fixtures/claude_compact_after_resume_wake/output.ts
src/orchestration-v2/testkit/fixtures/claude_idle_resume/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_idle_resume/input.ts
src/orchestration-v2/testkit/fixtures/claude_idle_resume/output.ts
src/orchestration-v2/testkit/fixtures/claude_local_bash_task/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_local_bash_task/input.ts
src/orchestration-v2/testkit/fixtures/claude_local_bash_task/output.ts
src/orchestration-v2/testkit/fixtures/claude_mcp_tool_presentation/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_mcp_tool_presentation/input.ts
src/orchestration-v2/testkit/fixtures/claude_mcp_tool_presentation/output.ts
src/orchestration-v2/testkit/fixtures/claude_nested_background_subagent_wake/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_nested_background_subagent_wake/input.ts
src/orchestration-v2/testkit/fixtures/claude_nested_background_subagent_wake/output.ts
src/orchestration-v2/testkit/fixtures/claude_nested_subagent_model/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_nested_subagent_model/input.ts
src/orchestration-v2/testkit/fixtures/claude_nested_subagent_model/output.ts
src/orchestration-v2/testkit/fixtures/claude_result_is_error/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/claude_result_is_error/input.ts
src/orchestration-v2/testkit/fixtures/claude_result_is_error/output.ts
src/orchestration-v2/testkit/fixtures/codex_model_reroute/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/codex_model_reroute/output.ts
src/orchestration-v2/testkit/fixtures/command_output_streaming/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/command_output_streaming/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/command_output_streaming/input.ts
src/orchestration-v2/testkit/fixtures/command_output_streaming/output.ts
src/orchestration-v2/testkit/fixtures/fx_early_stop/fx_output.ts
src/orchestration-v2/testkit/fixtures/fx_early_stop/input.ts
src/orchestration-v2/testkit/fixtures/fx_subagent/fx_output.ts
src/orchestration-v2/testkit/fixtures/fx_subagent/input.ts
src/orchestration-v2/testkit/fixtures/fx_subagent_stop/fx_output.ts
src/orchestration-v2/testkit/fixtures/fx_subagent_stop/input.ts
src/orchestration-v2/testkit/fixtures/grok_auto_blocked_command/input.ts
src/orchestration-v2/testkit/fixtures/grok_auto_blocked_command/output.ts
src/orchestration-v2/testkit/fixtures/grok_background_bash/input.ts
src/orchestration-v2/testkit/fixtures/grok_background_bash/output.ts
src/orchestration-v2/testkit/fixtures/grok_background_bash_fast_wake/input.ts
src/orchestration-v2/testkit/fixtures/grok_background_bash_fast_wake/output.ts
src/orchestration-v2/testkit/fixtures/grok_background_subagent/input.ts
src/orchestration-v2/testkit/fixtures/grok_background_subagent/output.ts
src/orchestration-v2/testkit/fixtures/grok_monitor/input.ts
src/orchestration-v2/testkit/fixtures/grok_monitor/output.ts
src/orchestration-v2/testkit/fixtures/grok_prompt_error/input.ts
src/orchestration-v2/testkit/fixtures/grok_prompt_error/output.ts
src/orchestration-v2/testkit/fixtures/grok_subagent_lineage/input.ts
src/orchestration-v2/testkit/fixtures/grok_subagent_lineage/output.ts
src/orchestration-v2/testkit/fixtures/index.ts
src/orchestration-v2/testkit/fixtures/kiro_compaction/input.ts
src/orchestration-v2/testkit/fixtures/kiro_compaction/output.ts
src/orchestration-v2/testkit/fixtures/kiro_effort/input.ts
src/orchestration-v2/testkit/fixtures/kiro_effort/output.ts
src/orchestration-v2/testkit/fixtures/kiro_fork_from_turn/input.ts
src/orchestration-v2/testkit/fixtures/kiro_fork_from_turn/output.ts
src/orchestration-v2/testkit/fixtures/kiro_message_steering/input.ts
src/orchestration-v2/testkit/fixtures/kiro_message_steering/output.ts
src/orchestration-v2/testkit/fixtures/kiro_model_switch/input.ts
src/orchestration-v2/testkit/fixtures/kiro_model_switch/output.ts
src/orchestration-v2/testkit/fixtures/kiro_permission_modes/input.ts
src/orchestration-v2/testkit/fixtures/kiro_permission_modes/output.ts
src/orchestration-v2/testkit/fixtures/kiro_subagent_interrupt/input.ts
src/orchestration-v2/testkit/fixtures/kiro_subagent_interrupt/output.ts
src/orchestration-v2/testkit/fixtures/malformed_session_update/input.ts
src/orchestration-v2/testkit/fixtures/malformed_session_update/output.ts
src/orchestration-v2/testkit/fixtures/message_steering/claude_output.ts
src/orchestration-v2/testkit/fixtures/message_steering/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/message_steering/codex_output.ts
src/orchestration-v2/testkit/fixtures/message_steering/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/message_steering/cursor_output.ts
src/orchestration-v2/testkit/fixtures/message_steering/grok_output.ts
src/orchestration-v2/testkit/fixtures/message_steering/input.ts
src/orchestration-v2/testkit/fixtures/message_steering/pi_output.ts
src/orchestration-v2/testkit/fixtures/multi_turn/claude_output.ts
src/orchestration-v2/testkit/fixtures/multi_turn/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/multi_turn/codex_output.ts
src/orchestration-v2/testkit/fixtures/multi_turn/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/multi_turn/input.ts
src/orchestration-v2/testkit/fixtures/multi_turn/muse_output.ts
src/orchestration-v2/testkit/fixtures/multi_turn/pi_output.ts
src/orchestration-v2/testkit/fixtures/multi_turn_restart/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/muse_permission/input.ts
src/orchestration-v2/testkit/fixtures/muse_permission/output.ts
src/orchestration-v2/testkit/fixtures/muse_subagent_approval/input.ts
src/orchestration-v2/testkit/fixtures/muse_subagent_approval/output.ts
src/orchestration-v2/testkit/fixtures/muse_subagent_interrupt/input.ts
src/orchestration-v2/testkit/fixtures/muse_subagent_interrupt/output.ts
src/orchestration-v2/testkit/fixtures/muse_workflow/input.ts
src/orchestration-v2/testkit/fixtures/muse_workflow/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_background/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_background/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_command/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_command/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_compaction/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_compaction/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_inbox/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_inbox/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_interrupt/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_interrupt/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_missing_step_usage/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_nested_background/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_nested_background/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_permission/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_permission/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_question/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_question/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_resume_after_restart/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_resume_after_restart/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_revert/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_revert/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_simple/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_simple/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_skill/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_skill/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_subagent/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_subagent/output.ts
src/orchestration-v2/testkit/fixtures/opencode2_tool_call/input.ts
src/orchestration-v2/testkit/fixtures/opencode2_tool_call/output.ts
src/orchestration-v2/testkit/fixtures/opencode_background_wake/input.ts
src/orchestration-v2/testkit/fixtures/opencode_background_wake/output.ts
src/orchestration-v2/testkit/fixtures/opencode_child_approval/input.ts
src/orchestration-v2/testkit/fixtures/opencode_child_approval/output.ts
src/orchestration-v2/testkit/fixtures/opencode_running_child_approval/input.ts
src/orchestration-v2/testkit/fixtures/opencode_running_child_approval/output.ts
src/orchestration-v2/testkit/fixtures/opencode_subagent/input.ts
src/orchestration-v2/testkit/fixtures/opencode_subagent/output.ts
src/orchestration-v2/testkit/fixtures/pi_compaction/input.ts
src/orchestration-v2/testkit/fixtures/pi_compaction/output.ts
src/orchestration-v2/testkit/fixtures/plan_questions/codex_output.ts
src/orchestration-v2/testkit/fixtures/plan_questions/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/plan_questions/input.ts
src/orchestration-v2/testkit/fixtures/plan_questions/opencode_output.ts
src/orchestration-v2/testkit/fixtures/proposed_plan/codex_output.ts
src/orchestration-v2/testkit/fixtures/proposed_plan/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/proposed_plan/cursor_output.ts
src/orchestration-v2/testkit/fixtures/proposed_plan/input.ts
src/orchestration-v2/testkit/fixtures/provider_thread_resume/input.ts
src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_output.ts
src/orchestration-v2/testkit/fixtures/queued_cancelled_while_active/codex_output.ts
src/orchestration-v2/testkit/fixtures/queued_cancelled_while_active/input.ts
src/orchestration-v2/testkit/fixtures/queued_turn/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/queued_turn/codex_output.ts
src/orchestration-v2/testkit/fixtures/queued_turn/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/queued_turn/input.ts
src/orchestration-v2/testkit/fixtures/shared.ts
src/orchestration-v2/testkit/fixtures/simple/claude_output.ts
src/orchestration-v2/testkit/fixtures/simple/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/simple/codex_output.ts
src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/simple/input.ts
src/orchestration-v2/testkit/fixtures/simple/pi_output.ts
src/orchestration-v2/testkit/fixtures/skill_invocation/cursor_output.ts
src/orchestration-v2/testkit/fixtures/skill_invocation/input.ts
src/orchestration-v2/testkit/fixtures/stop_background_work_after_failed_turn/input.ts
src/orchestration-v2/testkit/fixtures/stop_background_work_after_failed_turn/output.ts
src/orchestration-v2/testkit/fixtures/subagent/claude_output.ts
src/orchestration-v2/testkit/fixtures/subagent/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/subagent/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/subagent/cursor_output.ts
src/orchestration-v2/testkit/fixtures/subagent/input.ts
src/orchestration-v2/testkit/fixtures/subagent/kiro_output.ts
src/orchestration-v2/testkit/fixtures/subagent_continue/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_continue/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/subagent_continue/input.ts
src/orchestration-v2/testkit/fixtures/subagent_v2/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/subagent_v2/input.ts
src/orchestration-v2/testkit/fixtures/subagent_v2/muse_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_approval/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_approval/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/subagent_v2_approval/input.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_nested/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_nested/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/subagent_v2_nested_approval/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_nested_approval/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/subagent_v2_nested_approval/input.ts
src/orchestration-v2/testkit/fixtures/thread_rollback/claude_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/thread_rollback/codex_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/thread_rollback/input.ts
src/orchestration-v2/testkit/fixtures/thread_rollback/pi_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_after_restart/codex_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_after_restart/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/thread_rollback_after_restart/input.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/input.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_to_stopped_turn/codex_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_to_stopped_turn/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/thread_rollback_to_stopped_turn/input.ts
src/orchestration-v2/testkit/fixtures/todo_list/codex_output.ts
src/orchestration-v2/testkit/fixtures/todo_list/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/todo_list/cursor_output.ts
src/orchestration-v2/testkit/fixtures/todo_list/grok_output.ts
src/orchestration-v2/testkit/fixtures/todo_list/input.ts
src/orchestration-v2/testkit/fixtures/tool_call_denied_write/claude_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_denied_write/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_denied_write/fx_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_denied_write/input.ts
src/orchestration-v2/testkit/fixtures/tool_call_read_only/claude_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_read_only/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_read_only/cursor_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_read_only/input.ts
src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/fx_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/input.ts
src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/output.ts
src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/claude_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/codex_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/input.ts
src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/claude_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/codex_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/input.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt/claude_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/turn_interrupt/codex_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/turn_interrupt/input.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt/muse_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/claude_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/codex_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/cursor_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/fx_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/input.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/kiro_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/pi_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_restart/claude_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_restart/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/turn_interrupt_restart/input.ts
src/orchestration-v2/testkit/fixtures/usage_limit/claude_output.ts
src/orchestration-v2/testkit/fixtures/usage_limit/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/web_search/claude_output.ts
src/orchestration-v2/testkit/fixtures/web_search/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/web_search/codex_output.ts
src/orchestration-v2/testkit/fixtures/web_search/codex_transcript.ndjson
src/orchestration-v2/testkit/fixtures/web_search/input.ts
src/orchestration-v2/threadHistoryPaging.ts
src/orchestration-v2/toolOutputImageBytes.ts
src/orchestration-v2/unknownField.ts
src/orchestration-v2/workflowAgentAnswers.ts
src/orchestration-v2/workflowAgentTranscript.ts
src/orchestration-v2/workflowFileRead.ts
src/os-jank.ts
src/peer/PeerForwarding.ts
src/peer/PeerLinkRequests.ts
src/peer/PeerLinks.ts
src/peer/PeerMcpClient.ts
src/peer/RemoteDelegation.ts
src/persistence/Errors.ts
src/persistence/Migrations.ts
src/persistence/Migrations/001_OrchestrationEvents.ts
src/persistence/Migrations/002_OrchestrationCommandReceipts.ts
src/persistence/Migrations/003_CheckpointDiffBlobs.ts
src/persistence/Migrations/004_ProviderSessionRuntime.ts
src/persistence/Migrations/005_Projections.ts
src/persistence/Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts
src/persistence/Migrations/007_ProjectionThreadMessageAttachments.ts
src/persistence/Migrations/008_ProjectionThreadActivitySequence.ts
src/persistence/Migrations/009_ProviderSessionRuntimeMode.ts
src/persistence/Migrations/010_ProjectionThreadsRuntimeMode.ts
src/persistence/Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts
src/persistence/Migrations/012_ProjectionThreadsInteractionMode.ts
src/persistence/Migrations/013_ProjectionThreadProposedPlans.ts
src/persistence/Migrations/014_ProjectionThreadProposedPlanImplementation.ts
src/persistence/Migrations/015_ProjectionTurnsSourceProposedPlan.ts
src/persistence/Migrations/016_CanonicalizeModelSelections.ts
src/persistence/Migrations/017_ProjectionThreadsArchivedAt.ts
src/persistence/Migrations/018_ProjectionThreadsArchivedAtIndex.ts
src/persistence/Migrations/019_ProjectionSnapshotLookupIndexes.ts
src/persistence/Migrations/020_AuthAccessManagement.ts
src/persistence/Migrations/021_AuthSessionClientMetadata.ts
src/persistence/Migrations/022_AuthSessionLastConnectedAt.ts
src/persistence/Migrations/023_ProjectionThreadShellSummary.ts
src/persistence/Migrations/024_BackfillProjectionThreadShellSummary.ts
src/persistence/Migrations/025_CleanupInvalidProjectionPendingApprovals.ts
src/persistence/Migrations/026_CanonicalizeModelSelectionOptions.ts
src/persistence/Migrations/027_ProviderSessionRuntimeInstanceId.ts
src/persistence/Migrations/028_ProjectionThreadSessionInstanceId.ts
src/persistence/Migrations/029_ProjectionThreadDetailOrderingIndexes.ts
src/persistence/Migrations/030_ProjectionThreadShellArchiveIndexes.ts
src/persistence/Migrations/031_AuthAuthorizationScopes.ts
src/persistence/Migrations/032_AuthPairingProofKeyThumbprint.ts
src/persistence/Migrations/033_ProjectionThreadsSettled.ts
src/persistence/Migrations/034_ProjectionThreadsSnoozed.ts
src/persistence/Migrations/035_ProjectionThreadTitleRegeneration.ts
src/persistence/Migrations/036_ProjectionThreadsPinned.ts
src/persistence/Migrations/037_ProjectionTurnsKeysetIndex.ts
src/persistence/Migrations/038_ProjectionThreadsPinOrderKey.ts
src/persistence/Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts
src/persistence/Migrations/040_ProjectionProjectFaviconPath.ts
src/persistence/Migrations/041_AuthSessionClientConnection.ts
src/persistence/Migrations/042_ProjectionThreadLinkedPullRequest.ts
src/persistence/Migrations/043_ProjectionThreadsUnsettledAt.ts
src/persistence/Migrations/044_ClearAutomaticProjectModelDefaults.ts
src/persistence/Migrations/045_ProjectionProjectsAutoPull.ts
src/persistence/Migrations/046_RepairAutomaticSettlementTimestamps.ts
src/persistence/Migrations/047_ProjectionProjectIcon.ts
src/persistence/Migrations/048_ProjectionThreadBranchPullRequest.ts
src/persistence/Migrations/049_ProjectionThreadsActiveOrderKey.ts
src/persistence/Migrations/050_ProjectionThreadPullRequests.ts
src/persistence/Migrations/051_ProjectionThreadMessageContext.ts
src/persistence/Migrations/052_ProjectionThreadTitleState.ts
src/persistence/Migrations/053_PullRequestFilesViewed.ts
src/persistence/Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts
src/persistence/Migrations/055_OrchestrationV2.ts
src/persistence/Migrations/056_RemoveRedundantProjectionIndexes.ts
src/persistence/Migrations/057_ScheduledTaskWebhooks.ts
src/persistence/Migrations/058_WebhookRelayDeliveries.ts
src/persistence/Migrations/059_McpAppModelContext.ts
src/persistence/Migrations/060_ThreadSnapshotWindowIndexes.ts
src/persistence/Migrations/061_PullRequestReviewGuides.ts
src/persistence/Migrations/062_ThreadFailureLookupIndex.ts
src/persistence/Migrations/063_DropUnusedV1Projections.ts
src/persistence/Migrations/064_CanonicalizeThreadPullRequestLinks.ts
src/persistence/Migrations/065_CodexUsageNativeTurnIndex.ts
src/persistence/Migrations/066_RepairClientSettlementTimestamps.ts
src/persistence/Migrations/067_WebhookDedupe.ts
src/persistence/Migrations/068_ShellStopRequestIndex.ts
src/persistence/Migrations/069_ThreadMessageSearch.ts
src/persistence/Migrations/070_PeerLinks.ts
src/persistence/Migrations/071_PeerLinkFence.ts
src/persistence/Migrations/072_WaitingLinkRequestIndex.ts
src/persistence/Migrations/073_ActiveTurnItemIndexes.ts
src/persistence/Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts
src/persistence/Migrations/075_SubagentDeliveryState.ts
src/persistence/Migrations/076_ProjectionProjectsPinArchive.ts
src/persistence/Migrations/077_RepairBooleanSettledOverride.ts
src/persistence/Migrations/078_DropOrchestrationEventCorrelationIndex.ts
src/persistence/Migrations/079_DelegatedRecoveryIndexes.ts
src/persistence/Migrations/080_ScheduledTaskThreadMode.ts
src/persistence/Migrations/081_ProjectionMessageSearchText.ts
src/persistence/Migrations/082_TurnItemConversationIndex.ts
src/persistence/Migrations/083_CommandReadIndexes.ts
src/persistence/Migrations/084_LastExecutedRunIndex.ts
src/persistence/Migrations/085_TurnItemCounts.ts
src/persistence/Migrations/086_QueuedTurnInputIndex.ts
src/persistence/Migrations/087_ProjectionProjectsCustomTitle.ts
src/persistence/Migrations/088_TurnItemTypeStatusIndex.ts
src/persistence/Migrations/089_ShellThreadReadIndexes.ts
src/persistence/Migrations/090_AuthConnectDevices.ts
src/persistence/Migrations/091_AuthConnectDeniedRequests.ts
src/persistence/Migrations/092_QueuedTurnInputIndexJsonValid.ts
src/persistence/Migrations/093_ProviderTurnAttemptIndex.ts
src/persistence/Migrations/094_TurnItemMessageOrdinalIndex.ts
src/persistence/Migrations/095_TurnItemInlineWorkOutput.ts
src/persistence/Migrations/096_RepairStaleTitleRegeneration.ts
src/persistence/Migrations/097_IssueTrackerBindings.ts
src/persistence/Migrations/098_ActiveShellIndexIndexes.ts
src/persistence/Migrations/099_BackgroundRecoveryIndexes.ts
src/persistence/Migrations/100_TurnStartReadIndexes.ts
src/persistence/Migrations/101_DelegatedTaskReadIndexes.ts
src/persistence/Migrations/102_ThreadItemCounts.ts
src/persistence/Migrations/103_IssueTrackerAdditionalScopes.ts
src/persistence/Migrations/104_ProjectionProjectsTrackedFolders.ts
src/persistence/Migrations/105_TaskFolders.ts
src/persistence/Migrations/OrchestrationV2/ApplicationEventSequenceIndexes.ts
src/persistence/Migrations/OrchestrationV2/ApplicationEventSource.ts
src/persistence/Migrations/OrchestrationV2/EffectCancellation.ts
src/persistence/Migrations/OrchestrationV2/Foundation.ts
src/persistence/Migrations/OrchestrationV2/LegacyV1ImportState.ts
src/persistence/Migrations/OrchestrationV2/ProviderSessionBindings.ts
src/persistence/Migrations/OrchestrationV2/RecoveryIndexes.ts
src/persistence/Migrations/OrchestrationV2/ScheduledTasks.ts
src/persistence/Migrations/OrchestrationV2/ShellIndexes.ts
src/persistence/Migrations/OrchestrationV2/Subagents.ts
src/persistence/Migrations/OrchestrationV2/ThreadLaunchWorkflows.ts
src/persistence/Migrations/legacyThreadPullRequestKey.ts
src/persistence/OrchestrationCommandReceipts.ts
src/persistence/OrchestrationEventStore.ts
src/persistence/PullRequestFilesViewed.ts
src/persistence/Sqlite.ts
src/persistence/databaseMigrationHead.ts
src/persistence/initializeV2Database.ts
src/persistence/reconcileV2PreviewMigration.ts
src/persistence/testkit/SqliteRouting.ts
src/policy/ManagedPolicy.ts
src/policy/managedLimits.ts
src/policy/managedProviders.ts
src/policy/managedSettings.ts
src/policy/managedUpdates.ts
src/preview/Manager.ts
src/preview/PortScanner.ts
src/preview/PreviewAgentActivity.ts
src/preview/PreviewBrowser.ts
src/preview/PreviewBrowserHost.ts
src/process/SpawnWorker.ts
src/process/providerProcesses.ts
src/process/windowsTcpListeners.ts
src/processRunner.ts
src/project/ManagedProjectFolders.ts
src/project/ProjectCloneTracker.ts
src/project/ProjectEnrichmentService.ts
src/project/ProjectFaviconResolver.ts
src/project/ProjectService.ts
src/project/ProjectSetupScriptRunner.ts
src/project/RepositoryIdentityResolver.ts
src/project/T3ProjectFileLoader.ts
src/project/WorktreeSetupTracker.ts
src/project/gitCloneProgress.ts
src/project/worktreeContainer.ts
src/provider/AntigravityAuth.ts
src/provider/AntigravityInstallation.ts
src/provider/AntigravityProvider.ts
src/provider/ClaudeCapabilitiesProbe.test.ts
src/provider/ClaudeCodeModelRoutes.test.ts
src/provider/ClaudeCodeModelRoutes.ts
src/provider/ClaudeModelCatalog.test.ts
src/provider/ClaudeModelCatalog.testFixtures.ts
src/provider/ClaudeModelCatalog.ts
src/provider/ClaudeModelManifest.ts
src/provider/ClaudeProvider.ts
src/provider/ClaudeTurnTokenUsage.ts
src/provider/CodexAuthCallbackPage.ts
src/provider/CodexChatGptAuth.test.ts
src/provider/CodexChatGptAuth.ts
src/provider/CodexChatGptHandoff.ts
src/provider/CodexChatGptModels.test.ts
src/provider/CodexChatGptModels.ts
src/provider/CodexChatGptSessionLock.test.ts
src/provider/CodexChatGptSessionLock.ts
src/provider/CodexDeveloperInstructions.test.ts
src/provider/CodexDeveloperInstructions.ts
src/provider/CodexInstallation.test.ts
src/provider/CodexInstallation.ts
src/provider/CodexManagedErrors.test.ts
src/provider/CodexManagedErrors.ts
src/provider/CodexManagedHome.ts
src/provider/CodexManagedRuntime.test.ts
src/provider/CodexManagedRuntime.ts
src/provider/CodexManagedTokenBroker.ts
src/provider/CodexManagedTokenProtocol.ts
src/provider/CodexMcpElicitation.test.ts
src/provider/CodexMcpElicitation.ts
src/provider/CodexProvider.test.ts
src/provider/CodexProvider.ts
src/provider/CodexThreadRevert.test.ts
src/provider/CodexThreadRevert.ts
src/provider/CodexToolPresentation.ts
src/provider/CodexTurnTokenUsage.ts
src/provider/DocumentText.ts
src/provider/Drivers/AntigravityDriver.ts
src/provider/Drivers/AntigravitySkills.ts
src/provider/Drivers/AntigravityUsage.ts
src/provider/Drivers/ClaudeDriver.ts
src/provider/Drivers/ClaudeExecutable.test.ts
src/provider/Drivers/ClaudeExecutable.ts
src/provider/Drivers/ClaudeHome.test.ts
src/provider/Drivers/ClaudeHome.ts
src/provider/Drivers/ClaudeMaintenance.test.ts
src/provider/Drivers/ClaudeMaintenance.ts
src/provider/Drivers/ClaudeSkillDispatch.test.ts
src/provider/Drivers/ClaudeSkillDispatch.ts
src/provider/Drivers/ClaudeSkills.test.ts
src/provider/Drivers/ClaudeSkills.ts
src/provider/Drivers/CodexDriver.test.ts
src/provider/Drivers/CodexDriver.ts
src/provider/Drivers/CodexHomeLayout.test.ts
src/provider/Drivers/CodexHomeLayout.ts
src/provider/Drivers/CodexManagedProvider.ts
src/provider/Drivers/antigravityUsageReader.ts
src/provider/Drivers/claudeUsage.ts
src/provider/Drivers/codexUsage.test.ts
src/provider/Drivers/codexUsage.ts
src/provider/Errors.ts
src/provider/EventNdjsonLogger.ts
src/provider/ModelManifest.ts
src/provider/ProjectSettingsOverrideSweep.ts
src/provider/ProviderAuthService.ts
src/provider/ProviderCredentialStore.ts
src/provider/ProviderHostLive.ts
src/provider/ProviderInstallationGate.ts
src/provider/ProviderInstanceRegistry.ts
src/provider/ProviderInstanceRegistryHydration.ts
src/provider/ProviderInstanceRegistryMutator.ts
src/provider/ProviderOrchestrationAdapterInfrastructure.ts
src/provider/ProviderRegistry.ts
src/provider/acp/AntigravityAcpSupport.ts
src/provider/acp/AntigravityChildWork.ts
src/provider/acp/AntigravityClientFiles.ts
src/provider/acp/AntigravityEditLocation.ts
src/provider/acp/AntigravityProfilePaths.ts
src/provider/acp/AntigravityProtocol.ts
src/provider/acp/AntigravitySessionFiles.ts
src/provider/acp/AntigravityTurnOutcome.ts
src/provider/antigravityAuthSupport.ts
src/provider/antigravityCallback.ts
src/provider/antigravityCliRelease.ts
src/provider/antigravityUsageLimits.ts
src/provider/builtInDrivers.ts
src/provider/builtInProviderCatalog.ts
src/provider/claudeResetCredits.test.ts
src/provider/claudeResetCredits.ts
src/provider/claudeUsageLimits.test.ts
src/provider/claudeUsageLimits.ts
src/provider/codexLaunchArgs.test.ts
src/provider/codexLaunchArgs.ts
src/provider/codexModelCatalog.test.ts
src/provider/codexModelCatalog.ts
src/provider/codexUsageLimits.test.ts
src/provider/codexUsageLimits.ts
src/provider/managedRelease.ts
src/provider/model-manifest.json
src/provider/providerCompatibility.ts
src/provider/providerStatusCache.ts
src/provider/resetCreditCoordinator.ts
src/provider/testFixtures/codexCollabMockPeer.mjs
src/provider/testFixtures/codexCollabMockPeer.sh
src/provider/testFixtures/codexMultiAgentWire.json
src/provider/unavailableProviderSnapshot.ts
src/pullRequest/PullRequestProviderRegistry.ts
src/pullRequest/PullRequestReadCache.ts
src/pullRequest/PullRequestService.ts
src/pullRequest/pullRequestChangeBreakdown.ts
src/pullRequest/pullRequestViewedFiles.ts
src/resourceTelemetry/DesktopTelemetryReceiver.ts
src/resourceTelemetry/NativeTelemetryClient.ts
src/resourceTelemetry/ResourceAttribution.ts
src/resourceTelemetry/ResourceMonitorBinary.ts
src/scheduledTasks/Schedule.ts
src/scheduledTasks/ScheduledTaskService.ts
src/scheduledTasks/webhookDedupe.ts
src/scheduledTasks/webhookFilter.ts
src/scheduledTasks/webhookTemplate.ts
src/scheduledTasks/webhookVerification.ts
src/scheduling/DueHint.ts
src/scheduling/Scheduler.ts
src/secrets/SecretRequests.ts
src/secrets/SecretResolver.ts
src/secrets/secretProviderDefinitions.ts
src/secrets/settingsSecretValue.ts
src/serverActivation.ts
src/serverLifecycleEvents.ts
src/serverOwnership.ts
src/serverRuntimeState.ts
src/serverSettings.ts
src/serviceLauncher.ts
src/settingsSecrets.ts
src/sourceControl/ServerSourceControlHost.ts
src/sourceControl/SourceControlProviderRegistry.ts
src/sourceControl/SourceControlRepositoryService.ts
src/sourceControl/builtInDrivers.ts
src/sourceControl/sourceControlDefinitions.ts
src/sourceControl/sourceControlHostSecrets.ts
src/sourceControl/threadPullRequests.ts
src/speech/platform.ts
src/telemetry/AnalyticsService.ts
src/telemetry/Identify.ts
src/telemetry/ProviderDimensions.ts
src/telemetry/ProviderUsageAnalytics.ts
src/terminal/Manager.ts
src/terminal/OutputProtocol.ts
src/testUtils/processProbe.ts
src/textGeneration/AntigravityTextGeneration.ts
src/textGeneration/ClaudeTextGeneration.ts
src/textGeneration/CodexTextGeneration.test.ts
src/textGeneration/CodexTextGeneration.ts
src/textGeneration/TextGeneration.ts
src/textGeneration/TextGenerationPresets.ts
src/textGeneration/TextGenerators.ts
src/textGeneration/ThreadTitleLinks.ts
src/textGeneration/textGeneratorDrivers.ts
src/usage/CodexUsageHistory.ts
src/usage/UsageLimitSources.ts
src/usage/cliproxyApi.ts
src/utils/subscribeBeforeSnapshot.ts
src/vcs/CheckoutCloner.ts
src/vcs/GitVcsDriver.ts
src/vcs/GitVcsDriverCore.ts
src/vcs/VcsAutomaticFetchInterval.ts
src/vcs/VcsDriver.ts
src/vcs/VcsDriverRegistry.ts
src/vcs/VcsProcess.ts
src/vcs/VcsProjectConfig.ts
src/vcs/VcsStatusBroadcaster.ts
src/vcs/checkpointUntrackedBlobs.ts
src/vcs/gitIndexStat.ts
src/vcs/removeEmptyDirectory.ts
src/vcs/worktreeCheckoutCache.ts
src/vcs/worktreeRemoval.ts
src/watchDirectoryReplacements.ts
src/workspace/IgnorePatterns.ts
src/workspace/KnownWorkspaces.ts
src/workspace/TaskFolderStore.ts
src/workspace/TaskFolders.ts
src/workspace/WorkspaceEntries.ts
src/workspace/WorkspaceFolders.ts
src/workspace/WorkspacePaths.ts
src/workspace/WorkspaceSearchIndex.ts
src/workspace/restoreMissingWorktree.ts
src/workspace/workspaceLease.ts
src/worktreesDirectory.ts
src/zipArchive.ts
```

</details>

### The Codex lift

Same method and tree as Claude's; only files the tree lacked were copied, 50
(26 source files and 24 transcripts), each byte for byte from `d51d8c47`.
Everything else the Codex closure reaches (the orchestrator, persistence, the
other drivers' fixtures' scenario code, and Codex's own `CodexDriver.ts`,
`CodexAdapterV2.ts`, `CodexProvider.ts`, `codexLaunchArgs.ts`,
`codexUsageLimits.ts`, `codexModelCatalog.ts`, `codexModelOptions.ts`, the
`codex_output.ts` fixtures and the rest) was already there, pulled in by the
Claude closure. The `./server` closure (`CodexDriver.ts` and
`CodexAdapterV2.ts`) is 211 files, all already lifted.

Seeds (paths under `src/`): every file whose name starts with `Codex` or
`codex` under `src/` (75 files, with the `codex_output.ts` scenario
outputs), `orchestration-v2/testkit/fixtures/index.ts`, and the Codex
fixtures it names; not `scripts/record-codex-app-server-replay-fixture.ts`,
`scripts/codexReplayRecordingRecords.ts` or the migration
`persistence/Migrations/065_CodexUsageNativeTurnIndex.ts` (already lifted),
which no test imports. The copied source files:

- Tests (20): `codexModelOptions.test.ts`; in `orchestration-v2/`
  `Adapters/CodexAdapterV2.test.ts` and
  `testkit/CodexReplayFixtures.integration.test.ts`; in `provider/`
  `CodexChatGptAuth`, `CodexChatGptModels`, `CodexChatGptSessionLock`,
  `CodexDeveloperInstructions`, `CodexInstallation`, `CodexManagedErrors`,
  `CodexManagedRuntime`, `CodexMcpElicitation`, `CodexProvider`,
  `CodexThreadRevert`, `codexLaunchArgs`, `codexModelCatalog`,
  `codexUsageLimits`; in `provider/Drivers/` `CodexDriver`,
  `CodexHomeLayout`, `codexUsage`; `textGeneration/CodexTextGeneration.test.ts`.
- `orchestration-v2/Adapters/CodexAdapterV2.testkit.ts` (the `./testing`
  entry), `provider/CodexChatGptHandoff.ts` (imported by
  `CodexChatGptAuth.test.ts`), `testUtils/processProbe.ts` (imported by
  `CodexAdapterV2.test.ts`), and the three fixtures
  `provider/testFixtures/codexCollabMockPeer.mjs`, `.sh` and
  `codexMultiAgentWire.json`, which the tests run by path.
- 24 `codex_transcript.ndjson` under `orchestration-v2/testkit/fixtures/`:
  every one `fixtures/index.ts` names for the `codex` driver. The other
  drivers' transcripts it names, and the transcripts only t3's other
  orchestrator tests read, are not copied (no lifted test reads them).

The closure added no dependency: every package the 26 files import
(`effect`, `@effect/vitest`, `yaml`, `diff`, `proper-lockfile`, `ffi-rs`,
the copied packages, `effect-codex-app-server` among them) was already in
`apps/server/package.json`. The lifted tree is now 806 files (827 after the orchestration lift, below).

### The orchestration lift

Same method and tree. `ProviderEventIngestor.ts`, `ProviderCommitBatch.ts`,
`RunExecutionService.ts`, `ProviderSessionManager.ts`, `assistantStreaming.ts`,
`EventSink.ts`, `EventStore.ts`, `ProjectionStore.ts` (the server's reducer)
and the testkit (`ProviderReplayHarness.ts`, `OrchestratorScenario.ts`,
`ProviderReplayFixtures.ts`, `fixtures/`) were already there, in the Claude
closure. The seeds were their tests and the other ingestion and projection
tests; the 21 files the tree lacked (all source, no transcript or other data
file) were copied, each byte for byte from `d51d8c47`:

- Tests (15), in `orchestration-v2/`: `EventSink`, `ProjectionControlReads`,
  `ProjectionMaintenance`, `ProjectionRecovery`, `ProjectionSettlement`,
  `ProjectionStore`, `ProviderCommitBatch`, `ProviderEventIngestor`,
  `ProviderSessionManager`, `RunExecutionService`, `SubagentProjection`,
  `ThreadLiveEventCoalescer`, `WireProjection` and `assistantStreaming`
  (`.test.ts`), and `testkit/ProviderReplayHarness.test.ts`.
- Imported by them (6): `orchestration-v2/ProjectionMaintenance.ts`,
  `ThreadLiveEventCoalescer.ts`, `ThreadStream.ts`,
  `UsageLimitRecoveryWorker.ts`, `testkit/ProjectionReplay.ts` (the testkit's
  projection verifier, exported by `./testing`) and
  `persistence/testkit/SqliteRouting.ts`.

The closure added no dependency (every package imported was already in
`apps/server/package.json`), and Consola's own packages' lockfile entries are
unchanged: the only `pnpm-lock.yaml` change is the new
`vendor/t3code/packages/server-orchestration` importer. The lifted tree is now
827 files.

### The host runtime lift

For `@consola/host`'s thread runtime (Task 6), which composes t3's production
orchestration (`orchestration-v2/runtimeLayer.ts`) the way t3's `server.ts`
does. Same method and tree. Seed: `src/orchestration-v2/runtimeLayer.ts`. Its
closure of relative imports is 458 files at `d51d8c47`; the tree lacked 15,
all source, each copied byte for byte (compared with `cmp` after copying):

- `orchestration-v2/runtimeLayer.ts`, `orchestration-v2/WorktreeBranchSync.ts`
- `guest/GuestShareService.ts`, `guest/guestAttachments.ts`, `guest/guestView.ts`
- `mcpApps/McpAppRequests.ts`, `mcpApps/McpSignIn.ts`
- `persistence/ProviderSessionRuntime.ts`
- `project/AgentSessionImporter.ts`, `project/AgentSessionJson.ts`,
  `project/AgentSessionScanner.ts`, `project/ScratchThreadPromotion.ts`
- `auth/PayloadSigner.ts`, `cloud/ManagedEndpointRuntime.ts`,
  `cloud/RelayClientLedger.ts`

None of them is `src/bin.ts`, `server.ts`, `ws.ts` or an `http*` module.
`project/AgentSessionJson.ts` imports `stream-chain` and `stream-json`, which
the lifted server did not need before; both join `apps/server/package.json`
at the versions t3's lockfile resolves for its `apps/server` importer
(`stream-chain` 4.2.5, `stream-json` 3.7.0). The only `pnpm-lock.yaml` change
is those two entries under the `t3` importer and their two packages; Consola's
own packages resolve as before. The lifted tree is now 842 files.

### The host RPC server lift

For `@consola/host`'s WebSocket server (Task 7), which serves a slice of t3's
`WsRpcGroup` with Effect's RPC server, as t3's `ws.ts` does. `ws.ts` itself is
not lifted (it is t3's whole RPC server, reaching its HTTP server and product
services); the host writes its own handlers and reuses the helpers `ws.ts`
calls for them. Every one of those was already in the tree but one, copied byte
for byte (compared with `cmp` after copying):

- `rpcInitialItems.ts`: the initial items of a subscription (a snapshot, a
  replay) as a stream that releases them once delivered. It imports only
  `effect`.

The helpers already here that the host's handlers call:
`orchestration-v2/WireProjection.ts` (`projectThreadProjectionForWire`,
`threadStreamEventItem`, `makeLiveBodyDeduper`),
`orchestration-v2/ThreadLiveEventCoalescer.ts`,
`orchestration-v2/ThreadStream.ts` (`decideThreadResume`),
`orchestration-v2/ThreadManagementService.ts` (`withCreationProvenance`),
`terminal/OutputProtocol.ts` (`withOutputWindow`) and `serverSettings.ts`
(`redactServerSettingsForClient`). The lifted tree is now 843 files.

### Known runtime gaps

Paths the lifted code builds only at run time, which no import names, are not
followed. Three of them are code, and what needs them does not work here:

- **Text extraction from document attachments** (`__document-text`):
  `src/provider/DocumentText.ts`, which `ClaudeAdapterV2.ts` imports, starts
  t3's CLI entry as a child process,
  `new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url)`,
  with that subcommand.
- **The Cursor SDK worker** (`__cursor-sdk-worker`):
  `src/provider/ProviderOrchestrationAdapterInfrastructure.ts` starts the same
  entry, the same way.

- **The managed ChatGPT token helper** (`managed-chatgpt-token`, Codex):
  `src/cli/managedChatGptToken.ts`, started by `CodexManagedTokenBroker` the
  same way (`HostProcess.Arguments` is `[node, bin.ts]`). Consola never signs
  a CLI in (it runs the person's own `codex` with its own login), so the
  broker's managed accounts are not used here. One lifted test reaches it,
  the first below.

t3's `src/bin.ts` is not lifted: it is started by path, not imported, and
through `binMain.ts` → `binCli.ts` it is t3's whole CLI and HTTP server (the
Codex closure's `new URL("../bin.ts", …)` in `CodexManagedRuntime.test.ts`
would add about 295 more files to the lifted tree, and `node-pty`, `playwright-core`,
`undici`, `saxes` and `character-entities` among new dependencies; this count
predates the host runtime lift, which brought `stream-json` and `stream-chain`). Of the lifted tests, only one reaches it, and it is
not run here: `CodexManagedRuntime.test.ts` "managed Codex primary account
shares home state without routing owned tokens through ambient CLI overrides"
(see "The lifted server's tests").

Also not followed, and optional where they are looked for: `src/config.ts`'s
`client` and `../../web/dist` (t3's web client build),
`src/resourceTelemetry/ResourceMonitorBinary.ts`'s `resource-monitor`
binary, and the transcripts `scripts/dev-replay-agent.ts` reads in t3's dev
mode (`devUrl`).

## Local changes to copied files

| File | Change | Why |
|---|---|---|
| `packages/*/package.json` (all 33) | Adds the line `"license": "MIT",` after `"private": true,` | t3 leaves `license` unset. Consola's rule is that every `package.json` names its licence, and a copied package keeps t3's MIT. Nothing else in the files changes. |
| `packages/provider-opencode/src/server/driver.ts` line 470 | `enabled: effectiveConfig.enabled,` → `enabled: false,` in the `readOpenCodeGoUsageLimits` call | Consola never reads a CLI's credentials. That call reads the person's OpenCode Go API key from OpenCode's `auth.json` and from its `opencode.db` `credential` table (opened directly with `node:sqlite`, so no file system or HTTP client a host provides can stop it) and sends it to `opencode.ai`. With `enabled: false` the driver never makes it; OpenCode 2's server still reports usage it can read itself. No setting or injected service turns it off (`@consola/host`'s `AGENTS.md`, "The host never reads a CLI's login"). |
| `packages/provider-opencode/package.json` | `test` runs `--config ./vitest.config.ts` instead of `../../vite.config.ts` | So the five driver tests of that read are skipped (`NOT_RUN_HERE` in Consola's `packages/provider-opencode/vitest.config.ts`, the shared config plus a `testNamePattern`, as `apps/server/vitest.config.ts` does). The tests of `readOpenCodeGoUsageLimits` itself (`status.test.ts`) still run. |

No other copied file differs from `d51d8c47`, the lifted files in
`apps/server/` included (its `tsconfig.json` too).
`packages/provider-opencode/vitest.config.ts` is Consola's file, not t3's. `apps/server/package.json`
is Consola's, not t3's, though it keeps t3's name, `t3`.

## Consola's side

Files Consola writes for this folder (not copied):

- `vendor/t3code/package.json`: `@consola/t3code-vendor`, private. It stands
  in for t3's root `package.json` and holds what the copied packages' scripts
  expect at the root: `@effect/tsgo` 0.67.1, `vite-plus` and `@types/node`
  (catalog).
- This file.
- `apps/server/package.json` (`t3`), `apps/server/vitest.config.ts`, and
  `packages/provider-claude/`'s and `packages/provider-codex/`'s
  `package.json`, `tsconfig.json`, `vitest.config.ts` and entry files: see "Lifted by Consola".

In the repository root:

- `patches/`: t3's patch files, byte for byte, for each patched package the
  copied packages install: `@cursor__sdk@1.4.2.patch`,
  `@effect__platform-node-shared@4.1.5.patch`, `@effect__vitest@4.1.5.patch`,
  `@ff-labs__fff-node@0.11.0.patch` (for the lifted server files: it adds the
  `*Async` search methods `apps/server/src/workspace/WorkspaceSearchIndex.ts`
  calls),
  `@muse-code__sdk@1.4.6.patch`, `@pierre__diffs@1.7.0-beta.4.patch`,
  `mdast-util-math@3.0.0.patch`, `mdast-util-to-hast@13.2.1.patch`,
  `micromark-extension-gfm-table@2.1.1.patch`,
  `micromark-extension-llm-math@3.1.0.patch`, `micromark@4.0.2.patch`.
  They live here, not in `vendor/`, because Vercel uploads `patches/` and not
  `vendor/`, and pnpm opens every patch `pnpm-workspace.yaml` names before it
  installs anything.
  pnpm applies a patch to every copy of that version in the workspace, so
  Consola's own `micromark@4.0.2`, `mdast-util-to-hast@13.2.1` and
  `micromark-extension-gfm-table@2.1.1` (the desktop's and the website's
  markdown) get t3's patches too. They cache work (`micromark`,
  `mdast-util-to-hast`) and teach the table tokenizer about math
  (`micromark-extension-gfm-table`), which changes nothing without a math
  extension.
- `pnpm-workspace.yaml`, translating what the copied packages need from t3's
  pnpm 12 settings into pnpm 10's:
  - `packages`: `vendor/t3code`, `vendor/t3code/packages/*` and
    `vendor/t3code/apps/*` (`t3`, the lifted server).
  - `catalog`: every entry of t3's catalog a copied `package.json` names with
    `catalog:`, at t3's version. (The lifted server, `t3`, names exact versions.)
  - `patchedDependencies`: the eleven patches above.
  - `overrides`, each scoped to the edge t3 needs:
    `'@effect/vitest>vitest': '-'` (t3's patch makes `@effect/vitest` import
    `vite-plus/test`); `@opencode/client`, `@opencode/protocol` and
    `@opencode/schema` `>effect: 4.1.5` (OpenCode 2 pins an exact Effect and
    its schemas fail to decode under a second copy; t3 overrides `effect`
    everywhere);
    `remark-math>micromark-extension-math: npm:micromark-extension-llm-math@3.1.0`
    (t3's math tokenizer); t3's eight
    `'@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-<platform>': '-'`,
    which leave out the Claude executables the SDK bundles (the adapter is
    always handed the person's own `claude`, never the bundled one); and
    `'@anthropic-ai/claude-agent-sdk>@anthropic-ai/sdk': 0.93.0`, the SDK's
    peer at the version t3's lockfile has. Left to itself pnpm installs the
    newest (1.12.0), which depends on `@opentelemetry/api`, and that moves the
    optional-peer resolutions of Consola's own packages (`better-auth`,
    `drizzle-orm`, `vitest`) in the lockfile.
  - `packageExtensions`: `@effect/vitest` depends on `vite-plus` 1.4.0, as in
    t3, because of the same patch.
  - `peerDependencyRules.allowedVersions`: `vite` is allowed for
    `vitest@5` and `@vitest/mocker@5`. Vite+ runs its Vitest on its own Vite
    build, `@voidzero-dev/vite-plus-core`, whose version (1.4.0) is outside
    Vitest's range. t3 allows any `vite` for every package.
  - `publicHoistPattern: ['@effect/tsgo']`. t3 runs `effect-tsgo` from its
    repository root's `node_modules/.bin`, which pnpm puts on every package
    script's PATH. Here the root is Consola's, so `@effect/tsgo` (held by
    `vendor/t3code/package.json`) is hoisted to put its bin there.
- `biome.jsonc` ignores `vendor`, so Consola's formatter never rewrites the
  copy.
- `.github/workflows/ci.yml`, job `vendor`: installs, then runs the own
  `typecheck` of every package under `vendor/t3code/packages/*` and
  `vendor/t3code/apps/*`, and their own `test`, on Linux like t3's CI, but
  for the entry packages (`--filter "!...^t3"`, every package
  that depends on the lifted server): their `test` runs a slice of the
  server's own tests, which `t3`'s `test` already runs, so every
  copied test runs once. A later entry package is left out by the same filter,
  with no change to the job.

### t3 settings not carried over

- `allowBuilds` (pnpm 11+): no package the copy installs needs an install
  script approved; pnpm 10 reports no new ignored build.
- The global `overrides` t3 uses to pin every patched package, `vite`,
  `@types/node`, `effect` and others for lockfile-free installs. Consola
  installs from its lockfile, and a global pin would move Consola's own
  packages (`vite`, `@types/node`, `yaml`). Where a copied package needed one
  edge, that edge is overridden alone (above).
- `publicHoistPattern: ['@cursor/sdk-*']`, which lets the Cursor SDK find its
  platform binary at runtime. The copied tests do not need it, and nothing
  here runs the Cursor SDK (it is never bundled into anything Consola builds).
- t3's other patches, which are for packages the copy does not install (its
  mobile, desktop and infrastructure). `electron-updater@6.8.9` is installed
  here, but as Consola's desktop's own dependency, so t3's patch for it
  stays out.
- `strictPeerDependencies`, `minimumReleaseAgeExclude`, `permissions`,
  `.pnpmfile.cjs`: install policy for t3's own repository and mobile app.

### Resolved differently from t3's lockfile

pnpm resolves the copied packages' ranges itself here. Direct dependencies
that landed on another version than t3's lockfile has:

- `@opencode-ai/sdk` 1.19.6 (t3: 1.15.13), `provider-opencode`, range `^1.3.15`
- `unbash` 5.1.0 (t3: 5.0.0), `client-runtime`, range `^5.0.0`
- `yaml` 2.9.1 (t3: 2.9.0), catalog range `^2.9.0`

The lifted server (`t3`) names every dependency at the version t3's lockfile resolves
for its `apps/server` importer, `yaml` 2.9.0 included, and the Claude Agent
SDK's peers resolve as in t3: `@anthropic-ai/sdk` 0.93.0 (by the override
above), `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7. What Consola's own
packages resolve to is unchanged by the lift: their importers and the 900
snapshots they reach are the same entries as before it. One of them pnpm
would otherwise have moved while resolving the new packages:
`@jridgewell/trace-mapping`'s `@jridgewell/sourcemap-codec`, from 1.5.5 to
1.6.0, both already in the lockfile; the lockfile keeps 1.5.5, which pnpm
accepts and leaves as it is.

## Tests

Every copied package's `typecheck` passes. Its `test` passes on Linux (CI).
On macOS three of t3's tests fail, as they would in t3 (t3 tests on Linux):

- `shared` `src/shell.test.ts`, "captures values when the profile replaces
  PATH and a DEBUG trap echoes commands": it copies `/usr/bin/printenv` into a
  temporary folder and runs the copy, which macOS kills as it starts
  (SIGKILL; the copy is an Apple platform binary).
- `provider-fx` `src/server/skills.test.ts`, two tests: they compare paths
  under the temporary folder, which macOS reaches through the `/var` →
  `/private/var` symlink. They pass with `TMPDIR` set to its real path.
- `source-control-github` `src/server/GitHubRest.test.ts`, "reports a gh
  timeout as a timeout and does not cache it", fails when `GH_TOKEN` is set in
  the environment, on any OS.

The two packages the lifted server files brought in fail on macOS in the same way:

- `ssh` `src/tunnel.test.ts`, four tests. "names missing gzip after
  verifying with sha256sum" and "… with shasum" expect `tar -xzf` to fail
  without `gzip` on the PATH, as GNU tar does; macOS's bsdtar decompresses by
  itself. "a reconnect from an older client keeps a newer managed server
  running" and "a newer client still replaces an older managed server" start
  a fake runtime, `exec node …`, from a shell given only `HOME`, so they need
  `node` on the shell's default PATH, where a Mac with Node from nvm has
  none. All 84 pass on Linux (Node 26.13.1 in Debian bookworm, as a
  non-root user). `tailscale` passes everywhere.

### The lifted server's tests

They live in `apps/server/`, and `pnpm --filter t3 test` runs
them all (51 files, 1,541 tests); `pnpm --filter @t3tools/provider-claude test`
runs the Claude ones (16 files, 657 tests) and
`pnpm --filter @t3tools/provider-codex test` the Codex ones (20 files, 511
tests, below) and `pnpm --filter @t3tools/server-orchestration test` the
ingestion and projection ones (15 files, 373 tests, below). The entry packages' scripts run the server's own Vitest,
because the server's `vite-plus` is a different install from an entry
package's (`yaml` 2.9.0 against 2.9.1), and test files register with the
runner of the install they import. CI runs them once, in the server.

**Claude.** All 16 lifted test files run; nothing of Claude's is listed as
"not run here", since everything they need was lifted with them (the orchestrator, its SQLite
persistence on `node:sqlite`, the fake Claude CLIs they write). 657 tests,
all passing on Linux. On macOS one is skipped by t3's own condition,
`ClaudeCapabilitiesProbe.test.ts` "starts a Bash launcher that calls an
exported function in the probe's workspace" (`skipIf` not Linux). They need
no `claude` on the PATH and no Claude login: they pass with `env -i` and a
PATH of Node and `/usr/bin:/bin` only.
`ClaudeAdapterV2.test.ts` runs all 474 of its tests (none is skipped on
macOS or Linux), `ClaudeAgentSdkQueryRunner.test.ts` 26, and
`ClaudeReplayFixtures.integration.test.ts` 40 (one per Claude fixture
variant, 35, and five of its own).

On macOS, with the default `TMPDIR`, two `src/provider/Drivers/ClaudeSkills.test.ts`
tests fail, as they would in t3: "merges plugin enablement and selects
installs in native registry order" compares paths under `/var`, which macOS
resolves to `/private/var` (the `provider-fx` case above), and "gives a synced
namespace to an installed plugin, then the first synced row" makes both
`pstack` and `PSTACK` folders, which a case-insensitive volume (macOS's
default) refuses. Both pass with `TMPDIR` on a case-sensitive volume reached
by its real path. The `ClaudeAgentSdkQueryRunner` "Claude CLI process" tests
print Node's `MaxListenersExceededWarning` twice: the Claude Agent SDK adds an
`exit` listener per message read (`waitForExit`).

**Codex.** 20 test files, 511 tests, upstream's own counts (the files are
byte-identical): `CodexAdapterV2.test.ts` 210, `CodexChatGptAuth` 56,
`codexUsage` 45, `CodexInstallation` 41, `CodexTextGeneration` 34,
`CodexReplayFixtures.integration` 26 (24 fixture variants and two of its
own), `codexUsageLimits` 20, `CodexDriver` 19, `codexLaunchArgs` 11,
`CodexMcpElicitation` 9, `CodexHomeLayout` 9, `CodexProvider` 7,
`CodexManagedErrors` 6, `CodexDeveloperInstructions` 5,
`CodexManagedRuntime` 4, `CodexChatGptModels`, `CodexChatGptSessionLock`,
`CodexThreadRevert` and `codexModelCatalog` 2 each, `codexModelOptions` 1.
510 pass and one is not run here, on macOS and on Linux; the output is
clean. They need no `codex` binary and no login (fake app-server peers and
recorded transcripts).

Not run here: `CodexManagedRuntime.test.ts` "managed Codex primary account
shares home state without routing owned tokens through ambient CLI
overrides". It runs t3's `src/bin.ts` as a child process for the managed
ChatGPT token helper, and `bin.ts` is not lifted (see "Known runtime gaps").
The test file is not edited; `apps/server/vitest.config.ts`
(`NOT_RUN_HERE`) skips that one test by name, in `t3`'s test and in
`provider-codex`'s, and the file's other three run. The skip shows as one
skipped test. Without it, the test fails with `Cannot find module …/bin.ts`.

**Ingestion and projection.** 15 test files, 373 tests, all passing on macOS
and on Linux, upstream's own counts (the files are byte-identical):
`RunExecutionService` 83, `ProviderSessionManager` 74, `ProjectionStore` 62,
`ProviderEventIngestor` 32, `ProviderCommitBatch` 26, `ProjectionRecovery` 21,
`WireProjection` 18, `ThreadLiveEventCoalescer` 16, `assistantStreaming` 16,
`SubagentProjection` 12, `ProjectionSettlement` 6, `ProjectionMaintenance` 3,
`ProjectionControlReads` 2, `EventSink` 1, `ProviderReplayHarness` 1. They need
t3's SQLite, which works here: it is `node:sqlite`, lifted with the
orchestrator. Nothing in them is skipped or listed as "not run here". Output is
clean. The full `t3` run is now 51 files and 1,541 tests (Linux: 1,540 pass,
one skipped; macOS: also the two `ClaudeSkills` failures above).

## Re-syncing

Copy the same paths from a newer commit over these, compute the closure again
(new `workspace:` dependencies join it), re-apply the changes listed under
"Local changes", and compare t3's catalog, `patchedDependencies` and the
overrides above with `pnpm-workspace.yaml`.

For the lifted server files, start again from every seed (under "Lifted by
Consola", and each later lift's): follow the imports, `new URL(…,
import.meta.url)` and `vi.mock` paths in the newer `apps/server`, copy the
closure over `apps/server/` (with t3's `tsconfig.json`), delete the files that
left it, and compare the `t3` manifest's dependencies with t3's lockfile.
