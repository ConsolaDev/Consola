/**
 * `AgentSteps` on sandboxes (`AGENTS.md`, "Step sandboxes"): each attempt of an agent step gets a
 * sandbox of its own from the `consola-session` template, where the template's checkout script
 * puts the repository at the step's commit (`consola-step-checkout`), and its start script runs the
 * host, `consola-host session`, on Claude, with the step tools as an MCP server in Claude's own
 * config (`consola-step-start`). The runner is the host's only client (`stepHostClient.ts`): it
 * sends the step's prompt, answers every permission request by the step's policy
 * (`decideStepApproval`) the moment it sees it, waits for the turn to end, reads the step's folder
 * out and checks it again itself, reminds the agent once of what is missing, and stops the sandbox
 * however the attempt ends. Every secret it holds is taken out of what it returns.
 */
import type { Harness } from '@consola/runner-protocol';
import type { Sandbox, Sandboxes } from '@consola/sandbox';
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from '@t3tools/contracts';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import {
  HostLineBuffer,
  MAX_ERROR_LENGTH,
  readSessionLine,
  StderrTail,
  scrubSecrets,
} from '../core/runnerDecisions.ts';
import { MaskedTail, maskText, outputTailOf } from '../core/steps/mask.ts';
import type {
  AgentStepRequest,
  AgentStepResult,
  AgentSteps,
  StepDocument,
} from '../core/steps/ports.ts';
import { decideStepApproval, pendingStepRequests } from '../core/steps/stepApproval.ts';
import {
  artifactFile,
  checkStepFolder,
  declarationOf,
  declarationText,
  DECLARATION_FILE,
  type MissingFromStep,
  missingFrom,
  missingSentence,
  nothingMissing,
  OUTPUTS_FILE,
} from '../core/steps/stepFolder.ts';
import {
  CHANGES_DOCUMENT,
  CHANGES_FILE,
  changesDocument,
  checkoutEnv,
  checkoutProblem,
  STEP_HOST_ARGV,
  STEP_TOOLS_FOLDER,
  stepHostEnv,
  wantsChanges,
} from '../core/steps/stepSandbox.ts';
import type { StepDeclaration } from '../core/steps/stepTools.ts';
import {
  approvalCommand,
  assistantText,
  isRunOver,
  runFailure,
  stepMessage,
  stepModelSelection,
  stepRunOf,
  stepSessionId,
} from '../core/steps/stepTurn.ts';
import { makeStepHostClient, makeStepKeys, type StepHostClient } from './stepHostClient.ts';
import {
  attemptSandbox,
  runCheckout,
  messageOf,
  STEP_LIFETIME_MARGIN,
  type StepSandboxOptions,
  StepFailed,
  sandboxCall,
} from './stepSandboxes.ts';

/** How often the runner reads the step's thread while a turn runs. */
export const STEP_POLL_INTERVAL = Duration.millis(500);
/** How many reads of the thread in a row may fail before the attempt fails. */
const SNAPSHOT_FAILURES_ALLOWED = 10;
/** The step host's idle minutes: it outlives a pause between the runner's calls. */
const STEP_HOST_IDLE_MINUTES = 10;

export type AgentStepsOptions = Omit<StepSandboxOptions, 'log'> & {
  readonly sandboxes: Sandboxes;
  /** Each harness's API key the runner holds; a step gets its own harness's alone. */
  readonly apiKeys: Readonly<Partial<Record<Harness, string>>>;
  /** Every secret the runner holds, taken out of whatever it returns or logs. */
  readonly secretValues: ReadonlyArray<string>;
  /** A line for the runner's log; scrubbed here first. */
  readonly log: (message: string) => Effect.Effect<void>;
  /** `STEP_POLL_INTERVAL` unless a test shortens it. */
  readonly pollEvery?: Duration.Input;
};

/** What an attempt has gathered so far: what a failed or stopped one still returns. */
type Progress = {
  readonly deniedTools: string[];
  reminded: boolean;
  projection: OrchestrationV2ThreadProjection | null;
  readonly hostStderr: MaskedTail;
};

const unique = (names: ReadonlyArray<string>): string[] => [...new Set(names)];

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

