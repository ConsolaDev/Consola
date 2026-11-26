/**
 * An agent run (`packages/host/AGENTS.md`, "Agent runs"): the session's thread is the
 * orchestrator's, and every agent it dispatches is a thread of its own in the same project and
 * folder (a "child"), started and followed here, in process, through t3's orchestrator:
 * `thread.create`, then `message.dispatch` with the agent's instructions and the brief. When a
 * child's run ends, its final message goes to the orchestrator's thread as a new message
 * (`queue_after_active`), exactly once: one evaluator fiber decides every delivery, each marked
 * by its run's id, and t3 runs a command id it already accepted only once.
 *
 * Nothing here is reachable by an RPC client: the host dispatches these commands itself, past
 * `decideCommand`, which governs what clients may send.
 */
import type { AgentRun, AgentRunAgent } from '@consola/runner-protocol';
import { CommandId, MessageId, ThreadId } from '@t3tools/contracts';
import type {
  ModelSelection,
  OrchestrationV2Command,
  OrchestrationV2CommandOutputError,
  OrchestrationV2CommandOutputFrame,
  OrchestrationV2Run,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerProvider,
  TurnItemId,
} from '@t3tools/contracts';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Queue from 'effect/Queue';
import type * as Scope from 'effect/Scope';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import * as SubscriptionRef from 'effect/SubscriptionRef';
import type * as CommandOutputHub from 't3/orchestration-v2/CommandOutputHub.ts';
import { isActiveRun } from 't3/orchestration-v2/CommandPolicy.ts';
import type * as Orchestrator from 't3/orchestration-v2/Orchestrator.ts';
import type * as ProviderRegistry from 't3/provider/ProviderRegistry.ts';
import {
  agentBrief,
  agentRunView,
  sameView,
  decideDispatch,
  decideFollowUp,
  dispatchedStatus,
  failureOf,
  finalMessageOf,
  hasEnded,
  NOT_THE_ORCHESTRATOR,
  reportBody,
  reportMessage,
  reportReady,
} from '../core/agentRun.ts';
import type { AgentRunView, ChildFacts, Completion, OrchestratorFacts } from '../core/agentRun.ts';
import {
  AGENT_RUN_TOOLS,
  DISPATCH_GUIDE,
  DISPATCHED_GUIDE,
  readToolCall,
  toolError,
  toolValue,
} from '../core/agentRunTools.ts';
import type { ToolAnswer, ToolCall, ToolListing } from '../core/agentRunTools.ts';

/** How long a model a run names may wait for the provider to list its models. */
const MODELS_WAIT = Duration.seconds(15);
/** How long the evaluator waits for an event before it reads every thread again. */
const EVALUATE_EVERY = Duration.seconds(1);

/** What a dispatched agent's thread is read through, read-only (`rpcServer.ts`, `hostShell.ts`). */
export type ChildThreadView = {
  readonly threadId: ThreadId;
  readonly agent: string;
  snapshot(): OrchestrationV2ThreadProjection;
  snapshotSequence(): number;
  events(
    afterSequence?: number,
  ): Stream.Stream<OrchestrationV2StoredEvent, Orchestrator.OrchestratorV2Error>;
  commandOutput(
    itemId: TurnItemId,
  ): Stream.Stream<OrchestrationV2CommandOutputFrame, OrchestrationV2CommandOutputError>;
  readonly shellRow: Effect.Effect<
    OrchestrationV2ThreadShell | null,
    Orchestrator.OrchestratorV2Error
  >;
};

/** An agent run, as the session's handle carries it (`ThreadHandle.agentRun`). */
export type AgentRunHandle = {
  /** The run's report and the session's status now. */
  view(): AgentRunView;
  /** `view()` now, then each that replaces it. */
  views(): Stream.Stream<AgentRunView>;
  /** Sends the run's prompt as the orchestrator's first message. Once the host listens. */
  readonly start: Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
  /** The tools `/mcp` lists. */
  readonly tools: readonly ToolListing[];
  /** Answers one tool call made by `caller`'s thread (whose token the request carried). */
  callTool(caller: ThreadId, name: string, args: unknown): Effect.Effect<ToolAnswer>;
  /** The dispatched agents' threads, in dispatch order. */
  children(): readonly ChildThreadView[];
  /** One dispatched agent's thread, or undefined for any other id. */
  child(threadId: string): ChildThreadView | undefined;
};

