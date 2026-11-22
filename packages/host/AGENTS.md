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
session id. It is glue over t3's own machinery; it writes no command handling,
ingestion or projection of its own.

- `threadRuntime.ts`: `ThreadRuntime.open(spec)` builds t3's `OrchestratorV2`
  in the caller's scope with t3's `layerWithRegistry`
  (`t3/orchestration-v2/testkit/ProviderReplayHarness.ts`), the narrowest
  assembly of it t3 has: its real stores over in-memory `node:sqlite`, its
  ingestion, run execution and effect worker. Then it dispatches
  `thread.create`. The handle's `dispatch` asks `decideCommand` first;
  `snapshot()` is t3's `getThreadSnapshot`, refreshed on every stored event by
  t3's unbounded `streamStoredEvents`, so a pending approval is there with no
  client connected; `events` is t3's `streamStoredEventsFrom`, the stream t3's
  `subscribeThread` serves.
- `drivers.ts`: `HOST_DRIVERS` (t3's `BUILT_IN_DRIVERS` for the five harnesses,
  never Cursor) and `hostAdapters`, which builds a session's adapter the way
  t3's Claude replay harness does: `createClaudeAdapterV2` in a registry of
  one, with the real Agent SDK runner. Only Claude is wired; another harness
  fails with `HarnessNotWiredError`.
- `providerHost.ts`: `makeProviderHost`, t3's `ProviderHost` with every path
  under the state folder, t3's default settings, no credential store, and the
  CLIs' environment (`HostProcess.Environment`).

`layerWithRegistry` is t3's test wiring, so it fixes what t3's tests fix: the
orchestrator's `ServerConfig` lives in a temporary folder removed with the
scope, settings are t3's defaults with `responseStreamingMode: "turn"` (an
answer arrives whole at the end of a turn), providers get no MCP server
(`configureMcp: false`), threads use no task folders, and titles are not
regenerated. t3 logs (migrations, provider warnings) go to the default logger,
which writes to stdout.

### The Cursor SDK is in the runtime's module graph

`threadRuntime.ts` reaches `@cursor/sdk` through static imports, because
t3's `Orchestrator.ts` does. Two chains, found by a transitive import walk
(19 files that import `@cursor/sdk`):

- `threadRuntime.ts` → `t3/orchestration-v2/testkit/ProviderReplayHarness.ts`
  → `orchestration-v2/ThreadManagementService.ts` →
  `workspace/restoreMissingWorktree.ts` → `terminal/Manager.ts` →
  `provider/ProviderInstanceRegistryHydration.ts` →
  `provider/ProviderOrchestrationAdapterInfrastructure.ts` →
  `@t3tools/provider-cursor/server/CursorAgentSdk` (and
  `CursorAgentSdkProcessRunner`); also `ProviderInstanceRegistryHydration.ts`
  → `provider/builtInDrivers.ts` → `@t3tools/provider-cursor/server`.
- `t3/orchestration-v2/Orchestrator.ts` → `RunExecutionService.ts` →
  `RunFinalizationService.ts` → `vcs/VcsStatusBroadcaster.ts` →
  `git/GitWorkflowService.ts` → `git/GitManager.ts` →
  `project/ProjectSetupScriptRunner.ts` → `terminal/Manager.ts` → the same
  chain as above.

`drivers.ts` and `providerHost.ts` reach none of it. Nothing here is bundled:
the host runs from source, and nothing it runs calls the Cursor SDK. The host
bundle (Track B, CON-93) must keep `@cursor/sdk` out, by marking it external or
stubbing `@t3tools/provider-cursor/server*`, and must check the output (no
`@cursor/sdk` in the bundle) before it ships.

## Running it

```bash
pnpm --filter @consola/host test        # vp test run (Vite+), config in vite.config.ts
pnpm --filter @consola/host typecheck   # effect-tsgo, hoisted by publicHoistPattern
```

## Licensing

`@consola/host` is AGPL-3.0-only, Consola's own code. The vendored packages keep
t3's MIT licence (`vendor/t3code/LICENSE`).

- On a Mac the host runs the person's installed CLI with its existing login. It
  never shows a sign-in, never reads or stores a CLI's credentials, and passes
  `pathToClaudeCodeExecutable` for Claude, never the SDK's bundled copy.
- The Cursor SDK (`@cursor/sdk`) is never bundled into anything the host builds.
- Nothing that bundles `@anthropic-ai/claude-agent-sdk` is published or released
  (Linear CON-21). Local builds are fine.
- Fixtures and examples use Acme, Sprocket and the `sprocket` org, never real
  names.
