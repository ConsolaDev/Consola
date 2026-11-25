/**
 * A step attempt's sandbox, as `sandboxSessions.ts` keeps a session's: made from the
 * `consola-session` template with no variables of its own (each command brings its own), its
 * provider's calls bounded, leased for `SANDBOX_LEASE_SECONDS` and renewed while the attempt runs
 * (never past its cap), and always stopped as the attempt's scope closes, however it ends: done,
 * failed, timed out or aborted. Shared by `agentSteps.ts` and `commandSteps.ts`.
 */
import type { Sandbox, Sandboxes } from '@consola/sandbox';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import type * as Scope from 'effect/Scope';
import {
  HostLineBuffer,
  readSessionLine,
  StderrTail,
  SANDBOX_LEASE_RENEW_SECONDS,
  SANDBOX_LEASE_SECONDS,
  sandboxLifetimeSeconds,
} from '../core/runnerDecisions.ts';
import { STEP_CHECKOUT_ARGV, STEP_TEMPLATE } from '../core/steps/stepSandbox.ts';

/** How long a provider's call that makes or reaches a sandbox may take, as for a session's. */
export const STEP_CALL_TIMEOUT = Duration.seconds(60);
/** How long a sandbox's stop may take before the attempt goes on without it. */
export const STEP_STOP_TIMEOUT = Duration.seconds(30);
/** How far past its timeout an attempt's sandbox may live: its provider's backstop. */
export const STEP_LIFETIME_MARGIN = Duration.minutes(2);
const STOP_ATTEMPTS = 3;

/** The attempt could not go on; `problem` is one sentence for its result, scrubbed later. */
export class StepFailed extends Schema.TaggedError<StepFailed>()('StepFailed', {
  problem: Schema.String,
}) {
  override get message(): string {
    return this.problem;
  }
}

export const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : String(error);

/** A provider's call, as a `StepFailed` with `problem` (and the provider's words) when it fails. */
export const sandboxCall = <A>(
  call: () => Promise<A>,
  problem: string,
): Effect.Effect<A, StepFailed> =>
  Effect.tryPromise({
    try: call,
    catch: (error) => new StepFailed({ problem: `${problem}: ${messageOf(error)}` }),
  });

export type StepSandboxOptions = {
  readonly sandboxes: Sandboxes;
  /** A line for the runner's log; the caller scrubs it. */
  readonly log: (message: string) => Effect.Effect<void>;
  /** `STEP_CALL_TIMEOUT` unless a test shortens it. */
  readonly callTimeout?: Duration.Input;
  /** `STEP_STOP_TIMEOUT` unless a test shortens it. */
  readonly stopTimeout?: Duration.Input;
  /** `SANDBOX_LEASE_RENEW_SECONDS` unless a test shortens it. */
  readonly leaseRenewEvery?: Duration.Input;
};

/**
 * The attempt's sandbox, in the caller's scope: made within `callTimeout` (one made after that is
 * stopped as it arrives), leased and renewed until the scope closes, never past `cap` from now,
 * and stopped then (asked up to three times, within `stopTimeout`, each failure logged).
 */
