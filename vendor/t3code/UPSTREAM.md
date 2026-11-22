# t3code, vendored

This folder holds packages copied from t3code, unchanged except where listed
under "Local changes". They keep t3's names, layout and toolchain (Effect 4,
`effect-tsgo`, Vite+), so a later re-sync is a diff rather than a port. It
also holds packages Consola lifted out of t3's server (`apps/server`), whose
files are copied the same way (see "Lifted by Consola").

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

Pulled in by the Claude lift (`provider-claude`, below), which imports them
and which none of the 31 needs:

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
not moved yet still live in provider/Drivers"). Consola lifts them into
packages of their own, shaped like `provider-pi`. The rules:

- A lifted file is copied byte for byte from t3's `apps/server/` at
  `d51d8c47`, at the same path relative to `apps/server/`: `src/…` stays
  `src/…`, and the two files outside it stay at `scripts/…` and `schema/…`.
  The package's directory stands where `apps/server/` stood, so every
  relative import resolves unchanged.
- When a lifted file imports another server file, that file is lifted too,
  transitively. Nothing is stubbed or rewritten to avoid a copy. Imports of
  the copied packages (`@t3tools/*`, `effect-acp`, …) stay package imports.
- The package's `package.json`, `tsconfig.json` and its entry files
  (`src/server.ts`, `src/settings.ts`, `src/testing.ts`) are Consola's. The
  entry files only re-export lifted code, under t3's names.
- Two lifted packages may hold copies of the same server file; each keeps its
  own. Overlaps are listed under "Duplicated across lifted packages".

### `@t3tools/provider-claude` (`packages/provider-claude`)

Claude's adapter, driver and replay testkit, from t3's server.

**Entry points.**

| Export | Re-exports | Source |
|---|---|---|
| `./server` | `ClaudeDriver`, `type ClaudeDriverEnv`; the module as `ClaudeAdapterV2` (as t3's server imports it); `CLAUDE_PROVIDER`, `createClaudeAdapterV2`, `type ClaudeAdapterV2DriverEnv` | `src/provider/Drivers/ClaudeDriver.ts`, `src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` |
| `./settings` | `ClaudeSettings` | `@t3tools/contracts`, where t3 defines it |
| `./testing` | everything `ClaudeAdapterV2.testkit.ts` exports (`ClaudeOrchestratorReplayHarness`, `makeClaudeRestartReplayHarness`, `recordClaudeAgentSdkReplayTranscript`, the replay errors) | `src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts` |

No `./client`: t3 has no Claude client module. Claude's client entry is an
unnamed object inside `@t3tools/client-runtime`'s `providerClients` registry
(`packages/client-runtime/src/providerClients.ts`), read with
`getProviderClient("claudeAgent")`; a new `defineProviderClient` here would be
code t3 does not have. `src/server.ts` takes the path of t3's own
`apps/server/src/server.ts` (its HTTP server), which the closure does not
reach; a re-sync that needs it would have to move the entry.

What each entry reaches matters to anything that bundles it. `./server` reaches
67 lifted files and, among native or vendor code, the Claude Agent SDK,
`ffi-rs` (through `src/policy/ManagedPolicy.ts`) and only the `client`
subpaths of the other providers, so not the Cursor SDK. `./testing` reaches
the whole closure below, `@t3tools/provider-cursor/server` (and with it
`@cursor/sdk`) included, and is for tests only.

**The closure.** Seeds, as the lift asked for them (paths under `src/`):

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

From them, every relative `import`, `export … from` and `import()` (read with
TypeScript's own import scanner, so nothing in a comment counts), every
`new URL("<relative path>", import.meta.url)` and every `vi.mock("<relative
path>")` was followed until no new file appeared. Data files: the 35
`claude_transcript.ndjson` replay transcripts `fixtures/index.ts` names for
`claudeAgent`. The other drivers' transcripts it names are not copied (no
copied test reads them), nor the five Claude transcripts only t3's other
orchestrator tests read (`claude_subagent_resume_after_restart`,
`thread_fork_native`, `thread_fork_native_fork_local_rollback`,
`thread_fork_native_prior_turn`, `thread_merge_back_siblings`).

755 files: 720 source files (257,880 lines) and 35 transcripts (2,318 lines).
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
| 1–4 each | | `src/resourceTelemetry`, `secrets`, `telemetry`, `auth`, `checkpointing`, `environment`, `htmlRender`, `process`, `usage`, `background`, `desktopUpdate`, `mcpApps`, `observability`, `scheduling`, `terminal`, `assets`, `cli`, `speech`, `utils`; `scripts/dev-replay-agent.ts`, `schema/expo.graphql.ts` |

The adapter and the driver alone reach 67 of these files. The rest comes
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

Not followed: file paths the lifted code only builds at run time, which no
import names.

- `../bin.ts`, in `src/provider/DocumentText.ts` and
  `src/provider/ProviderOrchestrationAdapterInfrastructure.ts`
  (`new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", …)`):
  t3's CLI entry, which they start as a child process for its
  `__document-text` and `__cursor-sdk-worker` subcommands. Lifting it would
  bring in t3's whole CLI and HTTP server (`bin.ts` → `binMain.ts` →
  `binCli.ts`): 260 more source files, and `node-pty`, `playwright-core`,
  `undici`, `stream-json` and `saxes` among new dependencies. It is left for
  a decision rather than lifted. Without it, the adapter's text
  extraction from document attachments (`DocumentText`, which
  `ClaudeAdapterV2.ts` imports) and the Cursor worker launch fail when they
  run; no copied test reaches either.