export const makeAgentSteps = (options: AgentStepsOptions): AgentSteps => ({
  run: (request, signal) => Effect.runPromise(runAgentStep(options, request, signal)),
});

/** One attempt of an agent step, to its result; it never fails, and its sandbox is always stopped. */
export const runAgentStep = (
  options: AgentStepsOptions,
  request: AgentStepRequest,
  signal: AbortSignal,
): Effect.Effect<AgentStepResult> =>
  Effect.gen(function* () {
    const apiKey = options.apiKeys[request.harness] ?? '';
    const secrets = [
      ...options.secretValues,
      ...(request.cloneToken === null ? [] : [request.cloneToken]),
      ...(apiKey === '' ? [] : [apiKey]),
    ];
    const scrub = (text: string) => maskText(scrubSecrets(text, secrets), secrets);
    const label = `step ${request.runId}/${request.stepId} attempt ${request.attempt}`;
    const log = (message: string) => options.log(scrub(message));
    const progress: Progress = {
      deniedTools: [],
      reminded: false,
      projection: null,
      hostStderr: new MaskedTail(secrets),
    };

    const result = (
      status: AgentStepResult['status'],
      error: string | null,
      folder: { outputs: AgentStepResult['outputs']; artifacts: ReadonlyArray<StepDocument> },
    ): AgentStepResult => {
      const said = new MaskedTail(secrets);
      if (progress.projection !== null) said.push(assistantText(progress.projection));
      const bounded = error === null ? null : scrub(error).slice(0, MAX_ERROR_LENGTH);
      return {
        status,
        error: bounded,
        // The agent wrote these in a sandbox that holds the API key: masked like everything else.
        outputs: Object.fromEntries(
          Object.entries(folder.outputs).map(([name, value]) => [
            name,
            typeof value === 'string' ? maskText(value, secrets) : value,
          ]),
        ),
        artifacts: folder.artifacts.map((document) => ({
          name: document.name,
          content: maskText(document.content, secrets),
        })),
        // t3's projection reports neither a turn's cost nor the CLI's count of turns.
        costUsd: null,
        turns: null,
        deniedTools: unique(progress.deniedTools),
        reminded: progress.reminded,
        output:
          progress.projection === null && progress.hostStderr.end().bytes === 0
            ? null
            : outputTailOf(said, progress.hostStderr),
      };
    };
    const failed = (error: string) => result('failed', error, { outputs: {}, artifacts: [] });

    if (request.harness !== 'claude') {
      return failed(`This runner runs agent steps on Claude alone, not on ${request.harness}.`);
    }
    if (apiKey === '') {
      return failed('This runner holds no API key for Claude, so it cannot run the step.');
    }
    const problem = request.checkout === null ? null : checkoutProblem(request.checkout);
    if (problem !== null) return failed(problem);

    const attempt = Effect.scoped(
      Effect.gen(function* () {
        const sandbox = yield* attemptSandbox(
          { ...options, log },
          label,
          Duration.sum(Duration.millis(request.timeoutMs), STEP_LIFETIME_MARGIN),
        );
        const declaration = yield* prepare(sandbox, request, secrets);
        const host = yield* startHost(sandbox, request, apiKey, progress, secrets);
        const client = host.client;
        const turn = (index: number, text: string) =>
          awaitTurn(options, request, client, host.ended, progress, index, text, secrets);

        const first = yield* turn(1, request.prompt);
        if (first.status !== 'completed') {
          return failed(runFailure(progress.projection ?? { turnItems: [] }, first) ?? '');
        }
        let checked = yield* readFolder(sandbox, declaration, log);
        let missing: MissingFromStep = missingFrom(declaration, checked);
        if (!nothingMissing(missing)) {
          progress.reminded = true;
          const second = yield* turn(
            2,
            request.reminder({ outputs: missing.outputs, artifacts: missing.artifacts }),
          );
          if (second.status !== 'completed') {
            return failed(runFailure(progress.projection ?? { turnItems: [] }, second) ?? '');
          }
          checked = yield* readFolder(sandbox, declaration, log);
          missing = missingFrom(declaration, checked);
        }
        if (!nothingMissing(missing)) {
          return result('failed', missingSentence(missing), {
            outputs: checked.outputs,
            artifacts: checked.artifacts,
          });
        }
        return result('completed', null, {
          outputs: checked.outputs,
          artifacts: checked.artifacts,
        });
      }),
    ).pipe(
      Effect.catchTag('StepFailed', (error) => Effect.succeed(failed(error.problem))),
      Effect.catchDefect((defect) =>
        log(`${label}: ${messageOf(defect)}`).pipe(
          Effect.as(failed('The runner could not run the step.')),
        ),
      ),
    );

    const seconds = Math.round(request.timeoutMs / 1000);
    const outcome = yield* Effect.raceFirst(
      attempt.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(request.timeoutMs),
          orElse: () => Effect.succeed(failed(`The step did not end within ${seconds} s.`)),
        }),
      ),
      aborted(signal).pipe(Effect.as(failed('The step was stopped.'))),
    );
    yield* log(`${label}: ${outcome.status}`);
    return outcome;
  });