type Child = {
  readonly id: ThreadId;
  readonly agent: AgentRunAgent;
  readonly model: ModelSelection;
  projection: OrchestrationV2ThreadProjection;
  sequence: number;
  followUps: number;
  /** The runs whose report was handed to the orchestrator's thread. */
  readonly reported: Set<string>;
  /** When each ended run was first seen ended (a completed run's message grace). */
  readonly endedSeenAt: Map<string, number>;
  lastEnded: { readonly status: OrchestrationV2Run['status']; readonly body: string } | null;
};

const threadFacts = (projection: OrchestrationV2ThreadProjection) => ({
  active: projection.runs.some(isActiveRun),
  queued: projection.runs.some((run) => run.status === 'queued' && run.queueHeld !== true),
  pendingRequest: projection.runtimeRequests.some((request) => request.status === 'pending'),
});

const byOrdinal = (a: OrchestrationV2Run, b: OrchestrationV2Run) => a.ordinal - b.ordinal;

const orchestratorFacts = (projection: OrchestrationV2ThreadProjection): OrchestratorFacts => {
  const ran = projection.runs.filter((run) => run.status !== 'queued').toSorted(byOrdinal);
  let lastMessage: OrchestratorFacts['lastMessage'] = null;
  for (const message of projection.messages) {
    if (message.role === 'assistant' && !message.streaming && message.text.trim() !== '') {
      lastMessage = { id: message.id, text: message.text.trim() };
    }
  }
  return {
    ...threadFacts(projection),
    lastRunStatus: ran.at(-1)?.status ?? null,
    lastMessage,
  };
};

const childFacts = (child: Child): ChildFacts => ({
  id: child.id,
  agent: child.agent.name,
  ...threadFacts(child.projection),
  undelivered: child.projection.runs.some((run) => hasEnded(run) && !child.reported.has(run.id)),
  lastEnded: child.lastEnded,
});

export type AgentRunInput = {
  readonly sessionId: string;
  /** The orchestrator's thread: the session's own. */
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly run: AgentRun;
  /** The harness's default model on the session's instance: what a run that names none runs on. */
  readonly defaultModel: ModelSelection;
  readonly orchestrator: Orchestrator.OrchestratorV2['Service'];
  readonly providers: ProviderRegistry.ProviderRegistry['Service'];
  readonly commandOutput: CommandOutputHub.CommandOutputHub['Service'];
};

/**
 * Follows an agent run in the caller's scope: a fiber that marks the threads each stored event
 * touched, and one that evaluates them (reads those threads again, delivers every report that is
 * ready, and publishes the view), under one lock that the tool calls share.
 */
