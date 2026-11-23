/**
 * `consola-host session`, for tests only: the same command (`sessionCommand`, `runHostProcess`
 * from `../bin.ts`), its Claude driver replaying one of t3's recorded fixtures instead of running
 * a CLI. `bin.test.ts` starts it with node:
 *
 *   node src/testing/replaySession.ts <fixture> <runtime mode | default> session …
 *
 * It checks out the fixture's workspace and passes it as `--cwd`, and a state folder whose t3
 * settings check for no updates as `--state-dir` (the host titles threads with Claude itself). `default` keeps
 * the host's runtime mode; a fixture recorded in another (`simple` was recorded in `full-access`)
 * names it, or its first frame would not match the recording. With
 * `CONSOLA_TEST_SESSION_STOP=hangs`, the session's thread never finishes closing, as a provider
 * session whose stop hangs.
 */
import type { RuntimeMode } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { runHostProcess, sessionCommand } from '../bin.ts';
import * as ThreadRuntime from '../runtime/threadRuntime.ts';
import { loadReplay, replayClaudeDriver, withState } from './replay.ts';

const [fixture = '', mode = 'default', ...argv] = process.argv.slice(2);
const stopHangsForTests = process.env.CONSOLA_TEST_SESSION_STOP === 'hangs';

/** `runtime`, its threads' close hanging: each `open` leaves a finalizer that never returns. */
const withHangingStop = (
  runtime: Layer.Layer<ThreadRuntime.ThreadRuntime>,
): Layer.Layer<ThreadRuntime.ThreadRuntime> =>
  Layer.effect(
    ThreadRuntime.ThreadRuntime,
    Effect.map(Effect.service(ThreadRuntime.ThreadRuntime), (opened) =>
      ThreadRuntime.ThreadRuntime.of({
        open: Effect.fn('ThreadRuntime.openWithHangingStop')(function* (spec) {
          const handle = yield* opened.open(spec);
          yield* Effect.addFinalizer(() => Effect.never);
          return handle;
        }),
      }),
    ),
  ).pipe(Layer.provide(runtime));

runHostProcess(
  Effect.gen(function* () {
    const { transcript, cwd } = yield* loadReplay(fixture);
    return yield* withState((stateDir) =>
      sessionCommand([...argv, '--cwd', cwd, '--state-dir', stateDir], (options) => {
        const runtime = ThreadRuntime.layerForTests(options, {
          drivers: [replayClaudeDriver(transcript)],
          ...(mode === 'default' ? {} : { runtimeMode: mode as RuntimeMode }),
        });
        return stopHangsForTests ? withHangingStop(runtime) : runtime;
      }),
    );
  }).pipe(Effect.scoped),
);
