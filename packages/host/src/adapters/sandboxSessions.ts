/**
 * The runner's sessions: each `session.start` the cell sends becomes a sandbox, made through
 * `@consola/sandbox`'s interface from the `consola-session` template, whose start script clones
 * the repository and runs `consola-host session` (`AGENTS.md`, "The `runner` command"). What the
 * session's host prints on stdout becomes the cell's `session.update`s (`runnerDecisions.ts`);
 * how its command ends becomes the session's end, said once. Every sandbox is stopped: on the
 * cell's stop, after the host's `exit` line and a grace, at the lifetime cap (a stop's length
 * before it), when the command ends, as soon as the session's end is said while its command runs
 * on (a failed clone), and when the runner stops (`stopAll`). And its provider stops it should
 * the runner not: each sandbox is leased for `SANDBOX_LEASE_SECONDS` and renewed while the runner
 * holds it, never past the cap.
 */
import { isHostUrl } from '@consola/runner-protocol';
import type { SessionStart, SessionUpdate } from '@consola/runner-protocol';
import type { Sandbox, Sandboxes } from '@consola/sandbox';
import type * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
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
  lifetimeStopAfterMs,
  offerRefusal,
  readSessionLine,
  SANDBOX_LEASE_RENEW_SECONDS,
  SANDBOX_LEASE_SECONDS,
  SESSION_START_ARGV,
  SESSION_TEMPLATE,
  StderrTail,
  sandboxEnvFor,
  sandboxLifetimeSeconds,
  scrubSecrets,
  scrubUpdate,
  updateForExit,
  updateForLine,
} from '../core/runnerDecisions.ts';
import type { RunnerOffer, SandboxSecrets } from '../core/runnerDecisions.ts';

/**
 * How long after the host's `exit` line the runner stops the sandbox itself, should the host not
 * have ended: longer than the 15 seconds the host takes at most to stop (`runHostProcess`).
 */
export const EXIT_LINE_GRACE = Duration.seconds(30);

/**
 * How long the runner waits for a command to end once it has stopped its sandbox, and no later
 * than the shutdown's bound once the runner is stopping.
 */
const STOPPED_COMMAND_WAIT = Duration.seconds(10);

/**
 * How long a provider's call that makes or reaches a sandbox may take (`create`, `start`,
 * `exposePort`; E2B's are network calls) before the session is failed. A provider's call cannot
 * be cancelled: a sandbox made after its create timed out is stopped as it arrives.
 */
export const SANDBOX_CALL_TIMEOUT = Duration.seconds(60);

/**
 * How long a sandbox's `stop` may take before the runner goes on without it, so that a provider
 * that hangs never keeps a session's end from being said. The runner's stop for the lifetime cap
 * begins this long before it, so it comes before the provider's own and is over by the cap
 * (`lifetimeStopAfterMs`).
 */
export const SANDBOX_STOP_TIMEOUT = Duration.seconds(30);

/**
 * How long, from the moment the runner began stopping, a sandbox's `stop` and the wait for its
 * command may take, however late each of them begins: under the host's 15 s shutdown grace
 * (`runHostProcess`) less the 3 s the socket's close waits, so the socket closes and the process
 * exits on its own. Every end is said before this wait.
 */
export const SHUTDOWN_STOP_TIMEOUT = Duration.seconds(10);

/** How many times a sandbox's stop is asked, a failed one again after a doubling backoff. */
export const STOP_ATTEMPTS = 3;
const STOP_RETRY_BACKOFF = Duration.millis(500);

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
  /**
   * The longest a session's sandbox runs. Its provider stops it then; the runner stops it first,
   * whatever it is doing, a stop's length before (`lifetimeStopAfterMs`).
   */
  readonly maxLifetime: Duration.Input;
  /** `EXIT_LINE_GRACE` unless a test shortens it. */
  readonly exitLineGrace?: Duration.Input;
  /** `SANDBOX_STOP_TIMEOUT` unless a test shortens it; the lead of the lifetime stop too. */
  readonly stopTimeout?: Duration.Input;
  /** `SHUTDOWN_STOP_TIMEOUT` unless a test shortens it. */
  readonly shutdownStopTimeout?: Duration.Input;
  /** `SANDBOX_CALL_TIMEOUT` unless a test shortens it. */
  readonly callTimeout?: Duration.Input;
  /** `SANDBOX_LEASE_RENEW_SECONDS` unless a test shortens it. */
  readonly leaseRenewEvery?: Duration.Input;
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
  /** `ended`: the session's end was said while its command ran on (a failed clone, say). */
  | { readonly kind: 'cell' | 'lifetime' | 'exit-line' | 'shutdown' | 'ended' }
  /** Something the runner needs failed (exposing the port): the session fails with `error`. */
  | { readonly kind: 'failed'; readonly error: string };