/**
 * Checks out the step's commit (the clone token in that command alone) and writes the step's
 * folder: its declaration, with the documents it may read, the pull request's changes among
 * them when it has a pull request and its base.
 */
const prepare = (
  sandbox: Sandbox,
  request: AgentStepRequest,
  secrets: ReadonlyArray<string>,
): Effect.Effect<StepDeclaration, StepFailed> =>
  Effect.gen(function* () {
    const readable = [...request.readable];
    const checkout = request.checkout;
    if (checkout !== null) {
      yield* runCheckout(
        sandbox,
        checkoutEnv(checkout, request.cloneToken, { changes: true }),
        secrets,
      );
      if (wantsChanges(checkout) && !readable.some((each) => each.name === CHANGES_DOCUMENT)) {
        const written = yield* readOrNull(sandbox, CHANGES_FILE);
        readable.push({ name: CHANGES_DOCUMENT, content: changesDocument(written, checkout) });
      }
    }
    const declaration = declarationOf({ ...request, readable });
    yield* sandboxCall(
      () =>
        sandbox.writeFile(`${STEP_TOOLS_FOLDER}/${DECLARATION_FILE}`, declarationText(declaration)),
      "The step's folder could not be written",
    );
    return declaration;
  });

type StartedHost = {
  readonly client: StepHostClient;
  /** Done once the host's command has ended, with the last line it wrote on stderr. */
  readonly ended: Deferred.Deferred<string | null>;
};

/**
 * Starts the step's host with a key pair made for this attempt, waits for its `ready` line,
 * exposes the port it names, and makes the runner's client of it.
 */
const startHost = (
  sandbox: Sandbox,
  request: AgentStepRequest,
  apiKey: string,
  progress: Progress,
  secrets: ReadonlyArray<string>,
): Effect.Effect<StartedHost, StepFailed> =>
  Effect.gen(function* () {
    const keys = makeStepKeys();
    const sessionId = stepSessionId(request);
    const ready = yield* Deferred.make<number>();
    const ended = yield* Deferred.make<string | null>();
    const lines = new HostLineBuffer();
    const stderr = new StderrTail(secrets);
    const command = yield* sandboxCall(
      () =>
        sandbox.start({
          argv: [...STEP_HOST_ARGV],
          env: stepHostEnv({
            sessionId,
            passPublicKeyPem: keys.publicKeyPem,
            apiKey,
            idleMinutes: STEP_HOST_IDLE_MINUTES,
          }),
          keepOutput: false,
          onStdout: (chunk) => {
            for (const text of lines.push(chunk)) {
              const read = readSessionLine(text);
              if (read.kind === 'host' && read.line.type === 'ready') {
                Deferred.doneUnsafe(ready, Effect.succeed(read.line.port));
              }
            }
          },
          onStderr: (chunk) => {
            stderr.push(chunk);
            progress.hostStderr.push(chunk);
          },
        }),
      "The step's host did not start",
    );
    yield* sandboxCall(() => command.wait(), "The step's host ended").pipe(
      Effect.ignore,
      Effect.andThen(Deferred.succeed(ended, stderr.lastLine())),
      Effect.forkDetach,
    );
    const port = yield* Effect.raceFirst(
      Deferred.await(ready),
      Deferred.await(ended).pipe(
        Effect.flatMap((last) =>
          Effect.fail(
            new StepFailed({
              problem: `The step's host stopped before it was ready${last === null ? '.' : `: ${last}`}`,
            }),
          ),
        ),
      ),
    );
    const exposed = yield* sandboxCall(
      () => sandbox.exposePort(port),
      "The step's host could not be reached",
    );
    return { client: makeStepHostClient({ hostUrl: exposed.url, sessionId, keys }), ended };
  });