- `src/config.ts`'s `client` and `../../web/dist` (t3's web client build) and
  `src/resourceTelemetry/ResourceMonitorBinary.ts`'s `resource-monitor`
  binary: looked for, and optional.
- The transcripts `scripts/dev-replay-agent.ts` reads, used only in t3's dev
  mode (`devUrl`).

Every lifted file is byte-identical to `d51d8c47` (checked by comparing each
one with the clone). The paths, relative to t3's `apps/server/`:

<details>
<summary>All 755 lifted paths</summary>

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
src/cloud/bootService.ts
src/cloud/config.ts
src/cloud/pinnedRuntime.ts
src/cloud/selfUpdate.ts
src/cloud/serviceLauncherClient.ts
src/cloud/servicePreflight.ts
src/cloud/serviceProtocol.ts
src/cloud/serviceSelectionLock.ts
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
src/orchestration-v2/EventSink.ts
src/orchestration-v2/EventStore.ts
src/orchestration-v2/GuestShareDecider.ts
src/orchestration-v2/LiveStreamBudget.ts
src/orchestration-v2/NotificationMailbox.ts
src/orchestration-v2/Orchestrator.ts
src/orchestration-v2/ProjectCommands.ts
src/orchestration-v2/ProjectStore.ts
src/orchestration-v2/ProjectionStore.ts
src/orchestration-v2/ProviderAdapterRegistry.ts
src/orchestration-v2/ProviderCommitBatch.ts
src/orchestration-v2/ProviderContinuationService.ts
src/orchestration-v2/ProviderEventIngestor.ts
src/orchestration-v2/ProviderRuntimeRecoveryService.ts
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
src/orchestration-v2/RunExecutionService.ts
src/orchestration-v2/RunFinalizationService.ts
src/orchestration-v2/RunMetrics.ts
src/orchestration-v2/RuntimePolicy.ts
src/orchestration-v2/RuntimeRequestService.ts
src/orchestration-v2/ShellStream.ts
src/orchestration-v2/ThreadCommandExecutor.ts
src/orchestration-v2/ThreadDeletion.ts
src/orchestration-v2/ThreadFind.ts
src/orchestration-v2/ThreadForkService.ts
src/orchestration-v2/ThreadLaunchService.ts
src/orchestration-v2/ThreadManagementService.ts
src/orchestration-v2/ThreadSearch.ts
src/orchestration-v2/ThreadSettlementService.ts
src/orchestration-v2/ThreadTitleRegenerationService.ts
src/orchestration-v2/ThreadViewers.ts
src/orchestration-v2/TurnItemPositionStore.ts
src/orchestration-v2/UserFacingErrors.ts
src/orchestration-v2/WireProjection.ts
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
src/orchestration-v2/testkit/CommandOutputRecorder.ts
src/orchestration-v2/testkit/DeterministicRuntime.ts
src/orchestration-v2/testkit/OrchestratorScenario.ts
src/orchestration-v2/testkit/ProviderReplayFixtures.ts
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
src/orchestration-v2/testkit/fixtures/codex_model_reroute/output.ts
src/orchestration-v2/testkit/fixtures/command_output_streaming/claude_transcript.ndjson
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
src/orchestration-v2/testkit/fixtures/message_steering/cursor_output.ts
src/orchestration-v2/testkit/fixtures/message_steering/grok_output.ts
src/orchestration-v2/testkit/fixtures/message_steering/input.ts
src/orchestration-v2/testkit/fixtures/message_steering/pi_output.ts
src/orchestration-v2/testkit/fixtures/multi_turn/claude_output.ts
src/orchestration-v2/testkit/fixtures/multi_turn/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/multi_turn/codex_output.ts
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
src/orchestration-v2/testkit/fixtures/plan_questions/input.ts
src/orchestration-v2/testkit/fixtures/plan_questions/opencode_output.ts
src/orchestration-v2/testkit/fixtures/proposed_plan/codex_output.ts
src/orchestration-v2/testkit/fixtures/proposed_plan/cursor_output.ts
src/orchestration-v2/testkit/fixtures/proposed_plan/input.ts
src/orchestration-v2/testkit/fixtures/provider_thread_resume/input.ts
src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_output.ts
src/orchestration-v2/testkit/fixtures/queued_cancelled_while_active/codex_output.ts
src/orchestration-v2/testkit/fixtures/queued_cancelled_while_active/input.ts
src/orchestration-v2/testkit/fixtures/queued_turn/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/queued_turn/codex_output.ts
src/orchestration-v2/testkit/fixtures/queued_turn/input.ts
src/orchestration-v2/testkit/fixtures/shared.ts
src/orchestration-v2/testkit/fixtures/simple/claude_output.ts
src/orchestration-v2/testkit/fixtures/simple/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/simple/codex_output.ts
src/orchestration-v2/testkit/fixtures/simple/input.ts
src/orchestration-v2/testkit/fixtures/simple/pi_output.ts
src/orchestration-v2/testkit/fixtures/skill_invocation/cursor_output.ts
src/orchestration-v2/testkit/fixtures/skill_invocation/input.ts
src/orchestration-v2/testkit/fixtures/stop_background_work_after_failed_turn/input.ts
src/orchestration-v2/testkit/fixtures/stop_background_work_after_failed_turn/output.ts
src/orchestration-v2/testkit/fixtures/subagent/claude_output.ts
src/orchestration-v2/testkit/fixtures/subagent/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/subagent/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent/cursor_output.ts
src/orchestration-v2/testkit/fixtures/subagent/input.ts
src/orchestration-v2/testkit/fixtures/subagent/kiro_output.ts
src/orchestration-v2/testkit/fixtures/subagent_continue/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_continue/input.ts
src/orchestration-v2/testkit/fixtures/subagent_v2/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2/input.ts
src/orchestration-v2/testkit/fixtures/subagent_v2/muse_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_approval/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_approval/input.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_nested/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_nested_approval/codex_output.ts
src/orchestration-v2/testkit/fixtures/subagent_v2_nested_approval/input.ts
src/orchestration-v2/testkit/fixtures/thread_rollback/claude_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/thread_rollback/codex_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback/input.ts
src/orchestration-v2/testkit/fixtures/thread_rollback/pi_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_after_restart/codex_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_after_restart/input.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/input.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_to_stopped_turn/codex_output.ts
src/orchestration-v2/testkit/fixtures/thread_rollback_to_stopped_turn/input.ts
src/orchestration-v2/testkit/fixtures/todo_list/codex_output.ts
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
src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/fx_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/input.ts
src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/output.ts
src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/claude_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/codex_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/input.ts
src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/claude_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/codex_output.ts
src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/input.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt/claude_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/turn_interrupt/codex_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt/input.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt/muse_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/claude_output.ts
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/claude_transcript.ndjson
src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/codex_output.ts
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
src/provider/CodexChatGptAuth.ts
src/provider/CodexChatGptModels.ts
src/provider/CodexChatGptSessionLock.ts
src/provider/CodexDeveloperInstructions.ts
src/provider/CodexInstallation.ts
src/provider/CodexManagedErrors.ts
src/provider/CodexManagedHome.ts
src/provider/CodexManagedRuntime.ts
src/provider/CodexManagedTokenBroker.ts
src/provider/CodexManagedTokenProtocol.ts
src/provider/CodexMcpElicitation.ts
src/provider/CodexProvider.ts
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
src/provider/Drivers/CodexDriver.ts
src/provider/Drivers/CodexHomeLayout.ts
src/provider/Drivers/CodexManagedProvider.ts
src/provider/Drivers/antigravityUsageReader.ts
src/provider/Drivers/claudeUsage.ts
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
src/provider/codexLaunchArgs.ts
src/provider/codexModelCatalog.ts
src/provider/codexUsageLimits.ts
src/provider/managedRelease.ts
src/provider/model-manifest.json
src/provider/providerCompatibility.ts
src/provider/providerStatusCache.ts
src/provider/resetCreditCoordinator.ts
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
src/textGeneration/AntigravityTextGeneration.ts
src/textGeneration/ClaudeTextGeneration.ts
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

