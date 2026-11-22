// @effect-diagnostics nodeBuiltinImport:off - Each session gets temporary folders of its own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  ThreadId,
} from '@t3tools/contracts';
import { ClaudeOrchestratorReplayHarness } from '@t3tools/provider-claude/testing';
import type { AnyProviderDriver, ProviderInstance } from '@t3tools/provider-core/server/driver';
import { checkpointWorkspace } from '@t3tools/provider-testing/replayWorkspace';
import {
  ORCHESTRATOR_REPLAY_FIXTURES,
  ProviderReplayFixtures,
} from '@t3tools/server-orchestration/testing';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as ProviderAdapterRegistry from 't3/orchestration-v2/ProviderAdapterRegistry.ts';
import { materializeReplayTranscriptRuntimeInstructions } from 't3/orchestration-v2/testkit/ReplayRuntimeInstructions.ts';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { HOST_DRIVERS, type HostDriversEnv } from '../runtime/drivers.ts';
import type { ThreadHandle } from '../runtime/threadRuntime.ts';

/** A replay runs a whole recorded turn through t3's orchestrator; under load that takes a while. */
export const REPLAY_TIMEOUT_MS = 60_000;

/** The title the replay's text generation gives every thread. */
export const REPLAY_TITLE = 'Sprocket replay title';

/** t3's settings for a test: no update checks, so nothing asks npm or GitHub. */
const TEST_SETTINGS = { enableProviderUpdateChecks: false };

/** t3 titles threads with Codex by default; a replay session has only Claude to ask. */
export const TITLE_WITH_CLAUDE = {
  textGenerationModelSelection: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' },
};

/**
 * A state folder for one session, removed when `use` ends, with t3's settings file
 * (`<stateDir>/userdata/settings.json`): `TEST_SETTINGS` and `settings`.
 */
export const withState = <A, E, R>(
  use: (stateDir: string) => Effect.Effect<A, E, R>,
  settings: Record<string, unknown> = {},
) => {
  const settingsFile = JSON.stringify({ ...TEST_SETTINGS, ...settings });
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const stateDir = mkdtempSync(join(tmpdir(), 'consola-host-state-'));
      mkdirSync(join(stateDir, 'userdata'), { recursive: true });
      writeFileSync(join(stateDir, 'userdata', 'settings.json'), settingsFile);
      return stateDir;
    }),
    use,
    (stateDir) => Effect.sync(() => rmSync(stateDir, { recursive: true, force: true })),
  );
};

/** The replay stands in for an installed, signed-in Claude: t3 asks it for thread titles. */
const asInstalled = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  enabled: true,
  installed: true,
  status: 'ready',
  auth: { ...provider.auth, status: 'authenticated' },
});

export type ReplayTranscript = Effect.Success<
  ReturnType<typeof ClaudeOrchestratorReplayHarness.decodeTranscript>
>;

/** The host's own Claude driver: t3's, guarded by `withoutCliCredentialsDriver`. */
const hostClaudeDriver = HOST_DRIVERS.find((driver) => driver.driverKind === 'claudeAgent');

/**
 * The host's Claude driver with its orchestration adapter replaced by t3's Claude replay adapter,
 * the way t3's replay harness substitutes it, and a fixed thread title in place of the CLI's. The
 * `claude` on the PATH is the machine's fake, so its snapshot is made to read as installed.
 */
export const replayClaudeDriver = (
  transcript: ReplayTranscript,
): AnyProviderDriver<HostDriversEnv> => {
  if (hostClaudeDriver === undefined) throw new Error('HOST_DRIVERS has no Claude driver.');
  return {
    ...hostClaudeDriver,
    create: (input) => replayInstance(hostClaudeDriver.create(input), transcript),
  };
};