export const openAgentRun = (
  input: AgentRunInput,
): Effect.Effect<AgentRunHandle, Orchestrator.OrchestratorV2Error, Scope.Scope> =>
  Effect.gen(function* () {
    const { sessionId, run, orchestrator } = input;
    const orchestratorId = input.threadId;
    const lock = yield* Semaphore.make(1);
    const wake = yield* Queue.sliding<void>(1);
    const dirty = new Set<string>();
    const children: Child[] = [];
    let dispatchCount = 0;
    let completion: Completion | null = null;
    let orchestratorModel = input.defaultModel;
    let orchestratorProjection = (yield* orchestrator.getThreadSnapshot(orchestratorId)).projection;
    const warned = new Set<string>();

    const evaluateView = (): AgentRunView =>
      agentRunView({
        orchestrator: orchestratorFacts(orchestratorProjection),
        children: children.map(childFacts),
        completion,
      });
    const views = yield* SubscriptionRef.make(evaluateView());
    const publish = Effect.gen(function* () {
      const next = evaluateView();
      if (!sameView(yield* SubscriptionRef.get(views), next)) {
        yield* SubscriptionRef.set(views, next);
      }
    });

    const readOrchestrator = Effect.gen(function* () {
      orchestratorProjection = (yield* orchestrator.getThreadSnapshot(orchestratorId)).projection;
    });
    const readChild = Effect.fn('AgentRun.readChild')(function* (child: Child) {
      const snapshot = yield* orchestrator.getThreadSnapshot(child.id);
      if (snapshot.snapshotSequence >= child.sequence) {
        child.projection = snapshot.projection;
        child.sequence = snapshot.snapshotSequence;
      }
    });

    /** The model a run or agent names, when the session's provider offers it; else the default. */
    const modelFor = Effect.fn('AgentRun.modelFor')(function* (
      requested: string | undefined,
      who: string,
    ) {
      if (requested === undefined) return input.defaultModel;
      const instanceId = input.defaultModel.instanceId;
      const offering = (providers: readonly ServerProvider[]) =>
        providers.find(
          (provider) => provider.instanceId === instanceId && provider.models.length > 0,
        );
      const listed =
        offering(yield* input.providers.getProviders) ??
        Option.getOrUndefined(
          Option.flatten(
            yield* input.providers.streamChanges.pipe(
              Stream.map(offering),
              Stream.filter((provider) => provider !== undefined),
              Stream.runHead,
              Effect.timeoutOption(MODELS_WAIT),
            ),
          ),
        );
      const model = listed?.models.find(
        (candidate) =>
          candidate.slug === requested || (candidate.aliases ?? []).includes(requested),
      );
      if (model !== undefined) return { instanceId, model: model.slug };
      if (!warned.has(requested)) {
        warned.add(requested);
        yield* Effect.sync(() =>
          process.stderr.write(
            `consola-host: warning: the session's provider offers no model ${requested}, so ${who} runs on ${input.defaultModel.model}.\n`,
          ),
        );
      }
      return input.defaultModel;
    });

    const message = (
      threadId: ThreadId,
      key: string,
      text: string,
      modelSelection: ModelSelection,
      dispatchMode: Extract<OrchestrationV2Command, { type: 'message.dispatch' }>['dispatchMode'],
    ): OrchestrationV2Command => ({
      type: 'message.dispatch',
      createdBy: 'user',
      creationSource: 'web',
      commandId: CommandId.make(`command:${threadId}:${key}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${key}`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode,
    });

    // Reports: every ended run of every child, once, in its order.
    const deliverReports = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      let delivered = false;
      for (const child of children) {
        for (const ended of child.projection.runs.filter(hasEnded).toSorted(byOrdinal)) {
          if (child.reported.has(ended.id)) continue;
          const seenAt = child.endedSeenAt.get(ended.id) ?? now;
          child.endedSeenAt.set(ended.id, seenAt);
          const final = finalMessageOf(child.projection, ended.id);
          if (!reportReady(ended, final, now - seenAt)) break;
          const body = reportBody(ended.status, final, failureOf(child.projection, ended.id));
          const sent = yield* orchestrator
            .dispatch(
              message(
                orchestratorId,
                `report:${ended.id}`,
                reportMessage({
                  agent: child.agent.name,
                  childId: child.id,
                  status: ended.status,
                  body,
                }),
                orchestratorModel,
                { type: 'queue_after_active' },
              ),
            )
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logError(
                  `Delivering ${child.id}'s report failed; trying again.`,
                  cause,
                ).pipe(Effect.as(false)),
              ),
            );
          if (!sent) break;
          child.reported.add(ended.id);
          child.endedSeenAt.delete(ended.id);
          child.lastEnded = { status: ended.status, body };
          delivered = true;
        }
      }
      if (delivered) yield* readOrchestrator;
    });

    // `everything` re-reads every thread: after a quiet second, so an event the marker missed (its
    // subscription starts as a fiber of its own) costs a second at most, never a lost report.
    const evaluate = (everything: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const touched = new Set([...dirty]);
          dirty.clear();
          if (everything || touched.has(orchestratorId)) yield* readOrchestrator;
          for (const child of children) {
            if (everything || touched.has(child.id)) yield* readChild(child);
          }
          yield* deliverReports;
          yield* publish;
        }),
      );

    // Marks the threads each batch touched, and wakes the evaluator; it never waits on the lock,
    // so t3's event stream is never held back by a tool call.
    yield* orchestrator.streamStoredEvents.pipe(
      Stream.runForEachArray((batch) =>
        Effect.sync(() => {
          for (const stored of batch) dirty.add(stored.event.threadId);
          Queue.offerUnsafe(wake, undefined);
        }),
      ),
      Effect.catchCause((cause) => Effect.logError('Agent run event stream failed.', cause)),
      Effect.forkScoped,
    );
    yield* Effect.forever(
      Queue.take(wake).pipe(
        Effect.timeoutOption(EVALUATE_EVERY),
        Effect.flatMap((woken) => evaluate(Option.isNone(woken))),
        Effect.catchCause((cause) => Effect.logError('Agent run evaluation failed.', cause)),
      ),
    ).pipe(Effect.forkScoped);

    const runningCount = () =>
      children.filter((child) => dispatchedStatus(childFacts(child)) === 'working').length;
    const findChild = (id: string) => children.find((child) => child.id === id);
    const unknownChild = (id: string) =>
      toolError(
        children.length === 0
          ? `There is no dispatched agent ${id}: none has been dispatched yet.`
          : `There is no dispatched agent ${id}. The dispatched agents are: ${children
              .map((child) => `${child.id} (${child.agent.name})`)
              .join(', ')}.`,
      );
    const NEXT =
      'Its report arrives as a new message in this conversation when its turn ends. Do not poll for it; end your turn if nothing else is left to do.';

    const dispatchChild = Effect.fn('AgentRun.dispatchChild')(function* (
      agentName: string,
      task: string,
    ) {
      const decided = decideDispatch({
        run,
        callerIsOrchestrator: true,
        agent: agentName,
        running: runningCount(),
        dispatched: children.length,
      });
      if (!decided.ok) return toolError(decided.error);
      const agent = decided.agent;
      dispatchCount += 1;
      const id = ThreadId.make(`${sessionId}-${agent.name}-${dispatchCount}`);
      const model = yield* modelFor(agent.model, `the agent ${agent.name}`);
      const created = yield* orchestrator
        .dispatch({
          type: 'thread.create',
          createdBy: 'user',
          creationSource: 'web',
          commandId: CommandId.make(`command:${id}:thread.create`),
          threadId: id,
          projectId: input.projectId,
          title: `${agent.name} ${dispatchCount}`,
          modelSelection: model,
          runtimeMode: 'full-access',
          interactionMode: 'default',
          branch: null,
          worktreePath: null,
        })
        .pipe(
          Effect.andThen(
            orchestrator.dispatch(
              message(id, 'brief', agentBrief(agent, task), model, { type: 'start_immediately' }),
            ),
          ),
          Effect.result,
        );
      if (created._tag === 'Failure') {
        yield* Effect.logError(`Dispatching ${agent.name} failed.`, created.failure);
        return toolError(`The agent ${agent.name} could not be started: t3 refused it.`);
      }
      const snapshot = yield* orchestrator.getThreadSnapshot(id);
      children.push({
        id,
        agent,
        model,
        projection: snapshot.projection,
        sequence: snapshot.snapshotSequence,
        followUps: 0,
        reported: new Set(),
        endedSeenAt: new Map(),
        lastEnded: null,
      });
      yield* publish;
      return toolValue({
        taskId: id,
        threadId: id,
        agent: agent.name,
        status: 'running',
        next: NEXT,
      });
    });

    const followUp = Effect.fn('AgentRun.followUp')(function* (threadId: string, text: string) {
      const child = findChild(threadId);
      if (child === undefined) return unknownChild(threadId);
      const decided = decideFollowUp({
        callerIsOrchestrator: true,
        childRunning: dispatchedStatus(childFacts(child)) === 'working',
        running: runningCount(),
      });
      if (!decided.ok) return toolError(decided.error);
      child.followUps += 1;
      const sent = yield* orchestrator
        .dispatch(
          message(child.id, `follow-up-${child.followUps}`, text, child.model, {
            type: 'queue_after_active',
          }),
        )
        .pipe(Effect.result);
      if (sent._tag === 'Failure') {
        yield* Effect.logError(`A follow-up to ${child.id} failed.`, sent.failure);
        return toolError(`The follow-up to ${child.id} could not be sent: t3 refused it.`);
      }
      yield* readChild(child);
      yield* publish;
      return toolValue({
        taskId: child.id,
        threadId: child.id,
        agent: child.agent.name,
        status: 'running',
        next: NEXT,
      });
    });

    const status = (taskId: string) =>
      Effect.sync(() => {
        const child = findChild(taskId);
        if (child === undefined) return unknownChild(taskId);
        const running = dispatchedStatus(childFacts(child)) === 'working';
        return toolValue({
          taskId: child.id,
          agent: child.agent.name,
          status: running ? 'running' : (child.lastEnded?.status ?? 'running'),
          ...(running || child.lastEnded === null ? {} : { report: child.lastEnded.body }),
        });
      });

    const cancel = Effect.fn('AgentRun.cancel')(function* (taskId: string) {
      const child = findChild(taskId);
      if (child === undefined) return unknownChild(taskId);
      const active = child.projection.runs.filter(isActiveRun);
      for (const each of active) {
        yield* orchestrator
          .dispatch({
            type: 'run.interrupt',
            commandId: CommandId.make(`command:${child.id}:cancel:${each.id}`),
            threadId: child.id,
            runId: each.id,
            reason: 'Cancelled by the orchestrator.',
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError(`Cancelling ${child.id}'s run failed.`, cause),
            ),
          );
      }
      yield* readChild(child);
      yield* publish;
      return toolValue({
        taskId: child.id,
        cancelled: active.length > 0,
        ...(active.length === 0 ? { note: 'It had no running turn.' } : {}),
      });
    });

    const answer = (caller: ThreadId, call: ToolCall) => {
      const isOrchestrator = caller === orchestratorId;
      if (call.tool === 'orchestrator_capabilities') {
        return Effect.succeed(
          isOrchestrator
            ? toolValue({
                agents: run.agents.map(({ name, description }) => ({ name, description })),
                dispatch: DISPATCH_GUIDE,
              })
            : toolValue({ agents: [], dispatch: DISPATCHED_GUIDE }),
        );
      }
      if (!isOrchestrator) return Effect.succeed(toolError(NOT_THE_ORCHESTRATOR));
      switch (call.tool) {
        case 'delegate_task':
          return dispatchChild(call.agent, call.task);
        case 't3_thread_send':
          return followUp(call.threadId, call.message);
        case 'task_status':
          return status(call.taskId);
        case 'task_cancel':
          return cancel(call.taskId);
        case 'complete_task':
          return Effect.gen(function* () {
            completion = {
              summary: call.summary.trim(),
              afterMessageId: orchestratorFacts(orchestratorProjection).lastMessage?.id ?? null,
            };
            yield* publish;
            return toolValue({ recorded: true });
          });
      }
    };

    const childView = (child: Child): ChildThreadView => ({
      threadId: child.id,
      agent: child.agent.name,
      snapshot: () => child.projection,
      snapshotSequence: () => child.sequence,
      events: (afterSequence) =>
        orchestrator.streamStoredEventsFrom({
          threadId: child.id,
          ...(afterSequence === undefined ? {} : { afterSequence }),
        }),
      commandOutput: (itemId) => input.commandOutput.subscribe({ threadId: child.id, itemId }),
      shellRow: orchestrator.getThreadShell(child.id),
    });

    const handle: AgentRunHandle = {
      view: () => evaluateView(),
      views: () => SubscriptionRef.changes(views),
      start: lock.withPermits(1)(
        Effect.gen(function* () {
          orchestratorModel = yield* modelFor(run.model, `the orchestrator ${run.agent}`);
          yield* orchestrator.dispatch(
            message(orchestratorId, 'agent-run-prompt', run.prompt, orchestratorModel, {
              type: 'start_immediately',
            }),
          );
          yield* readOrchestrator;
          yield* publish;
        }),
      ),
      tools: AGENT_RUN_TOOLS,
      callTool: (caller, name, args) => {
        const read = readToolCall(name, args);
        if (!read.ok) return Effect.succeed(toolError(read.error));
        // Every call that dispatches or records takes the lock the evaluator holds.
        return lock
          .withPermits(1)(answer(caller, read.call))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError(`The agent run's ${name} failed.`, cause).pipe(
                Effect.as(toolError(`${name} failed inside the host; try again once.`)),
              ),
            ),
          );
      },
      children: () => children.map(childView),
      child: (threadId) => {
        const found = findChild(threadId);
        return found === undefined ? undefined : childView(found);
      },
    };
    return handle;
  });
