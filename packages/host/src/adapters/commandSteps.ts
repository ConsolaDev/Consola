/**
 * `CommandSteps` on sandboxes (`AGENTS.md`, "Step sandboxes"): each attempt of a command step gets
 * a sandbox of its own from the `consola-session` template, which holds git, `gh` and Node. No
 * host runs there: the template's checkout script puts the repository at the step's commit (the
 * clone token in that command alone), the request's files are written under the attempt's folder,
 * and `bash -c` runs the command in the checkout with exactly the request's variables, its files'
 * paths and `CONSOLA_OUTPUT`, and nothing of the runner's. Its exit, its output's size and ends,
 * and the `key=value` lines it appended to `$CONSOLA_OUTPUT` come back with every secret masked
 * in every printed form. The sandbox is always stopped.
 */
import type { Sandbox, Sandboxes } from '@consola/sandbox';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import { MAX_ERROR_LENGTH, scrubSecrets } from '../core/runnerDecisions.ts';
import { MaskedTail, maskText } from '../core/steps/mask.ts';
import type { CommandStepRequest, CommandStepResult, CommandSteps } from '../core/steps/ports.ts';
import {
  COMMAND_OUTPUT_FILE,
  checkoutEnv,
  checkoutProblem,
  commandArgv,
  commandPlan,
  OUTPUT_FILE_CAP_BYTES,
  readConsolaOutput,
  STEP_REPO,
} from '../core/steps/stepSandbox.ts';
import { utf8Bytes } from '../core/steps/stepTools.ts';
import {
  attemptSandbox,
  messageOf,
  runCheckout,
  STEP_LIFETIME_MARGIN,
  sandboxCall,
} from './stepSandboxes.ts';
import type { StepSandboxOptions } from './stepSandboxes.ts';

export type CommandStepsOptions = Omit<StepSandboxOptions, 'log'> & {
  readonly sandboxes: Sandboxes;
  /** Every secret the runner holds, taken out of whatever it returns or logs. */
  readonly secretValues: readonly string[];
  /** A line for the runner's log; scrubbed here first. */
  readonly log: (message: string) => Effect.Effect<void>;
};

/** The signal a command the runner stopped (its timeout, an abort) is reported as ending by. */
const STOPPED_SIGNAL = 'SIGTERM';

/** Resolves once `signal` aborts (at once when it has). */
const aborted = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

export const makeCommandSteps = (options: CommandStepsOptions): CommandSteps => ({
  run: (request, signal) => Effect.runPromise(runCommandStep(options, request, signal)),
});

/** Makes the folder a step with no checkout runs in, empty. */
const emptyFolder = (sandbox: Sandbox) =>
  sandboxCall(
    () => sandbox.run({ argv: ['bash', '-c', 'mkdir -p -- "$1"', 'bash', STEP_REPO] }),
    "The step's folder was not made",
  );

/** One attempt of a command step, to its result; it never fails, and its sandbox is always stopped. */
export const runCommandStep = (
  options: CommandStepsOptions,
  request: CommandStepRequest,
  signal: AbortSignal,
): Effect.Effect<CommandStepResult> =>
  Effect.gen(function* () {
    const secrets = [
      ...options.secretValues,
      ...Object.values(request.secretEnv),
      ...(request.cloneToken === null ? [] : [request.cloneToken]),
    ];
    const scrub = (text: string) => maskText(scrubSecrets(text, secrets), secrets);
    const label = `step ${request.runId}/${request.stepId} attempt ${request.attempt}`;
    const log = (message: string) => options.log(scrub(message));
    const stdout = new MaskedTail(secrets);
    const stderr = new MaskedTail(secrets);

    const result = (
      exitCode: number | null,
      ended: string | null,
      error: string | null,
      outputs: Readonly<Record<string, string>> = {},
    ): CommandStepResult => {
      const out = stdout.end();
      const err = stderr.end();
      return {
        exitCode,
        signal: ended,
        error: error === null ? null : scrub(error).slice(0, MAX_ERROR_LENGTH),
        stdoutBytes: out.bytes,
        stderrBytes: err.bytes,
        output: { stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated },
        outputs,
      };
    };

    const plan = commandPlan(request);
    if (!plan.ok) return result(null, null, plan.problem);
    const problem = request.checkout === null ? null : checkoutProblem(request.checkout);
    if (problem !== null) return result(null, null, problem);

    const attempt = Effect.scoped(
      Effect.gen(function* () {
        const sandbox = yield* attemptSandbox(
          { ...options, log },
          label,
          Duration.sum(Duration.millis(request.timeoutMs), STEP_LIFETIME_MARGIN),
        );
        if (request.checkout === null) yield* emptyFolder(sandbox);
        else {
          yield* runCheckout(sandbox, checkoutEnv(request.checkout, request.cloneToken), secrets);
        }
        for (const file of plan.files) {
          yield* sandboxCall(
            () => sandbox.writeFile(file.path, file.content),
            "The step's files were not written",
          );
        }
        yield* sandboxCall(
          () => sandbox.writeFile(COMMAND_OUTPUT_FILE, ''),
          'Its $CONSOLA_OUTPUT was not made',
        );
        const ran = yield* sandboxCall(
          () =>
            sandbox.run({
              argv: commandArgv(request.command),
              cwd: plan.cwd,
              env: plan.env,
              keepOutput: false,
              onStdout: (chunk) => stdout.push(chunk),
              onStderr: (chunk) => stderr.push(chunk),
            }),
          "The step's command did not run",
        );
        const written = yield* sandboxCall(
          () => sandbox.readTextFile(COMMAND_OUTPUT_FILE),
          'unread',
        ).pipe(Effect.orElseSucceed(() => ''));
        if (utf8Bytes(written) > OUTPUT_FILE_CAP_BYTES) {
          return result(
            ran.exitCode,
            ran.exitCode === null ? STOPPED_SIGNAL : null,
            '$CONSOLA_OUTPUT is over 64 KB; long text belongs in an artifact.',
          );
        }
        return result(
          ran.exitCode,
          ran.exitCode === null ? STOPPED_SIGNAL : null,
          null,
          readConsolaOutput(maskText(written, secrets)),
        );
      }),
    ).pipe(
      Effect.catchTag('StepFailed', (error) => Effect.succeed(result(null, null, error.problem))),
      Effect.catchDefect((defect) =>
        log(`${label}: ${messageOf(defect)}`).pipe(
          Effect.as(result(null, null, 'The runner could not run the step.')),
        ),
      ),
    );

    const seconds = Math.round(request.timeoutMs / 1000);
    const outcome = yield* Effect.raceFirst(
      attempt.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(request.timeoutMs),
          orElse: () =>
            Effect.succeed(
              result(
                null,
                STOPPED_SIGNAL,
                `The step's command did not end within ${seconds} s, so its sandbox was stopped.`,
              ),
            ),
        }),
      ),
      aborted(signal).pipe(
        Effect.as(result(null, STOPPED_SIGNAL, 'The step was stopped, and its sandbox with it.')),
      ),
    );
    yield* log(
      `${label}: ${outcome.error === null ? `exited ${outcome.exitCode ?? outcome.signal}` : 'did not run to its end'}`,
    );
    return outcome;
  });
