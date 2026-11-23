/**
 * The runner's sessions: each `session.start` the cell sends becomes a sandbox, made through
 * `@consola/sandbox`'s interface from the `consola-session` template, whose start script clones
 * the repository and runs `consola-host session` (`AGENTS.md`, "The `runner` command"). What the
 * session's host prints on stdout becomes the cell's `session.update`s (`runnerDecisions.ts`);
 * how its command ends becomes the session's end, said once. Every sandbox is stopped: on the
 * cell's stop, after the host's `exit` line and a grace, at the lifetime cap, when the command
 * ends, and when the runner stops (`stopAll`).
 */
import { isHostUrl, type SessionStart, type SessionUpdate } from '@consola/runner-protocol';
import type { Sandbox, Sandboxes } from '@consola/sandbox';
import type * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Queue from 'effect/Queue';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import {
  endOf,
  HostLineBuffer,
  offerRefusal,
  type RunnerOffer,
  readSessionLine,
  SESSION_START_ARGV,
  SESSION_TEMPLATE,
  StderrTail,
  type SandboxSecrets,
  sandboxEnvFor,
  scrubSecrets,
  scrubUpdate,
  updateForExit,
  updateForLine,
} from '../core/runnerDecisions.ts';

/**
 * How long after the host's `exit` line the runner stops the sandbox itself, should the host not
 * have ended: longer than the 15 seconds the host takes at most to stop (`runHostProcess`).
 */
export const EXIT_LINE_GRACE = Duration.seconds(30);

/** How long the runner waits for a command to end once it has stopped its sandbox. */
const STOPPED_COMMAND_WAIT = Duration.seconds(10);

export type SandboxSessionsOptions = {
  readonly sandboxes: Sandboxes;
  /** What the runner offers; a start for anything else is failed with no sandbox. */
  readonly offer: RunnerOffer;
  /** What a sandbox is given: the git token and its harness's API key. */
  readonly secrets: SandboxSecrets;
  /** Every secret the runner holds, taken out of whatever it reports or logs. */
  readonly secretValues: ReadonlyArray<string>;
  /** The host's idle minutes (`CONSOLA_SESSION_IDLE_MINUTES`). */
  readonly idleMinutes: number;
  /** The longest a session's sandbox runs: the runner stops it then, whatever it is doing. */
  readonly maxLifetime: Duration.Input;
  /** `EXIT_LINE_GRACE` unless a test shortens it. */
  readonly exitLineGrace?: Duration.Input;
  /** Where every update goes: the cell's socket. Each is scrubbed of the secrets first. */
  readonly report: (update: SessionUpdate) => Effect.Effect<void>;
  /** A line for the runner's own log. Scrubbed of the secrets, and never the environment. */
  readonly log: (message: string) => Effect.Effect<void>;
};

/** The sessions a runner holds now, for `hello` and what follows it. */
export type LiveSessions = {
  /** Every session not yet ended: its sandbox is being made, or runs. */
  readonly sessionIds: ReadonlyArray<string>;
  /** What the cell should know of each now: `running` and its address once ready, its title. */
  readonly states: ReadonlyArray<SessionUpdate>;
};

export type SandboxSessions = {
  /** Starts the session's sandbox in the background; a start for a session held is ignored. */
  readonly start: (start: SessionStart) => Effect.Effect<void>;
  /** The cell's stop: stops the session's sandbox, says `stopped`, returns once it has stopped. */
  readonly stop: (sessionId: string) => Effect.Effect<void>;
  readonly live: Effect.Effect<LiveSessions>;
  /** `live`, read now: the cell's socket reads it as it writes `hello`. */
  readonly liveNow: () => LiveSessions;
  /** Stops every sandbox, the runner stopping, and returns once each has stopped. */
  readonly stopAll: Effect.Effect<void>;
};