### `apps/server/`, for `@t3tools/ssh`'s tests

`packages/ssh/src/launcherTestHarness.ts` runs t3's SSH helper command from
`<t3 root>/apps/server/src/cli/sshHelper.ts`, a path it builds from its own
location (`new URL("../../../", import.meta.url)`). So that file and its
closure, found the same way, are lifted to `vendor/t3code/apps/server/`, at
t3's paths, byte for byte:

```
package.json
src/cli/sshHelper.ts
src/cloud/serviceProtocol.ts
src/cloud/serviceSelectionLock.ts
src/desktopUpdate/DesktopUpdateMarker.ts
src/legacyServerOwner.ts
src/noCopyOnWrite.ts
src/serviceLauncher.ts
```

`package.json` is t3's server manifest, which `sshHelper.ts` reads for its
version (and which gives these files `"type": "module"`). It is not a
workspace package (`pnpm-workspace.yaml` names `vendor/t3code/packages/*`),
so nothing installs its dependencies; the files import only `effect` and
`@t3tools/contracts`, which resolve from `vendor/t3code/node_modules`
(`@consola/t3code-vendor`, below). Without them two of `ssh`'s tests ("archive
launcher reuses the replacement without host Node", "waits for a boot service
between two servers (archive: true)") fail on every OS.