type Held = {
  readonly start: SessionStart;
  readonly stopSignal: Deferred.Deferred<StopReason>;
  /** Done once the session's end is said and its sandbox stopped. */
  readonly done: Deferred.Deferred<boolean>;
  sandbox: Sandbox | null;
  /** Its sandbox's stop was asked for: it is asked once. */
  stopAsked: boolean;
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
    /**
     * Set once `stopAll` began, to `shutdownStopTimeout` after that moment (epoch milliseconds):
     * every sandbox's stop, and every wait for a command, ends by then.
     */
    const shutdownDeadline = Deferred.makeUnsafe<number>();
    const exitLineGrace = options.exitLineGrace ?? EXIT_LINE_GRACE;
    const stopTimeout = options.stopTimeout ?? SANDBOX_STOP_TIMEOUT;
    const shutdownStopTimeout = options.shutdownStopTimeout ?? SHUTDOWN_STOP_TIMEOUT;
    const callTimeout = options.callTimeout ?? SANDBOX_CALL_TIMEOUT;
    const leaseRenewEvery =
      options.leaseRenewEvery ?? Duration.seconds(SANDBOX_LEASE_RENEW_SECONDS);
    /** A provider that renews a lifetime leases its sandboxes; any other gets the whole cap. */
    const keepAlive = options.sandboxes.keepAlive;
    const leaseSeconds = keepAlive === undefined ? null : SANDBOX_LEASE_SECONDS;
    const log = (message: string) => options.log(scrubSecrets(message, options.secretValues));

    /** Returns at the shutdown's deadline, once the runner began stopping; never before. */
    const untilShutdownDeadline = Deferred.await(shutdownDeadline).pipe(
      Effect.flatMap((deadline) =>
        Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
          Effect.sleep(Duration.millis(Math.max(0, deadline - nowMs))),
        ),
      ),
    );

    /**
     * A provider's call, failed with `problem` once it has taken `callTimeout`. The call itself
     * runs on (a provider cannot be told to stop one), so what it answers late goes to `late`.
     */
    const withinCallTimeout = <A>(
      call: () => Promise<A>,
      problem: string,
      late: (value: A) => Effect.Effect<void> = () => Effect.void,
    ): Effect.Effect<A, SandboxCallFailed> =>
      Effect.suspend(() => {
        // Called once, whether it answers in time or late; one that throws fails as it rejects.
        let pending: Promise<A>;
        try {
          pending = call();
        } catch (error) {
          pending = Promise.reject(error);
        }
        return attempt(() => pending).pipe(
          Effect.timeoutOrElse({
            duration: callTimeout,
            orElse: () =>
              attempt(() => pending).pipe(
                Effect.flatMap(late),
                Effect.ignore,
                Effect.forkDetach,
                Effect.andThen(Effect.fail(new SandboxCallFailed({ problem }))),
              ),
          }),
        );
      });
    const withinCallTimeoutText = `within ${Duration.toSeconds(callTimeout)} s`;

    /**
     * Says `update` to the cell, unless the session's end was said; an end is said once. An end
     * said while the session's command still runs stops its sandbox: once ended, the session is in
     * no `hello`, so the cell could never ask for that stop.
     */
    const send = (session: Held, update: SessionUpdate): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (session.ended) return Effect.void;
        const isEnd = endOf(update) !== null;
        if (isEnd) session.ended = true;
        if (update.title !== undefined) session.title = update.title;
        const said = options.report(scrubUpdate(update, options.secretValues));
        if (!isEnd || session.ending) return said;
        return said.pipe(
          Effect.andThen(Deferred.succeed(session.stopSignal, { kind: 'ended' })),
          Effect.asVoid,
        );
      });

    const failedWith = (session: Held, error: string) =>
      send(session, {
        type: 'session.update',
        sessionId: session.start.sessionId,
        status: 'failed',
        error,
      });

    /**
     * Stops the session's sandbox, once per session: a stop that fails is asked again, up to
     * `STOP_ATTEMPTS` times, each failure logged with its reason. All of it within `stopTimeout`,
     * and by the shutdown's deadline (`shutdownStopTimeout` after the runner began stopping, so
     * a stop that begins late gets what is left), whichever ends first; past it the session goes
     * on to say its end. Answers whether the sandbox stopped.
     */
    const stopSandbox = (session: Held): Effect.Effect<boolean> => {
      const sandbox = session.sandbox;
      if (sandbox === null || session.stopAsked) return Effect.succeed(false);
      session.stopAsked = true;
      const { sessionId } = session.start;
      const asking = Effect.gen(function* () {
        for (let asked = 1; ; asked += 1) {
          const problem = yield* attempt(() => sandbox.stop()).pipe(
            Effect.as(null),
            Effect.catchTag('SandboxCallFailed', (error) => Effect.succeed(error.problem)),
          );
          if (problem === null) return true;
          yield* log(
            `session ${sessionId}: its sandbox did not stop (attempt ${asked} of ${STOP_ATTEMPTS}): ${problem}`,
          );
          if (asked >= STOP_ATTEMPTS) return false;
          yield* Effect.sleep(Duration.times(STOP_RETRY_BACKOFF, 2 ** (asked - 1)));
        }
      });
      const outOfTime = (within: string) =>
        log(
          `session ${sessionId}: its sandbox did not stop ${within}; the runner goes on without it`,
        ).pipe(Effect.as(false));
      return Effect.raceFirst(
        asking,
        untilShutdownDeadline.pipe(
          Effect.andThen(
            outOfTime(`within ${Duration.toSeconds(shutdownStopTimeout)} s of the runner stopping`),
          ),
        ),
      ).pipe(
        Effect.timeoutOrElse({
          duration: stopTimeout,
          orElse: () => outOfTime(`within ${Duration.toSeconds(stopTimeout)} s`),
        }),
      );
    };

    /** `ready`: the port it names is exposed, and the cell told the session runs there. */
    const becomeReady = (session: Held, sandbox: Sandbox, port: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        // An ended session is not exposed: its sandbox is stopping.
        if (session.ready || session.ended) return;
        const refuse = (error: string) =>
          // Once the command has ended the session's end says what happened; nothing to stop.
          session.ending
            ? log(`session ${session.start.sessionId}: port ${port} not exposed: ${error}`)
            : Deferred.succeed(session.stopSignal, { kind: 'failed', error }).pipe(Effect.asVoid);
        const exposed = yield* withinCallTimeout(
          () => sandbox.exposePort(port),
          `The sandbox did not expose the session's port ${withinCallTimeoutText}.`,
        ).pipe(
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
        // The start script prints it before the host runs, never after the host said `ready`.
        if (read.kind === 'clone-failed' && session.ready) {
          return log(
            `session ${session.start.sessionId}: a clone-failed line after ready, ignored`,
          );
        }
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

    /**
     * Renews the lease of the session's sandbox every `leaseRenewEvery` (never past the cap,
     * `capAtMs`) until the runner asks it to stop. Each renewal is a fiber of its own, so one
     * that hangs (up to `callTimeout`) never holds back the next: they are asked at a fixed
     * rate, and the lease runs out only after three in a row fail. A renewal that fails is logged.
     */
    const renewLease = (session: Held, sandbox: Sandbox, capAtMs: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (keepAlive === undefined) return;
        const { sessionId } = session.start;
        while (true) {
          yield* Effect.sleep(leaseRenewEvery);
          if (session.stopAsked || (yield* Deferred.isDone(session.stopSignal))) return;
          const nowMs = yield* Clock.currentTimeMillis;
          const seconds = sandboxLifetimeSeconds(capAtMs - nowMs, leaseSeconds);
          yield* withinCallTimeout(
            () => keepAlive.renew(sandbox, seconds),
            `it did not answer ${withinCallTimeoutText}`,
          ).pipe(
            Effect.catchTag('SandboxCallFailed', (error) =>
              log(`session ${sessionId}: its sandbox's lease was not renewed: ${error.problem}`),
            ),
            Effect.forkChild,
          );
        }
      });

    const runSession = (session: Held): Effect.Effect<void> => {
      const { sessionId } = session.start;
      return Effect.gen(function* () {
        const refusal = offerRefusal(options.offer, session.start);
        if (refusal !== null) return yield* failedWith(session, refusal);
        const maxLifetimeMs = Duration.toMillis(options.maxLifetime);
        const capAtMs = (yield* Clock.currentTimeMillis) + maxLifetimeMs;
        // The runner's own stop comes first, so the session ends `stopped`, never as a sandbox
        // its provider ended at the cap.
        yield* Effect.sleep(
          Duration.millis(lifetimeStopAfterMs(maxLifetimeMs, Duration.toMillis(stopTimeout))),
        ).pipe(
          Effect.andThen(Deferred.succeed(session.stopSignal, { kind: 'lifetime' })),
          Effect.forkChild,
        );
        // Its provider's own stop: the lease, renewed below, never past the cap.
        const lifetimeSeconds = sandboxLifetimeSeconds(
          capAtMs - (yield* Clock.currentTimeMillis),
          leaseSeconds,
        );
        const sandbox = yield* withinCallTimeout(
          () =>
            options.sandboxes.create({
              template: SESSION_TEMPLATE,
              env: sandboxEnvFor(session.start, options.secrets, options.idleMinutes),
              lifetimeSeconds,
              // The browser reaches the host at the exposed address, and a browser's WebSocket
              // cannot carry a provider's credential: the host guards its port with a pass, then
              // a ticket. This opens every port in the sandbox, until a gateway stands in front
              // (Linear: "10.5 A session gateway: sandboxes stay private, the browser reaches the
              // host through Consola", https://linear.app/consola/issue/CON-105).
              publicPorts: true,
            }),
          `The sandbox was not made ${withinCallTimeoutText}.`,
          // Made after all: nothing will use it, and nothing else would stop it.
          (late) =>
            log(
              `session ${sessionId}: its sandbox was made after its create timed out; it is stopped`,
            ).pipe(
              Effect.andThen(attempt(() => late.stop())),
              Effect.catchTag('SandboxCallFailed', (error) =>
                log(`session ${sessionId}: that sandbox did not stop: ${error.problem}`),
              ),
            ),
        );
        session.sandbox = sandbox;
        yield* log(`session ${sessionId}: sandbox ${sandbox.id} created`);
        yield* renewLease(session, sandbox, capAtMs).pipe(Effect.forkChild);

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
        const command = yield* withinCallTimeout(
          () =>
            sandbox.start({
              argv: [...SESSION_START_ARGV],
              keepOutput: false,
              onStdout: (chunk) => {
                Queue.offerUnsafe(chunks, chunk);
              },
              onStderr: (chunk) => stderr.push(chunk),
            }),
          `The sandbox did not start the session ${withinCallTimeoutText}.`,
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
          // The runner stopping: the end goes first, while the socket is open, whatever the
          // sandbox's stop then does (the process has its shutdown grace, and no more).
          if (outcome.stop.kind === 'shutdown') {
            yield* send(
              session,
              updateForExit(sessionId, {
                exitCode: null,
                sawExitLine: session.sawExitLine,
                stoppedByRunner: true,
                lastStderrLine: stderr.lastLine(),
                ready: session.ready,
                stopRequested: false,
              }),
            );
          }
          // A sandbox that did not stop may run its command on, and a session whose end is said
          // needs no exit code: neither is waited for.
          const stopped = yield* stopSandbox(session);
          exitCode =
            stopped && !session.ended
              ? yield* Effect.raceFirst(
                  attempt(() => command.wait()).pipe(
                    Effect.map((result): number | null => result.exitCode),
                    Effect.timeoutOrElse({
                      duration: STOPPED_COMMAND_WAIT,
                      orElse: () => Effect.succeed(null),
                    }),
                    Effect.catchTag('SandboxCallFailed', () => Effect.succeed(null)),
                  ),
                  untilShutdownDeadline.pipe(Effect.as(null)),
                )
              : null;
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
            // An end is always said, and the sandbox's stop always asked for, whatever happened
            // above (unless it was asked for already).
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
          stopAsked: false,
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
        const nowMs = yield* Clock.currentTimeMillis;
        yield* Deferred.succeed(shutdownDeadline, nowMs + Duration.toMillis(shutdownStopTimeout));
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