export const attemptSandbox = (
  options: StepSandboxOptions,
  label: string,
  cap: Duration.Input,
): Effect.Effect<Sandbox, StepFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const callTimeout = options.callTimeout ?? STEP_CALL_TIMEOUT;
    const stopTimeout = options.stopTimeout ?? STEP_STOP_TIMEOUT;
    const keepAlive = options.sandboxes.keepAlive;
    const leaseSeconds = keepAlive === undefined ? null : SANDBOX_LEASE_SECONDS;
    const capAtMs = (yield* Clock.currentTimeMillis) + Duration.toMillis(cap);
    const lifetimeSeconds = sandboxLifetimeSeconds(
      capAtMs - (yield* Clock.currentTimeMillis),
      leaseSeconds,
    );

    const stop = Effect.fn('StepSandbox.stop')(
      function* (sandbox: Sandbox) {
        for (let asked = 1; asked <= STOP_ATTEMPTS; asked += 1) {
          const problem = yield* sandboxCall(() => sandbox.stop(), 'not stopped').pipe(
            Effect.as(null),
            Effect.catchTag('StepFailed', (error) => Effect.succeed(error.problem)),
          );
          if (problem === null) return;
          yield* options.log(
            `${label}: its sandbox did not stop (attempt ${asked} of ${STOP_ATTEMPTS}): ${problem}`,
          );
          yield* Effect.sleep(Duration.millis(500 * 2 ** (asked - 1)));
        }
      },
      Effect.timeoutOrElse({
        duration: stopTimeout,
        orElse: () =>
          options.log(
            `${label}: its sandbox did not stop within ${Duration.toSeconds(stopTimeout)} s`,
          ),
      }),
    );

    const sandbox = yield* Effect.acquireRelease(
      Effect.suspend(() => {
        const pending = options.sandboxes.create({
          template: STEP_TEMPLATE,
          env: {},
          lifetimeSeconds,
          // The runner reaches the step's host at the exposed address, and a browser-style socket
          // carries no provider credential: the host guards its port itself (a pass the runner
          // signs, then a ticket), as a session's does. This opens every port in the sandbox.
          publicPorts: true,
        });
        return sandboxCall(() => pending, "The step's sandbox was not made").pipe(
          Effect.timeoutOrElse({
            duration: callTimeout,
            orElse: () => {
              // Made after all: nothing will use it, and nothing else would stop it.
              void pending.then((late) => late.stop()).catch(() => undefined);
              return Effect.fail(
                new StepFailed({
                  problem: `The step's sandbox was not made within ${Duration.toSeconds(callTimeout)} s.`,
                }),
              );
            },
          }),
        );
      }),
      (made) => stop(made),
    );
    yield* options.log(`${label}: sandbox ${sandbox.id} created`);

    if (keepAlive !== undefined) {
      const every = options.leaseRenewEvery ?? Duration.seconds(SANDBOX_LEASE_RENEW_SECONDS);
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(every);
          const nowMs = yield* Clock.currentTimeMillis;
          const seconds = sandboxLifetimeSeconds(capAtMs - nowMs, leaseSeconds);
          yield* sandboxCall(() => keepAlive.renew(sandbox, seconds), 'not renewed').pipe(
            Effect.timeout(callTimeout),
            Effect.catch((error) =>
              options.log(`${label}: its sandbox's lease was not renewed: ${messageOf(error)}`),
            ),
            Effect.forkScoped,
          );
        }
      }).pipe(Effect.forkScoped);
    }
    return sandbox;
  });

/**
 * Runs the template's checkout script with `env`. A failure is its `clone-failed` line's message,
 * or the last line it wrote on stderr, scrubbed.
 */
export const runCheckout = (
  sandbox: Sandbox,
  env: Readonly<Record<string, string>>,
  secrets: ReadonlyArray<string>,
): Effect.Effect<void, StepFailed> =>
  Effect.gen(function* () {
    const stderr = new StderrTail(secrets);
    const ran = yield* sandboxCall(
      () =>
        sandbox.run({
          argv: [...STEP_CHECKOUT_ARGV],
          env,
          onStderr: (chunk) => stderr.push(chunk),
        }),
      "The step's checkout did not run",
    );
    if (ran.exitCode === 0) return;
    const lines = new HostLineBuffer().push(`${ran.stdout}\n`);
    const said = lines.map(readSessionLine).find((line) => line.kind === 'clone-failed');
    const why =
      said?.kind === 'clone-failed'
        ? said.message
        : (stderr.lastLine() ??
          `The step's checkout ${ran.exitCode === null ? 'was stopped' : `exited with code ${ran.exitCode}`}.`);
    return yield* new StepFailed({ problem: why });
  });
