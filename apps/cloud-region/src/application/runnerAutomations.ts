import { gitHubTokenRequest } from '@consola/cloud-contract';
import type {
  FactoriesAnswer,
  FactoriesRequest,
  FactorySnapshot,
  GitHubStepToken,
  GitHubStepTokenRefused,
  GitHubStepTokenRequest,
  RunRefused,
} from '@consola/runner-protocol';
import { automationsOf } from '../domain/factory.js';
import { HELD_EVENTS_MAX, HELD_EVENTS_WINDOW_SECONDS } from '../domain/gitHubEvent.js';
import { type RunProblem, type RunWrite, refusalOf } from '../domain/run.js';
import { RUN_DECISION_OF } from '../domain/runApproval.js';
import { factoriesAnswer, type LeftOut } from '../domain/runnerFactories.js';
import {
  beyondCheckout,
  grantedAsPurpose,
  judgeDeclared,
  judgeRun,
  MINT_REFUSALS,
  purposeFor,
  refusalText,
  stepPermissionsOf,
} from '../domain/stepToken.js';
import type {
  AutomationPorts,
  FactoryStore,
  GitHubEventStore,
  HeldEvents,
  PassedAnswer,
  RunStore,
} from './ports.js';
import { recordRun } from './runs.js';

/*
 * What the cell does with a runner's messages for automations (CON-116, stage 1). The cell is
 * the store and the gate, and decides nothing about a run: the runner matches triggers, records
 * each run and acts on a person's answer. Every use case here serves the one workspace the
 * runner's socket is bound to, `workspaceId`, never one a message names.
 */

/** The most runs one hello is told the answers of: the earliest answered first. */
export const ANSWERS_ON_HELLO_MAX = 200;

/** Why the cell refused a record its check found nothing wrong with, by what the store found. */
const STORE_REFUSALS: Record<
  'factory-not-found' | 'parent-not-found' | 'identity-changed',
  RunProblem
> = {
  'factory-not-found': {
    field: 'factoryVersion',
    message: 'The workspace has no such factory, or the factory no such version.',
  },
  'parent-not-found': {
    field: 'parent.runId',
    message: 'The workspace holds no request of the same factory with this id.',
  },
  'identity-changed': {
    field: 'id',
    message:
      'The workspace holds this run with another factory, kind or parent, which never change.',
  },
};

/**
 * Records a run its runner sent (`run.record`) for the socket's workspace, and answers the
 * `run.refused` to send back, or null when there is none to send: recorded, or older than the
 * record the workspace holds (`stale`), which changes nothing and needs no answer.
 */
export async function recordRunnerRun(
  runs: RunStore,
  workspaceId: string,
  run: RunWrite,
): Promise<RunRefused | null> {
  const answer = await recordRun(runs, workspaceId, run);
  switch (answer.kind) {
    case 'recorded':
    case 'stale':
      return null;
    case 'invalid':
      return refusalOf(run.id, answer.problems);
    default:
      return refusalOf(run.id, [STORE_REFUSALS[answer.kind]]);
  }
}

/** The runner recorded an event's runs, or found none (`github.event.ack`): it is held no more. */
export function acknowledgeEvent(
  gitHubEvents: GitHubEventStore,
  workspaceId: string,
  deliveryId: string,
): Promise<'acknowledged' | 'not-held'> {
  return gitHubEvents.acknowledge(workspaceId, deliveryId);
}

/**
 * The answer to `factories.request`: every factory of the workspace at its latest saved version
 * with its files, or the one factory and version `only` names, none for one the workspace does not
 * hold. Whole factories, as many as fit one frame of `maxBytes` (`factoriesAnswer`); `left` names
 * those left out, for the log.
 */
export async function answerFactoriesRequest(
  factories: FactoryStore,
  workspaceId: string,
  request: FactoriesRequest,
  maxBytes?: number,
): Promise<{ answer: FactoriesAnswer; left: LeftOut[] }> {
  const picks = request.only
    ? [request.only]
    : (await factories.list(workspaceId)).map((factory) => ({
        factoryId: factory.id,
        version: factory.latestVersion,
      }));
  const snapshots: FactorySnapshot[] = [];
  for (const pick of picks) {
    const version = await factories.version(workspaceId, pick.factoryId, pick.version);
    if (!version) continue;
    snapshots.push({
      factoryId: version.factoryId,
      version: version.version,
      files: version.files.map(({ path, content }) => ({ path, content })),
    });
  }
  return factoriesAnswer(request.requestId, snapshots, maxBytes);
}

/** What a runner that runs automations is sent once its hello is judged. */
export type HelloPending = { events: HeldEvents; answers: PassedAnswer[] };

