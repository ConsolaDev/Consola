import {
  advanceSteps,
  closeSteps,
  type ItemSource,
  maskFormsOf,
  resolveWebhookTrigger,
  runCostOf,
  withAttemptStarted,
  withCommandIntent,
  withGateAsked,
  withRound,
  withStep,
  withUpdate,
} from '@consola/automation-engine/core';
import { flatSteps, leafSteps, type RepeatStep, type StepRun } from '@consola/factory-spec';
import {
  type GitHubEventNotice,
  type RunAnswered,
  type RunRecord,
  type RunRefused,
  SOCKET_FRAME_MAX_BYTES,
} from '@consola/runner-protocol';
import type { OutputTail, StepCheckout } from '../steps/ports.ts';
import { admissionOf } from './approval.ts';
import { checkoutOf } from './checkout.ts';
import { RunDocuments } from './documents.ts';
import type { RingPorts } from './ports.ts';
import {
  endedRecordOf,
  itemOfEvent,
  newRunState,
  type RunState,
  rebuildRunState,
  recordOf,
  runIdOf,
  strippedRecordOf,
  withinFrame,
} from './runRecord.ts';
import {
  type StepEnd,
  agentOutcome,
  commandOutcomeOf,
  planAgentStep,
  planCommandStep,
} from './steps.ts';
import { eventNameOf, matchEvent, parseSnapshot } from './triggers.ts';

/**
 * The runner's automations ring (CON-119): it matches the cell's GitHub events against the
 * factories' triggers, records each run waiting for a person's approval, and walks an approved
 * run's steps through the two step ports, recording the whole run to the cell after every change.
 * The cell stores; this decides.
 *
 * It walks with the engine's own sequencer (`advanceSteps`) and the engine's own changes to the
 * step records (`withUpdate`, `withRound`, `withGateAsked`, `closeSteps`, …), so `if:`, `repeat:`,
 * `then: stop`, gates and budgets behave as on the desktop; `steps.ts` holds how a step's work is
 * asked for and judged. It is the thin precursor of the engine's whole `AutomationService` on a
 * runner (slices 7 and 8), which can replace it behind the same ports.
 *
 * It keeps nothing durable. A run waiting for approval costs no process: the cell sends its
 * record back with the answer, and the ring rebuilds it from that record and its factory at the
 * record's version, whether or not it restarted in between. A run it is walking is lost with the
 * process; the record says how far it got (a run that survives a restart mid-step is later work).
 * It does no I/O of its own: no clock, timer or socket but its ports'.
 */
export type AutomationsRing = {
  /** A message from the cell for runs, in the order the cell sent them. */
  readonly receive: (message: GitHubEventNotice | RunAnswered | RunRefused) => void;
  /**
   * A new socket to the cell was greeted: every run's latest record goes again, since one said
   * while the socket was down, or on a socket that dropped, may not have arrived. A step is never
   * started again.
   */
  readonly connected: () => void;
  /**
   * The runner is stopping: every running step fails, saying so, and its run with it, recorded
   * while the socket is still open. The ports' late answers are ignored.
   */
  readonly stop: () => void;
  /** Settles once everything begun has finished: for tests, and for a stop that waits. */
  readonly settled: () => Promise<void>;
};

/** What a stopped runner leaves its running step saying. */
export const RUNNER_STOPPED =
  'The runner stopped while this step ran, so it may have done part of its work.';

/** What an approved run says when the runner stopped before it could start it. */
const STOPPED_BEFORE_START = 'The runner stopped before it could start this run.';

/** The most ended runs whose latest record the ring keeps, to say again after a reconnect. */
const ENDED_KEPT = 64;

/** The most deliveries the ring remembers acknowledging. */
const ACKED_KEPT = 1024;

const OPEN_STATUSES: readonly string[] = ['needs-approval', 'queued', 'running', 'waiting'];

/** Why a gate parks a run the web cannot answer yet. */
const gateWords = (stepId: string): string =>
  `It waits at the gate \`${stepId}\` for a person. Answering a gate from the web is not built yet, so it waits here.`;