### Duplicated across lifted packages

Six of the eight `apps/server/` files above are also in `provider-claude`:
`src/cloud/serviceProtocol.ts`, `src/cloud/serviceSelectionLock.ts`,
`src/desktopUpdate/DesktopUpdateMarker.ts`, `src/legacyServerOwner.ts`,
`src/noCopyOnWrite.ts`, `src/serviceLauncher.ts` (`src/cli/sshHelper.ts` and
t3's `package.json` are not). Besides those, none yet: `provider-claude` is
the only lifted package.

## Local changes to copied files

| File | Change | Why |
|---|---|---|
| `packages/*/package.json` (all 33) | Adds the line `"license": "MIT",` after `"private": true,` | t3 leaves `license` unset. Consola's rule is that every `package.json` names its licence, and a copied package keeps t3's MIT. Nothing else in the files changes. |

No other copied file differs from `d51d8c47`, the lifted files (in
`provider-claude` and `apps/server/`) included.

## Consola's side

Files Consola writes for this folder (not copied):

- `vendor/t3code/package.json`: `@consola/t3code-vendor`, private. It stands
  in for t3's root `package.json` and holds what the copied packages' scripts
  expect at the root: `@effect/tsgo` 0.67.1, `vite-plus` and `@types/node`
  (catalog), and `effect` (catalog) and `@t3tools/contracts`, which the files
  lifted to `apps/server/` for `ssh`'s tests import.
- This file.
- `tsconfig.lifted.json`, which the lifted packages extend in place of
  `tsconfig.base.json`. It is `tsconfig.effect.json`'s plugin block with one
  rule off, `deterministicKeys`: that rule wants every service key to start
  with the name of the package its file sits in, and the lifted files keep
  t3's server keys (`"t3/provider/AntigravityInstallation"` and 134 more),
  which a package named `@t3tools/provider-claude` fails. A package's own
  `plugins` replaces the inherited block whole, so the rest is repeated; keep
  it equal to `tsconfig.effect.json` when re-syncing.
- `packages/provider-claude/package.json`, `tsconfig.json`, and the entry
  files `src/server.ts`, `src/settings.ts` and `src/testing.ts` (see "Lifted
  by Consola"):
  - `version` is `0.1.11`, t3's server version at `d51d8c47`. Twelve lifted
    files read their version from `../package.json` (`src/config.ts`,
    `src/serverRuntimeState.ts`) or `../../package.json` (`src/cloud/*`,
    `src/terminal/Manager.ts`, …), which here is this file, standing where
    t3's server manifest stood. They read nothing else from it.
  - `scripts` are `provider-pi`'s. `tsconfig.json` is `provider-pi`'s with
    t3's server `lib` (`ESNext`, `esnext.disposable`), extending
    `tsconfig.lifted.json`.
  - Dependencies: every package the lifted files import, at the version
    t3's lockfile resolves for `apps/server` (`@anthropic-ai/claude-agent-sdk`
    0.3.321, `@ff-labs/fff-node` 0.11.0, `@napi-rs/keyring` 1.3.0, `diff`
    8.0.3, `ffi-rs` 1.3.2, `proper-lockfile` 4.1.2, `yauzl` 3.4.0,
    `@types/proper-lockfile` 4.1.4, `@types/yauzl` 3.4.0), `catalog:` where t3
    uses it, and `workspace:*` for the copied packages. Test-only imports
    (`@effect/vitest`, `vite-plus`, `@t3tools/provider-testing`) are
    `devDependencies`.

In the repository root:

- `patches/`: t3's patch files, byte for byte, for each patched package the
  copied packages install: `@cursor__sdk@1.4.2.patch`,
  `@effect__platform-node-shared@4.1.5.patch`, `@effect__vitest@4.1.5.patch`,
  `@ff-labs__fff-node@0.11.0.patch` (for `provider-claude`: it adds the
  `*Async` search methods `src/workspace/WorkspaceSearchIndex.ts` calls),
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
  - `packages`: `vendor/t3code` and `vendor/t3code/packages/*`.
  - `catalog`: every entry of t3's catalog a copied or lifted `package.json`
    names with `catalog:`, at t3's version (`@effect/platform-node-shared`
    came with `provider-claude`).
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
- `.github/workflows/ci.yml`, job `vendor`: installs, then runs every copied
  package's own `typecheck` and `test` scripts, on Linux like t3's CI.

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
- `yaml` 2.9.1 (t3: 2.9.0), catalog range `^2.9.0` (`provider-claude` too)