/**
 * Sends the step's `index`th message and waits for the run it starts to end, answering every
 * permission request by the step's policy as soon as the thread shows it. Fails should the host
 * stop, or the thread stay unreadable.
 */
const awaitTurn = (
  options: AgentStepsOptions,
  request: AgentStepRequest,
  client: StepHostClient,
  hostEnded: Deferred.Deferred<string | null>,
  progress: Progress,
  index: number,
  text: string,
  secrets: ReadonlyArray<string>,
): Effect.Effect<OrchestrationV2Run, StepFailed> =>
  Effect.gen(function* () {
    const sessionId = stepSessionId(request);
    const fail = (problem: string) => new StepFailed({ problem });
    yield* client
      .dispatch(stepMessage(sessionId, index, text, stepModelSelection(request.model)))
      .pipe(Effect.mapError((error) => fail(error.problem)));
    const answered = new Set<string>();
    let failures = 0;
    const pollEvery = options.pollEvery ?? STEP_POLL_INTERVAL;
    while (true) {
      if (yield* Deferred.isDone(hostEnded)) {
        const last = yield* Deferred.await(hostEnded);
        return yield* fail(
          `The step's host stopped during its turn${last === null ? '.' : `: ${maskText(last, secrets)}`}`,
        );
      }
      const read = yield* client.snapshot.pipe(
        Effect.map((projection) => ({ projection, problem: null })),
        Effect.catchTag('StepHostFailed', (error) =>
          Effect.succeed({ projection: null, problem: error.problem }),
        ),
      );
      if (read.projection === null) {
        failures += 1;
        if (failures >= SNAPSHOT_FAILURES_ALLOWED) return yield* fail(read.problem ?? '');
      } else {
        failures = 0;
        progress.projection = read.projection;
        for (const pending of pendingStepRequests(read.projection)) {
          if (answered.has(pending.requestId)) continue;
          answered.add(pending.requestId);
          const approval = decideStepApproval(request.policy, pending);
          if (approval.answer === 'refuse') progress.deniedTools.push(approval.tool);
          yield* client
            .dispatch(approvalCommand(sessionId, pending.requestId, approval))
            .pipe(Effect.mapError((error) => fail(error.problem)));
        }
        const run = stepRunOf(read.projection, sessionId, index);
        if (run !== undefined && isRunOver(run)) return run;
      }
      yield* Effect.sleep(pollEvery);
    }
  });

/** A file of the sandbox as text, or null when it cannot be read. */
const readOrNull = (sandbox: Sandbox, path: string): Effect.Effect<string | null> =>
  sandboxCall(() => sandbox.readTextFile(path), 'unread').pipe(Effect.orElseSucceed(() => null));

/** Reads the step's folder out of its sandbox, and checks it again (`checkStepFolder`). */
const readFolder = Effect.fn('AgentSteps.readFolder')(function* (
  sandbox: Sandbox,
  declaration: StepDeclaration,
  log: (message: string) => Effect.Effect<void>,
) {
  const read = (path: string) => readOrNull(sandbox, `${STEP_TOOLS_FOLDER}/${path}`);
  const outputs = yield* read(OUTPUTS_FILE);
  const artifacts = yield* Effect.forEach(declaration.writable, (name) =>
    read(artifactFile(name)).pipe(Effect.map((text) => ({ name, text }))),
  );
  const checked = checkStepFolder(declaration, outputs, artifacts);
  if (checked.refused.length > 0) {
    yield* log(
      `the step's folder held what its tools would not write: ${checked.refused.join('; ')}`,
    );
  }
  return checked;
});