const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/** A run this process walks. */
type Walk = {
  readonly state: RunState;
  readonly source: ItemSource;
  readonly documents: RunDocuments;
  readonly controller: AbortController;
  /** Once the walk is over (ended, parked, or stopped), nothing a port answers later is written. */
  done: boolean;
};

/** What a ring may be tuned with: the socket's frame cap (`SOCKET_FRAME_MAX_BYTES` unless a test lowers it). */
export type RingOptions = { readonly frameMaxBytes?: number };

export function createAutomationsRing(
  ports: RingPorts,
  options: RingOptions = {},
): AutomationsRing {
  const { link, log } = ports;
  const frameMax = options.frameMaxBytes ?? SOCKET_FRAME_MAX_BYTES;
  /** Every run's latest record, open ones always, ended ones `ENDED_KEPT` at most. */
  const held = new Map<string, RunRecord>();
  /** The runs walking, and those approved and being rebuilt, by id. */
  const walks = new Map<string, Walk | 'rebuilding'>();
  const acked = new Set<string>();
  const work = new Set<Promise<void>>();
  let stopping = false;

  const track = (task: Promise<void>): void => {
    const tracked = task.catch((error: unknown) => log(`automations: ${describe(error)}`));
    work.add(tracked);
    void tracked.finally(() => work.delete(tracked));
  };

  /** Keeps `record` as its run's latest and says it now; old ended ones are let go. */
  const sayRecord = (record: RunRecord): void => {
    held.delete(record.id);
    held.set(record.id, record);
    const ended = [...held.values()].filter((run) => !OPEN_STATUSES.includes(run.status));
    for (const run of ended.slice(0, Math.max(0, ended.length - ENDED_KEPT))) held.delete(run.id);
    link.send({ type: 'run.record', run: record });
  };

  /**
   * Says a walked run's record, within the socket's frame. A record that cannot fit ends the run
   * (false): its steps say no output, and its error why.
   */
  const say = (walk: Walk): boolean => {
    const fitted = withinFrame(recordOf(walk.state), frameMax);
    if (fitted !== null) {
      sayRecord(fitted);
      return true;
    }
    walk.state.tails.clear();
    failWalk(walk, 'Its record grew past what the runner’s socket carries, so it was stopped.');
    const record = recordOf(walk.state);
    const bare = withinFrame(record, frameMax) ?? withinFrame(strippedRecordOf(record), frameMax);
    if (bare !== null) sayRecord(bare);
    else log(`run ${walk.state.engine.id}: its record cannot fit the socket's frame, even bare`);
    return false;
  };

  /** The run fails as it stands: a step at work fails with it, saying `error`; the rest not-run. */
  const failWalk = (walk: Walk, error: string): void => {
    const now = ports.now();
    const { engine } = walk.state;
    const steps = (engine.steps ?? []).reduce(
      (rows, step) =>
        step.status === 'running'
          ? withStep(rows, step.id, { status: 'failed', error, finishedAt: now })
          : rows,
      engine.steps ?? [],
    );
    walk.state.engine = {
      ...engine,
      status: 'failed',
      error,
      steps: closeSteps(steps, now, [], 'failed'),
      updatedAt: now,
      finishedAt: now,
    };
    end(walk);
  };

  const end = (walk: Walk): void => {
    walk.done = true;
    walk.controller.abort();
    if (walks.get(walk.state.engine.id) === walk) walks.delete(walk.state.engine.id);
  };

  const setSteps = (walk: Walk, steps: StepRun[], now: string): void => {
    const costUsd = runCostOf(steps);
    walk.state.engine = {
      ...walk.state.engine,
      steps,
      ...(costUsd !== undefined ? { costUsd } : {}),
      updatedAt: now,
    };
  };

  /** The run ends: what its sequencer said applied, every step it had not reached `not-run`. */
  const finish = (
    walk: Walk,
    status: 'completed' | 'failed',
    outcome: { readonly summary?: string; readonly error?: string },
  ): void => {
    const now = ports.now();
    const { engine } = walk.state;
    walk.state.engine = {
      ...engine,
      status,
      ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      steps: closeSteps(engine.steps ?? [], now, [], status),
      updatedAt: now,
      finishedAt: now,
    };
    end(walk);
    say(walk);
  };

  /** A step's end, written with what it recorded, as the desktop's `settleStep` writes it. */
  const settle = (
    walk: Walk,
    stepId: string,
    end: StepEnd,
    changes: Partial<StepRun> = {},
    tail: OutputTail | null = null,
  ): boolean => {
    const now = ports.now();
    const step = leafSteps(walk.state.automation.steps).find(
      (candidate) => candidate.id === stepId,
    );
    const retries = step !== undefined && step.kind !== 'gate' ? (step.onFailure?.retry ?? 0) : 0;
    // A step's declared retries are the desktop's alone for now: the failure says so.
    const written =
      end.status === 'failed' && retries > 0
        ? {
            ...end,
            error: `${end.error} (Its \`on_failure\` retries do not run on a cloud runner yet.)`,
          }
        : end;
    if (tail !== null) walk.state.tails.set(stepId, tail);
    setSteps(
      walk,
      withStep(walk.state.engine.steps ?? [], stepId, { ...changes, ...written, finishedAt: now }),
      now,
    );
    return say(walk);
  };

  /** A token for a step from the cell, or why there is none, in the run's words. */
  const tokenFor = async (
    walk: Walk,
    stepId: string,
    checkout: StepCheckout,
    permissions: Readonly<Record<string, 'read' | 'write'>>,
    what: string,
  ): Promise<{ ok: true; token: string } | { ok: false; error: string }> => {
    try {
      const answer = await link.token({
        runId: walk.state.engine.id,
        stepId,
        repository: checkout.repository,
        permissions: { ...permissions },
      });
      return answer.ok
        ? answer
        : { ok: false, error: `The cell gave no token ${what}: ${answer.reason}` };
    } catch (error) {
      return { ok: false, error: `The cell gave no token ${what}: ${describe(error)}` };
    }
  };

  const runAgentStep = async (walk: Walk, stepId: string, checkout: StepCheckout | null) => {
    const { state } = walk;
    const plan = planAgentStep({ ...walk, stepId, checkout });
    if (!plan.ok) return settle(walk, stepId, { status: 'failed', error: plan.error });
    const step = leafSteps(state.automation.steps).find((candidate) => candidate.id === stepId);
    if (step?.kind !== 'agent')
      return settle(walk, stepId, { status: 'failed', error: 'It is not an agent step.' });
    const now = ports.now();
    walk.state.tails.delete(stepId);
    setSteps(walk, withAttemptStarted(state.engine.steps ?? [], stepId, now, step.agent), now);
    if (!say(walk)) return false;

    let cloneToken: string | null = null;
    if (checkout !== null) {
      const token = await tokenFor(
        walk,
        stepId,
        checkout,
        { contents: 'read' },
        'to clone the repository',
      );
      if (walk.done) return false;
      if (!token.ok) return settle(walk, stepId, { status: 'failed', error: token.error });
      cloneToken = token.token;
    }
    const secrets = cloneToken === null ? [] : maskFormsOf(cloneToken);
    let result: Awaited<ReturnType<RingPorts['agentSteps']['run']>>;
    try {
      result = await ports.agentSteps.run({ ...plan.request, cloneToken }, walk.controller.signal);
    } catch (error) {
      if (walk.done) return false;
      const reason = describe(error);
      return settle(walk, stepId, {
        status: 'failed',
        error: `Its sandbox failed: ${secrets.reduce((text, secret) => text.split(secret).join('***'), reason)}`,
      });
    }
    if (walk.done) return false;
    const outcome = agentOutcome({ step, result, maxTurns: plan.request.maxTurns, secrets });
    const record = (state.engine.steps ?? []).find((candidate) => candidate.id === stepId);
    for (const document of outcome.documents) {
      walk.documents.write(stepId, record?.attempt ?? 1, document.name, document.content);
    }
    return settle(walk, stepId, outcome.end, outcome.changes, outcome.tail);
  };

  const runCommandStep = async (walk: Walk, stepId: string, checkout: StepCheckout | null) => {
    const { state } = walk;
    const plan = planCommandStep({ ...walk, stepId, checkout });
    if (!plan.ok) return settle(walk, stepId, { status: 'failed', error: plan.error });
    const now = ports.now();
    walk.state.tails.delete(stepId);
    setSteps(
      walk,
      withCommandIntent(
        state.engine.steps ?? [],
        stepId,
        now,
        plan.prepared.values.map(({ name }) => name),
      ),
      now,
    );
    if (!say(walk)) return false;

    let cloneToken: string | null = null;
    const secretEnv: Record<string, string> = {};
    if (checkout !== null) {
      const token = await tokenFor(
        walk,
        stepId,
        checkout,
        { contents: 'read' },
        'to clone the repository',
      );
      if (walk.done) return false;
      if (!token.ok) return settle(walk, stepId, { status: 'failed', error: token.error });
      cloneToken = token.token;
    }
    if (plan.permissions !== null) {
      // A step that names no permissions gets no token: only what its file asks for.
      const repository = checkout?.repository ?? state.item.repo;
      if (repository === null) {
        return settle(walk, stepId, {
          status: 'failed',
          error: 'It names GitHub permissions, and its run is on no repository to ask a token for.',
        });
      }
      const token = await tokenFor(
        walk,
        stepId,
        checkout ?? { repository, commit: '', pullRequest: null, baseRef: null },
        plan.permissions,
        'for its `permissions:`',
      );
      if (walk.done) return false;
      if (!token.ok) return settle(walk, stepId, { status: 'failed', error: token.error });
      secretEnv.GH_TOKEN = token.token;
    }
    const secrets = [cloneToken, secretEnv.GH_TOKEN]
      .filter((token): token is string => token !== undefined && token !== null)
      .flatMap((token) => maskFormsOf(token));
    let result: Awaited<ReturnType<RingPorts['commandSteps']['run']>>;
    try {
      result = await ports.commandSteps.run(
        { ...plan.request, cloneToken, secretEnv },
        walk.controller.signal,
      );
    } catch (error) {
      if (walk.done) return false;
      const reason = describe(error);
      return settle(walk, stepId, {
        status: 'failed',
        error: `Its sandbox failed: ${secrets.reduce((text, secret) => text.split(secret).join('***'), reason)}`,
      });
    }
    if (walk.done) return false;
    const record = (state.engine.steps ?? []).find((candidate) => candidate.id === stepId);
    if (record === undefined)
      return settle(walk, stepId, { status: 'failed', error: 'Its record is gone.' });
    const outcome = commandOutcomeOf({
      documents: walk.documents,
      prepared: plan.prepared,
      record,
      result,
      secrets,
    });
    return settle(walk, stepId, outcome.end, outcome.changes, outcome.tail);
  };

  /** One step's turn: started, run through its port, and settled; false once the walk is over. */
  const runStep = async (walk: Walk, stepId: string): Promise<boolean> => {
    const step = leafSteps(walk.state.automation.steps).find(
      (candidate) => candidate.id === stepId,
    );
    const checkout = checkoutOf(walk.state.item);
    if (!checkout.ok) return settle(walk, stepId, { status: 'failed', error: checkout.error });
    switch (step?.kind) {
      case 'agent':
        return runAgentStep(walk, stepId, checkout.checkout);
      case 'run':
        return runCommandStep(walk, stepId, checkout.checkout);
      case 'uses':
        return settle(walk, stepId, {
          status: 'failed',
          error:
            'A `uses:` step (an MCP tool the engine calls) does not run on a cloud runner yet.',
        });
      default:
        return settle(walk, stepId, {
          status: 'failed',
          error: `Its definition has no step ${stepId} to run.`,
        });
    }
  };

  /** Walks a run by the engine's sequencer until it ends, parks at a gate, or the runner stops. */
  const walkRun = async (walk: Walk): Promise<void> => {
    const { state } = walk;
    const item = state.engine.trigger.item;
    while (!walk.done) {
      const budget = state.automation.budget;
      const next = advanceSteps({
        steps: state.automation.steps,
        records: state.engine.steps ?? [],
        dryRun: false,
        ...(item !== undefined
          ? { itemValue: (field: string) => walk.source.itemValue(item, field) }
          : {}),
        ...(budget !== undefined
          ? { budget: { usd: budget.usd, spent: state.engine.costUsd ?? 0 } }
          : {}),
      });
      if (next.kind === 'wait') {
        log(`run ${state.engine.id}: nothing to start, and nothing at work`);
        return;
      }
      const now = ports.now();
      setSteps(
        walk,
        next.updates.reduce(
          (rows, update) => withUpdate(rows, update, now),
          state.engine.steps ?? [],
        ),
        now,
      );
      switch (next.kind) {
        case 'round': {
          const block = flatSteps(state.automation.steps).find(
            (row) => row.step.id === next.blockId,
          )?.step as RepeatStep;
          setSteps(walk, withRound(state.engine.steps ?? [], block, next.round, now), now);
          if (!say(walk)) return;
          break;
        }
        case 'ask':
          walk.state.engine = {
            ...state.engine,
            status: 'waiting',
            error: gateWords(next.stepId),
            steps: withGateAsked(state.engine.steps ?? [], next.stepId, now),
            updatedAt: now,
          };
          end(walk);
          say(walk);
          return;
        case 'complete':
          finish(walk, 'completed', { summary: next.summary });
          return;
        case 'fail':
          finish(walk, 'failed', { error: next.error });
          return;
        case 'start':
          if (!(await runStep(walk, next.stepId))) return;
          break;
      }
    }
  };

  const startWalk = (state: RunState, source: ItemSource): void => {
    const walk: Walk = {
      state,
      source,
      documents: new RunDocuments(),
      controller: new AbortController(),
      done: false,
    };
    walks.set(state.engine.id, walk);
    say(walk);
    track(
      walkRun(walk).catch((error: unknown) => {
        if (walk.done) return;
        finish(walk, 'failed', { error: `The runner failed while walking it: ${describe(error)}` });
      }),
    );
  };

  const onEvent = async (notice: GitHubEventNotice): Promise<void> => {
    const { deliveryId, event } = notice;
    const name = eventNameOf(event);
    if (acked.has(deliveryId)) {
      link.send({ type: 'github.event.ack', deliveryId });
      return;
    }
    let factories: Awaited<ReturnType<RingPorts['link']['factories']>>;
    try {
      factories = await link.factories();
    } catch (error) {
      log(
        `event ${deliveryId} (${name}): no factories from the cell (${describe(error)}); not acknowledged, so the cell sends it again`,
      );
      return;
    }
    if (stopping) return;
    const { matches, notes } = matchEvent(factories, event);
    for (const note of notes) log(note);
    let recorded = 0;
    for (const match of matches) {
      const id = runIdOf(ports.digest, deliveryId, match.factory.id, match.automation.name);
      // Recorded already, by an earlier delivery of the same event.
      if (held.has(id) || walks.has(id)) continue;
      const admission = admissionOf(match.automation);
      const now = ports.now();
      const state = newRunState({
        id,
        factory: match.factory,
        automation: match.automation,
        parsed: match.parsed,
        item: itemOfEvent(event),
        triggerDetail: match.event,
        status: admission === 'ask' ? 'needs-approval' : 'running',
        createdAt: now,
        now,
      });
      recorded += 1;
      if (admission === 'run') startWalk(state, match.source);
      else {
        const record = withinFrame(recordOf(state), frameMax);
        if (record !== null) sayRecord(record);
        else log(`run ${id}: its first record cannot fit the socket's frame`);
      }
    }
    link.send({ type: 'github.event.ack', deliveryId });
    acked.add(deliveryId);
    if (acked.size > ACKED_KEPT) acked.delete(acked.values().next().value as string);
    log(`event ${deliveryId} (${name}): ${recorded} ${recorded === 1 ? 'run' : 'runs'} recorded`);
  };

  /** Ends a run the ring will not walk, from the record the cell stored. */
  const refuse = (record: RunRecord, error: string): void => {
    walks.delete(record.id);
    sayRecord(endedRecordOf(record, { status: 'failed', error }, ports.now()));
    log(`run ${record.id}: ${error}`);
  };

  const onAnswered = async (answer: RunAnswered): Promise<void> => {
    const { run } = answer;
    if (walks.has(run.id)) {
      log(`run ${run.id}: an answer for a run this runner is already running, ignored`);
      return;
    }
    if (run.status !== 'needs-approval' && run.status !== 'queued') {
      log(`run ${run.id}: an answer for a run that is ${run.status}, ignored`);
      return;
    }
    if (answer.decision === 'rejected') {
      sayRecord(endedRecordOf(run, { status: 'rejected' }, ports.now()));
      log(`run ${run.id}: rejected`);
      return;
    }
    walks.set(run.id, 'rebuilding');
    if (stopping) return refuse(run, STOPPED_BEFORE_START);
    const version = `Version ${run.factoryVersion} of its factory`;
    let snapshots: Awaited<ReturnType<RingPorts['link']['factories']>>;
    try {
      snapshots = await link.factories({ factoryId: run.factoryId, version: run.factoryVersion });
    } catch (error) {
      if (stopping) return refuse(run, STOPPED_BEFORE_START);
      return refuse(run, `${version} could not be read from the cell: ${describe(error)}`);
    }
    // Approved, and never to be answered again: a run the runner will not start ends, saying why.
    if (stopping) return refuse(run, STOPPED_BEFORE_START);
    const snapshot = snapshots.find(
      (candidate) =>
        candidate.factoryId === run.factoryId && candidate.version === run.factoryVersion,
    );
    if (snapshot === undefined) return refuse(run, `${version} is gone, so it cannot run.`);
    const parsed = parseSnapshot(snapshot);
    if (parsed.issues.length > 0) {
      return refuse(run, `${version} has problems in its files, so it cannot run.`);
    }
    const rebuilt = rebuildRunState(run, parsed, ports.now());
    if (!rebuilt.ok) return refuse(run, rebuilt.error);
    const { trigger, filter } = rebuilt.state.automation;
    const resolved =
      trigger.kind === 'event'
        ? resolveWebhookTrigger(trigger, filter)
        : ({ ok: false, problem: 'its trigger is no event' } as const);
    if (!resolved.ok) return refuse(run, `It cannot run here: ${resolved.problem}.`);
    log(`run ${run.id}: approved by ${answer.personId}`);
    startWalk(rebuilt.state, resolved.source);
  };

  return {
    receive: (message) => {
      switch (message.type) {
        case 'github.event':
          if (!stopping) track(onEvent(message));
          return;
        case 'run.answered':
          // Even while stopping: an approval is not sent twice, so a run it cannot start ends, saying why.
          track(onAnswered(message));
          return;
        case 'run.refused': {
          const problems = message.problems.map(
            (problem) => `${problem.field}: ${problem.message}`,
          );
          log(`the cell refused run ${message.runId}'s record: ${problems.join('; ')}`);
          // Saying it again after a reconnect would only be refused again.
          if (!walks.has(message.runId)) held.delete(message.runId);
          return;
        }
      }
    },
    connected: () => {
      for (const record of held.values()) link.send({ type: 'run.record', run: record });
    },
    stop: () => {
      stopping = true;
      for (const walk of [...walks.values()]) {
        if (walk === 'rebuilding') continue;
        failWalk(walk, RUNNER_STOPPED);
        say(walk);
      }
    },
    settled: async () => {
      while (work.size > 0) await Promise.all([...work]);
    },
  };
}