`provider-claude` pins its other dependencies at t3's versions, and the Claude
Agent SDK's peers resolve as in t3: `@anthropic-ai/sdk` 0.93.0 (by the
override above), `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7.

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

The two packages the Claude lift brought in fail on macOS in the same way:

- `ssh` `src/tunnel.test.ts`, four tests. "names missing gzip after
  verifying with sha256sum" and "… with shasum" expect `tar -xzf` to fail
  without `gzip` on the PATH, as GNU tar does; macOS's bsdtar decompresses by
  itself. "a reconnect from an older client keeps a newer managed server
  running" and "a newer client still replaces an older managed server" start
  a fake runtime, `exec node …`, from a shell given only `HOME`, so they need
  `node` on the shell's default PATH, where a Mac with Node from nvm has
  none. All 84 pass on Linux (Node 26.13.1 in Debian bookworm, as a
  non-root user). `tailscale` passes everywhere.

### `provider-claude`'s tests

All 16 copied test files run; nothing is listed as "not run here", since
everything they need was lifted with them (the orchestrator, its SQLite
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

## Re-syncing

Copy the same paths from a newer commit over these, compute the closure again
(new `workspace:` dependencies join it), re-apply the changes listed under
"Local changes", and compare t3's catalog, `patchedDependencies` and the
overrides above with `pnpm-workspace.yaml`.

For a lifted package, start again from its seeds (under "Lifted by
Consola"): follow the imports, `new URL(…, import.meta.url)` and `vi.mock`
paths in the newer `apps/server`, copy the closure over the package, delete
the files that left it, and compare the dependencies with t3's lockfile.
Keep `tsconfig.lifted.json` equal to `tsconfig.effect.json` but for its one
rule.