const replayInstance = Effect.fn('replayInstance')(function* <E, R>(
  created: Effect.Effect<ProviderInstance, E, R>,
  transcript: ReplayTranscript,
) {
  const instance = yield* created;
  const replay = yield* Layer.build(
    ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript),
  ).pipe(Effect.orDie);
  const adapter = yield* Context.get(replay, ProviderAdapterRegistry.ProviderAdapterRegistryV2)
    .get(instance.instanceId)
    .pipe(Effect.orDie);
  return {
    ...instance,
    snapshot: {
      ...instance.snapshot,
      getSnapshot: instance.snapshot.getSnapshot.pipe(Effect.map(asInstalled)),
      refresh: instance.snapshot.refresh.pipe(Effect.map(asInstalled)),
      streamChanges: instance.snapshot.streamChanges.pipe(Stream.map(asInstalled)),
    },
    orchestrationAdapter: adapter,
    textGeneration: {
      ...instance.textGeneration,
      generateThreadTitle: () => Effect.succeed({ title: REPLAY_TITLE }),
    },
  };
});

/** One of t3's recorded fixtures, as its Claude variant replays it. */
export type LoadedReplay = {
  /** The fixture's Claude variant: its model and t3's own checks of the replay. */
  readonly variant: NonNullable<(typeof ORCHESTRATOR_REPLAY_FIXTURES)[number]['providers'][number]>;
  readonly transcript: ReplayTranscript;
  /** The fixture's first message. */
  readonly text: string;
  /** A git workspace of the fixture's own, with its files. */
  readonly cwd: string;
};

/** Reads the Claude variant of one of t3's fixtures and checks out its workspace. */
export const loadReplay = Effect.fn('loadReplay')(function* (name: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === name);
  const variant = fixture?.providers.find((provider) => provider.driver === 'claudeAgent');
  const input = fixture?.buildInput();
  const message = input?.steps.find((step) => step.type === 'message');
  if (variant === undefined || message?.type !== 'message') {
    return yield* Effect.die(new Error(`t3 has no Claude replay of ${name}`));
  }
  const recorded = yield* ProviderReplayFixtures.readReplayFixtureTranscript(
    variant.transcriptFile,
  );
  const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptRuntimeInstructions(recorded, {
      driver: variant.driver,
      model: variant.modelSelection.model,
    }),
  );
  const cwd = yield* checkpointWorkspace(name, input?.workspaceFiles);
  const loaded: LoadedReplay = { variant, transcript, text: message.text, cwd };
  return loaded;
});

export const sessionSpec = (
  name: string,
  cwd: string,
  modelSelection?: ModelSelection,
): SessionSpec => ({
  sessionId: `session-sprocket-${name}`,
  harness: 'claude',
  cwd,
  ...(modelSelection === undefined ? {} : { modelSelection }),
});

/** A thread's first message, as t3's chat sends it: its text seeds the thread's title. */
export const sendMessage = (
  spec: SessionSpec,
  text: string,
  modelSelection: ModelSelection,
): OrchestrationV2Command => ({
  type: 'message.dispatch',
  createdBy: 'user',
  creationSource: 'web',
  commandId: CommandId.make(`command:${spec.sessionId}:message-1`),
  threadId: ThreadId.make(spec.sessionId),
  messageId: MessageId.make(`message:${spec.sessionId}:1`),
  text,
  titleSeed: text,
  attachments: [],
  modelSelection,
  dispatchMode: { type: 'start_immediately' },
});

/**
 * Waits until the handle's snapshot satisfies `done`, reading only `snapshot()`: nothing
 * subscribes to the thread's events while it waits.
 */
export const waitForSnapshot = (
  handle: ThreadHandle,
  done: (projection: OrchestrationV2ThreadProjection) => boolean,
  timeout: Duration.Input = Duration.seconds(30),
) =>
  Effect.gen(function* () {
    while (!done(handle.snapshot())) yield* Effect.sleep(Duration.millis(10));
    return handle.snapshot();
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => {
        const { runs, turnItems } = handle.snapshot();
        const seen = `runs ${runs.map((run) => run.status)}, items ${turnItems.map((item) => (item.type === 'error' ? `error: ${item.failure.message}` : item.type))}`;
        return Effect.die(new Error(`the snapshot never got there: ${seen}`));
      },
    }),
  );

export const statuses = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.map((candidate) => candidate.status);