/**
 * What the socket's workspace holds for a runner that says hello with `automations: true`: the
 * GitHub events it has not acknowledged, of the last `HELD_EVENTS_WINDOW_SECONDS`, the newest
 * `HELD_EVENTS_MAX` of them, oldest first (older ones stay held, and are counted); and every run
 * that still waits for approval with an answer for its version, which the runner may never have
 * heard of (no runner was connected when it was given, or the runner restarted).
 */
export async function pendingForHello(
  ports: Pick<AutomationPorts, 'gitHubEvents' | 'runs' | 'clock'>,
  workspaceId: string,
): Promise<HelloPending> {
  const since = ports.clock.nowSeconds() - HELD_EVENTS_WINDOW_SECONDS;
  const events = await ports.gitHubEvents.held(workspaceId, since, HELD_EVENTS_MAX);
  const answered = await ports.runs.answeredWaiting(workspaceId, ANSWERS_ON_HELLO_MAX);
  return {
    events,
    answers: answered.map(({ run, answer }) => ({
      run,
      decision: RUN_DECISION_OF[answer.decision],
      personId: answer.by,
    })),
  };
}

/**
 * The answer to a runner's `github.token.request`: a token for one step of a run, or why not. The
 * cell checks, in order: the run is the socket's workspace's and running, on its item's
 * repository; what is asked beyond the run's checkout is declared by the step, a `run:` step of
 * the run's automation at the version it runs; one purpose grants exactly what is asked; the
 * workspace's events name the repository's installation and GitHub id (never the runner); and
 * the cell can sign. Then it asks `cloud-global`, and hands the token on only when it is exactly
 * what the purpose grants, on exactly that repository.
 *
 * The token is a secret: it is in the answer and nowhere else, never in a refusal's reason.
 */
export async function issueStepToken(
  ports: AutomationPorts,
  workspaceId: string,
  request: GitHubStepTokenRequest,
): Promise<GitHubStepToken | GitHubStepTokenRefused> {
  const refuse = (reason: string): GitHubStepTokenRefused => ({
    type: 'github.token.refused',
    requestId: request.requestId,
    reason: refusalText(reason),
  });

  const run = judgeRun(await ports.runs.recordOf(workspaceId, request.runId), request.repository);
  if (!run.ok) return refuse(run.reason);

  const beyond = beyondCheckout(request.permissions);
  if (Object.keys(beyond).length > 0) {
    const declared = await declaredBy(ports.factories, workspaceId, run.value, request.stepId);
    if (!declared.ok) return refuse(declared.reason);
    const judged = judgeDeclared(beyond, declared.value);
    if (!judged.ok) return refuse(judged.reason);
  }

  const purpose = purposeFor(request.permissions);
  if (!purpose.ok) return refuse(purpose.reason);

  const repository = await ports.gitHubEvents.repositoryOf(workspaceId, request.repository);
  if (!repository) {
    return refuse(
      'The cell has recorded no GitHub event from this repository, so it does not know its installation.',
    );
  }
  if (!ports.gitHubTokens) return refuse('This cell is not set up to ask for GitHub tokens.');

  const signed = await ports.gitHubTokens.signer.sign(
    gitHubTokenRequest({
      workspaceId,
      installationId: repository.installationId,
      purpose: purpose.value.purpose,
      repositoryIds: [repository.repositoryId],
      issuedAt: ports.clock.nowSeconds(),
    }),
  );
  const minted = await ports.gitHubTokens.minter.mint(signed);
  if (minted.kind === 'unavailable') return refuse(MINT_REFUSALS.unavailable);
  if (minted.kind === 'refused') return refuse(MINT_REFUSALS[minted.refusal]);

  const onlyThatRepository =
    minted.repositories.length === 1 && minted.repositories[0]?.id === repository.repositoryId;
  if (!onlyThatRepository || !grantedAsPurpose(purpose.value.grants, minted.permissions)) {
    return refuse('cloud-global gave a token other than the one asked for, so the cell kept it.');
  }
  return {
    type: 'github.token',
    requestId: request.requestId,
    token: minted.token,
    expiresAt: new Date(minted.expiresAt * 1000).toISOString(),
  };
}

/** The `permissions:` the step declares, at the factory version the run runs. */
async function declaredBy(
  factories: FactoryStore,
  workspaceId: string,
  run: RunWrite,
  stepId: string,
) {
  const version = await factories.version(workspaceId, run.factoryId, run.factoryVersion);
  const automation =
    version && run.automation !== null
      ? automationsOf(version.files).find((candidate) => candidate.name === run.automation)
      : undefined;
  if (!automation) {
    return {
      ok: false as const,
      reason: "The run's factory version does not define its automation.",
    };
  }
  return stepPermissionsOf(automation, stepId);
}