/** A call on a sandbox failed; `problem` is its message (the provider's own, for `provider`). */
class SandboxCallFailed extends Schema.TaggedError<SandboxCallFailed>()('SandboxCallFailed', {
  problem: Schema.String,
}) {
  override get message(): string {
    return this.problem;
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : String(error);

const attempt = <A>(call: () => Promise<A>): Effect.Effect<A, SandboxCallFailed> =>
  Effect.tryPromise({
    try: call,
    catch: (error) => new SandboxCallFailed({ problem: messageOf(error) }),
  });

/** Why the runner stops a session's sandbox, the first to come. */
type StopReason =
  | { readonly kind: 'cell' | 'lifetime' | 'exit-line' | 'shutdown' }
  /** Something the runner needs failed (exposing the port): the session fails with `error`. */
  | { readonly kind: 'failed'; readonly error: string };

type Held = {
  readonly start: SessionStart;
  readonly stopSignal: Deferred.Deferred<StopReason>;
  /** Done once the session's end is said and its sandbox stopped. */
  readonly done: Deferred.Deferred<boolean>;
  sandbox: Sandbox | null;
  /** Its end was said: nothing more is. */
  ended: boolean;
  ready: boolean;
  /** Its command has ended: the lines left are read, then the end is said. */
  ending: boolean;
  sawExitLine: boolean;
  hostUrl: string | null;
  title: string | null;
};

const COULD_NOT_RUN = 'The runner could not run the session.';

export const makeSandboxSessions = (
  options: SandboxSessionsOptions,
): Effect.Effect<SandboxSessions> =>
  Effect.sync(() => {
    const held = new Map<string, Held>();
    /** Set once `stopAll` began: a start after it would make a sandbox nothing stops. */
    let stopping = false;
    const exitLineGrace = options.exitLineGrace ?? EXIT_LINE_GRACE;
    const log = (message: string) => options.log(scrubSecrets(message, options.secretValues));

    /** Says `update` to the cell, unless the session's end was said; an end is said once. */
    const send = (session: Held, update: SessionUpdate): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (session.ended) return Effect.void;
        if (endOf(update) !== null) session.ended = true;
        if (update.title !== undefined) session.title = update.title;
        return options.report(scrubUpdate(update, options.secretValues));
      });

    const failedWith = (session: Held, error: string) =>
      send(session, {
        type: 'session.update',
        sessionId: session.start.sessionId,
        status: 'failed',
        error,
      });

    const stopSandbox = (session: Held): Effect.Effect<void> => {
      const sandbox = session.sandbox;
      if (sandbox === null) return Effect.void;
      return attempt(() => sandbox.stop()).pipe(
        Effect.catchTag('SandboxCallFailed', (error) =>
          log(`session ${session.start.sessionId}: its sandbox did not stop: ${error.problem}`),
        ),
      );
    };

    /** `ready`: the port it names is exposed, and the cell told the session runs there. */
    const becomeReady = (session: Held, sandbox: Sandbox, port: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (session.ready) return;
        const refuse = (error: string) =>
          // Once the command has ended the session's end says what happened; nothing to stop.
          session.ending
            ? log(`session ${session.start.sessionId}: port ${port} not exposed: ${error}`)
            : Deferred.succeed(session.stopSignal, { kind: 'failed', error }).pipe(Effect.asVoid);
        const exposed = yield* attempt(() => sandbox.exposePort(port)).pipe(
          Effect.catchTag('SandboxCallFailed', (error) =>
            refuse(error.problem).pipe(Effect.as(null)),
          ),
        );
        if (exposed === null) return;
        if (!isHostUrl(exposed.url)) {
          return yield* refuse(
            "The sandbox exposed the session's port at an address the cell does not take.",
          );
        }
        session.ready = true;
        session.hostUrl = exposed.url;
        yield* send(session, {
          type: 'session.update',
          sessionId: session.start.sessionId,
          status: 'running',
          hostUrl: exposed.url,
        });
      });

    const onLine = (session: Held, sandbox: Sandbox, text: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const read = readSessionLine(text);
        if (read.kind === 'host' && read.line.type === 'ready') {
          return becomeReady(session, sandbox, read.line.port);
        }
        if (read.kind === 'host' && read.line.type === 'exit') {
          if (session.sawExitLine) return Effect.void;
          session.sawExitLine = true;
          // A backstop: the host ends by itself after its exit line. Interrupted once the
          // command's lines are all read, which is once it has ended.
          return Effect.sleep(exitLineGrace).pipe(
            Effect.andThen(Deferred.succeed(session.stopSignal, { kind: 'exit-line' })),
            Effect.forkChild,
            Effect.asVoid,
          );
        }
        const update = updateForLine(session.start.sessionId, text);
        return update === null ? Effect.void : send(session, update);
      });

    /** Reads the command's stdout, line by line, until the command has ended and all is read. */
    const readLines = (
      session: Held,
      sandbox: Sandbox,
      chunks: Queue.Queue<string, Cause.Done>,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const lines = new HostLineBuffer();
        return Stream.fromQueue(chunks).pipe(
          Stream.runForEach((chunk) =>
            Effect.forEach(lines.push(chunk), (text) => onLine(session, sandbox, text), {
              discard: true,
            }),
          ),
        );
      });

    const runSession = (session: Held): Effect.Effect<void> => {
      const { sessionId } = session.start;
      return Effect.gen(function* () {
        const refusal = offerRefusal(options.offer, session.start);
        if (refusal !== null) return yield* failedWith(session, refusal);
        yield* Effect.sleep(options.maxLifetime).pipe(
          Effect.andThen(Deferred.succeed(session.stopSignal, { kind: 'lifetime' })),
          Effect.forkChild,
        );
        const sandbox = yield* attempt(() =>
          options.sandboxes.create({
            template: SESSION_TEMPLATE,
            env: sandboxEnvFor(session.start, options.secrets, options.idleMinutes),
          }),
        );
        session.sandbox = sandbox;
        yield* log(`session ${sessionId}: sandbox ${sandbox.id} created`);

        // A stop that came while the sandbox was being made: nothing is started in it.
        if (yield* Deferred.isDone(session.stopSignal)) {
          const reason = yield* Deferred.await(session.stopSignal);
          if (reason.kind === 'failed') return yield* failedWith(session, reason.error);
          return yield* send(
            session,
            updateForExit(sessionId, {
              exitCode: null,
              sawExitLine: false,
              stoppedByRunner: true,
              lastStderrLine: null,
              ready: false,
              stopRequested: reason.kind === 'cell',
            }),
          );
        }

        const chunks = yield* Queue.unbounded<string, Cause.Done>();
        const stderr = new StderrTail(options.secretValues);
        const command = yield* attempt(() =>
          sandbox.start({
            argv: [...SESSION_START_ARGV],
            keepOutput: false,
            onStdout: (chunk) => {
              Queue.offerUnsafe(chunks, chunk);
            },
            onStderr: (chunk) => stderr.push(chunk),
          }),
        );
        const reading = yield* readLines(session, sandbox, chunks).pipe(Effect.forkChild);

        const outcome = yield* Effect.raceFirst(
          attempt(() => command.wait()).pipe(
            Effect.map((result) => ({ stop: null, exitCode: result.exitCode })),
          ),
          Deferred.await(session.stopSignal).pipe(
            Effect.map((reason): { stop: StopReason; exitCode: null } => ({
              stop: reason,
              exitCode: null,
            })),
          ),
        );
        let exitCode = outcome.exitCode;
        if (outcome.stop !== null) {
          yield* log(`session ${sessionId}: stopping its sandbox (${outcome.stop.kind})`);
          yield* stopSandbox(session);
          exitCode = yield* attempt(() => command.wait()).pipe(
            Effect.map((result) => result.exitCode),
            Effect.timeoutOrElse({
              duration: STOPPED_COMMAND_WAIT,
              orElse: () => Effect.succeed(null),
            }),
            Effect.catchTag('SandboxCallFailed', () => Effect.succeed(null)),
          );
        }

        // All of the command's output has arrived by now: read the rest, then say the end.
        session.ending = true;
        Queue.endUnsafe(chunks);
        yield* Fiber.join(reading);
        const reason = outcome.stop;
        if (reason?.kind === 'failed') return yield* failedWith(session, reason.error);
        yield* send(
          session,
          updateForExit(sessionId, {
            exitCode,
            sawExitLine: session.sawExitLine,
            stoppedByRunner: reason !== null,
            lastStderrLine: stderr.lastLine(),
            ready: session.ready,
            stopRequested: reason?.kind === 'cell',
          }),
        );
      }).pipe(
        Effect.catchTag('SandboxCallFailed', (error) => failedWith(session, error.problem)),
        Effect.catchDefect((defect) =>
          log(`session ${sessionId}: ${messageOf(defect)}`).pipe(
            Effect.andThen(failedWith(session, COULD_NOT_RUN)),
          ),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            // An end is always said, and the sandbox always stopped, whatever happened above.
            yield* failedWith(session, COULD_NOT_RUN);
            yield* stopSandbox(session);
            held.delete(sessionId);
            yield* log(`session ${sessionId}: ended`);
            yield* Deferred.succeed(session.done, true);
          }),
        ),
      );
    };

    const liveNow = (): LiveSessions => {
      const open = [...held.values()].filter((session) => !session.ended);
      return {
        sessionIds: open.map((session) => session.start.sessionId),
        states: open.flatMap((session) => {
          const state: SessionUpdate = {
            type: 'session.update',
            sessionId: session.start.sessionId,
          };
          if (session.ready && session.hostUrl !== null) {
            state.status = 'running';
            state.hostUrl = session.hostUrl;
          }
          if (session.title !== null) state.title = session.title;
          return state.status === undefined && state.title === undefined
            ? []
            : [scrubUpdate(state, options.secretValues)];
        }),
      };
    };

    const sessions: SandboxSessions = {
      start: Effect.fn('SandboxSessions.start')(function* (start: SessionStart) {
        if (stopping) {
          return yield* options.report({
            type: 'session.update',
            sessionId: start.sessionId,
            status: 'failed',
            error: 'The runner is stopping, so it started no sandbox for the session.',
          });
        }
        if (held.has(start.sessionId)) {
          return yield* log(`session ${start.sessionId}: started already; the start is ignored`);
        }
        const session: Held = {
          start,
          stopSignal: yield* Deferred.make<StopReason>(),
          done: yield* Deferred.make<boolean>(),
          sandbox: null,
          ended: false,
          ready: false,
          ending: false,
          sawExitLine: false,
          hostUrl: null,
          title: null,
        };
        held.set(start.sessionId, session);
        yield* log(`session ${start.sessionId}: starting (${start.harness}, ${start.repository})`);
        yield* runSession(session).pipe(Effect.forkDetach);
      }),
      stop: Effect.fn('SandboxSessions.stop')(function* (sessionId: string) {
        const session = held.get(sessionId);
        if (session === undefined) return;
        yield* Deferred.succeed(session.stopSignal, { kind: 'cell' });
        yield* Deferred.await(session.done);
      }),
      live: Effect.sync(liveNow),
      liveNow,
      stopAll: Effect.gen(function* () {
        stopping = true;
        const all = [...held.values()];
        yield* Effect.forEach(
          all,
          (session) => Deferred.succeed(session.stopSignal, { kind: 'shutdown' }),
          { discard: true },
        );
        yield* Effect.forEach(all, (session) => Deferred.await(session.done), {
          discard: true,
          concurrency: 'unbounded',
        });
      }),
    };
    return sessions;
  });
