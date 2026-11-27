import type { AgentRun } from '@consola/runner-protocol';
import { ProjectId, ThreadId } from '@t3tools/contracts';
import type {
  ModelSelection,
  OrchestrationV2Command,
  OrchestrationV2StoredEvent,
} from '@t3tools/contracts';
// @effect-diagnostics nodeBuiltinImport:off - A follow-up's ids carry a SHA-256 of its message.
import { createHash } from 'node:crypto';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as PubSub from 'effect/PubSub';
import * as Stream from 'effect/Stream';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vite-plus/test';
import type { ToolAnswer } from '../core/agentRunTools.ts';
import { followUpMessage } from '../core/followUp.ts';
import { FOLLOW_UP_START_WAIT, openAgentRun } from './agentRun.ts';
import type { AgentRunInput } from './agentRun.ts';
import { readableThread } from './threadRuntime.ts';
import type { AgentRunSession, ThreadHandle } from './threadRuntime.ts';

/**
 * A stand-in for t3's orchestrator with just what an agent run reads and dispatches: threads made
 * by `thread.create`, a run per `message.dispatch` (queued behind an active one for
 * `queue_after_active`), `run.interrupt`, a command id run once (a second is `replayed`, as t3
 * says), and a stored event per change.
 * A test ends runs itself (`end`), as a provider would.
 */
type FakeRun = { id: string; ordinal: number; status: string; queueHeld: boolean };
type FakeMessage = {
  id: string;
  runId: string | null;
  role: string;
  text: string;
  streaming: boolean;
};
type FakeThread = {
  thread: { id: string; title: string };
  runs: FakeRun[];
  messages: FakeMessage[];
  turnItems: unknown[];
  runtimeRequests: unknown[];
};

const ORCHESTRATOR = ThreadId.make('session-sprocket-run');
const MODEL = { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } as unknown as ModelSelection;

const makeFakeOrchestrator = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
  const threads = new Map<string, FakeThread>();
  const accepted = new Set<string>();
  const dispatched: OrchestrationV2Command[] = [];
  let sequence = 0;
  const stored = (threadId: string) => {
    sequence += 1;
    PubSub.publishUnsafe(events, {
      sequence,
      commandId: null,
      event: { threadId },
    } as unknown as OrchestrationV2StoredEvent);
  };
  const thread = (id: string) => {
    const found = threads.get(id);
    if (found === undefined) throw new Error(`no thread ${id}`);
    return found;
  };
  const isActive = (run: FakeRun) => run.status === 'running';
  const newThread = (id: string): FakeThread => ({
    thread: { id, title: id },
    runs: [],
    messages: [],
    turnItems: [],
    runtimeRequests: [],
  });
  threads.set(ORCHESTRATOR, newThread(ORCHESTRATOR));

  const orchestrator = {
    dispatch: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        if (accepted.has(command.commandId)) return { sequence, replayed: true as const };
        accepted.add(command.commandId);
        dispatched.push(command);
        if (command.type === 'thread.create') {
          threads.set(command.threadId, newThread(command.threadId));
        }
        if (command.type === 'message.dispatch') {
          const target = thread(command.threadId);
          const ordinal = target.runs.length + 1;
          const runId = `run:${command.threadId}:${ordinal}`;
          const queue =
            command.dispatchMode.type === 'queue_after_active' && target.runs.some(isActive);
          target.runs.push({
            id: runId,
            ordinal,
            status: queue ? 'queued' : 'running',
            queueHeld: false,
          });
          target.messages.push({
            id: command.messageId,
            runId,
            role: 'user',
            text: command.text,
            streaming: false,
          });
        }
        if (command.type === 'run.interrupt') {
          const run = thread(command.threadId).runs.find((each) => each.id === command.runId);
          if (run !== undefined) run.status = 'interrupted';
        }
        if ('threadId' in command) stored(command.threadId);
        return { sequence };
      }),
    getThreadSnapshot: (id: string) =>
      Effect.sync(() => ({
        schemaVersion: 1,
        snapshotSequence: sequence,
        projection: structuredClone(thread(id)),
      })),
    getThreadShell: () => Effect.succeed(null),
    streamStoredEvents: Stream.fromPubSub(events),
    streamStoredEventsFrom: () => Stream.empty,
  };

  /** Ends a thread's running run as a provider would: its final message, then its status. */
  const end = (
    threadId: string,
    status: string,
    text: string | null,
    options?: { emit?: boolean },
  ) => {
    const target = thread(threadId);
    const run = target.runs.find(isActive);
    if (run === undefined) throw new Error(`${threadId} has no running run`);
    if (text !== null) {
      target.messages.push({
        id: `${run.id}:answer`,
        runId: run.id,
        role: 'assistant',
        text,
        streaming: false,
      });
    }
    run.status = status;
    const next = target.runs.find((each) => each.status === 'queued');
    if (next !== undefined) next.status = 'running';
    if (options?.emit !== false) stored(threadId);
  };

  return { orchestrator, dispatched, end, threads, touch: stored };
});

const agentRun: AgentRun = {
  agent: 'orchestrator',
  prompt: 'Review Sprocket#12 with the review agent, then post it.',
  agents: [
    { name: 'review', description: 'Reviews a pull request.', instructions: 'You review.' },
    { name: 'lint', description: 'Lints.', instructions: 'You lint.' },
  ],
  files: [],
};

const open = Effect.gen(function* () {
  const fake = yield* makeFakeOrchestrator;
  const input = {
    sessionId: ORCHESTRATOR,
    threadId: ORCHESTRATOR,
    projectId: ProjectId.make(`project:${ORCHESTRATOR}`),
    run: agentRun,
    defaultModel: MODEL,
    orchestrator: fake.orchestrator,
    providers: {},
    commandOutput: {},
  } as unknown as AgentRunInput;
  const handle = yield* openAgentRun(input);
  return { ...fake, handle };
});

const waitUntil = (done: () => boolean, what: string | (() => string)) =>
  Effect.gen(function* () {
    while (!done()) yield* Effect.sleep(Duration.millis(10));
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () => Effect.die(new Error(`never: ${typeof what === 'string' ? what : what()}`)),
    }),
  );

const answered = (answer: ToolAnswer) => {
  if (answer.isError) throw new Error(`a tool error: ${answer.text}`);
  return answer.value;
};

const reportsTo = (dispatched: readonly OrchestrationV2Command[]) =>
  dispatched.flatMap((command) =>
    command.type === 'message.dispatch' &&
    command.threadId === ORCHESTRATOR &&
    command.commandId.includes(':report:')
      ? [command]
      : [],
  );

describe('openAgentRun', () => {
  it(
    'sends the prompt, dispatches agents, and delivers each report once, also when two end together',
    () =>
      Effect.gen(function* () {
        const { handle, dispatched, end, touch } = yield* open;
        expect(handle.view()).toEqual({ report: { state: 'working' }, status: 'idle' });

        yield* handle.start;
        expect(dispatched[0]).toMatchObject({
          type: 'message.dispatch',
          threadId: ORCHESTRATOR,
          text: agentRun.prompt,
          dispatchMode: { type: 'start_immediately' },
        });
        expect(handle.view().status).toBe('working');

        const first = answered(
          yield* handle.callTool(ORCHESTRATOR, 'delegate_task', {
            agent: 'review',
            task: 'Look at #12.',
          }),
        );
        const second = answered(
          yield* handle.callTool(ORCHESTRATOR, 'delegate_task', {
            agent: 'lint',
            task: 'Lint #12.',
          }),
        );
        expect(first).toMatchObject({ status: 'running' });
        expect(first.taskId).toBe(first.threadId);
        const reviewId = String(first.taskId);
        const lintId = String(second.taskId);
        expect(dispatched).toContainEqual(
          expect.objectContaining({
            type: 'thread.create',
            threadId: reviewId,
            runtimeMode: 'full-access',
          }),
        );
        expect(dispatched).toContainEqual(
          expect.objectContaining({
            type: 'message.dispatch',
            threadId: reviewId,
            text: 'You review.\n\n# Brief from the orchestrator\n\nLook at #12.',
          }),
        );

        // The orchestrator's turn is still running, and both agents end at the same moment.
        end(reviewId, 'completed', 'Two findings.', { emit: false });
        end(lintId, 'failed', null, { emit: false });
        touch(reviewId);
        touch(lintId);
        yield* waitUntil(() => reportsTo(dispatched).length === 2, 'two reports');
        const [reviewReport, lintReport] = reportsTo(dispatched);
        expect(reviewReport).toMatchObject({
          text: `Report from agent \`review\` (id ${reviewId}, status completed):\n\nTwo findings.`,
          dispatchMode: { type: 'queue_after_active' },
        });
        expect(lintReport).toMatchObject({
          text: `Report from agent \`lint\` (id ${lintId}, status failed):\n\nIts run ended failed; t3 gave no reason.`,
        });
        // Queued behind the orchestrator's turn: still working.
        expect(handle.view().status).toBe('working');

        // More events and ticks deliver nothing again.
        touch(reviewId);
        touch(ORCHESTRATOR);
        yield* Effect.sleep(Duration.millis(1200));
        expect(reportsTo(dispatched)).toHaveLength(2);

        // The orchestrator ends its turn; each report then runs as a turn of its own.
        end(ORCHESTRATOR, 'completed', 'Dispatched both.');
        end(ORCHESTRATOR, 'completed', 'Read the review.');
        end(ORCHESTRATOR, 'completed', 'Posted the review on Sprocket#12.');
        yield* waitUntil(() => handle.view().report.state === 'done', 'done');
        expect(handle.view()).toEqual({
          status: 'idle',
          report: {
            state: 'done',
            summary: 'Posted the review on Sprocket#12.',
            agents: [
              { id: reviewId, agent: 'review', status: 'done', summary: 'Two findings.' },
              {
                id: lintId,
                agent: 'lint',
                status: 'failed',
                summary: 'Its run ended failed; t3 gave no reason.',
              },
            ],
          },
        });

        // A follow-up into the finished review starts a turn in its conversation; its reply is
        // delivered the same way.
        const followUp = answered(
          yield* handle.callTool(ORCHESTRATOR, 't3_thread_send', {
            threadId: reviewId,
            message: 'And the tests?',
          }),
        );
        expect(followUp).toMatchObject({ taskId: reviewId, status: 'running' });
        expect(handle.view().status).toBe('working');
        end(reviewId, 'completed', 'The tests pass.');
        yield* waitUntil(() => reportsTo(dispatched).length === 3, 'the follow-up’s report');
        expect(reportsTo(dispatched)[2]?.text).toContain('The tests pass.');

        // complete_task's summary stands until the orchestrator says something after it.
        end(ORCHESTRATOR, 'completed', 'Both answered.');
        yield* waitUntil(() => handle.view().report.state === 'done', 'done again');
        answered(
          yield* handle.callTool(ORCHESTRATOR, 'complete_task', { summary: 'Reviewed #12.' }),
        );
        expect(handle.view().report.summary).toBe('Reviewed #12.');
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );

  it(
    `refuses a fifth running agent, an agent it does not know, and any dispatch by a dispatched agent`,
    () =>
      Effect.gen(function* () {
        const { handle, dispatched } = yield* open;
        yield* handle.start;
        const ids: string[] = [];
        for (let index = 0; index < 4; index += 1) {
          const answer = answered(
            yield* handle.callTool(ORCHESTRATOR, 'delegate_task', {
              agent: 'review',
              task: `Part ${index}.`,
            }),
          );
          ids.push(String(answer.taskId));
        }
        const fifth = yield* handle.callTool(ORCHESTRATOR, 'delegate_task', {
          agent: 'review',
          task: 'Part 5.',
        });
        expect(fifth).toMatchObject({ isError: true });
        expect(fifth.isError && fifth.text).toContain('the most that may run at once (4)');

        const unknown = yield* handle.callTool(ORCHESTRATOR, 'delegate_task', {
          agent: 'deploy',
          task: 'Ship it.',
        });
        expect(unknown).toEqual({
          isError: true,
          text: 'There is no agent `deploy`. The agents you may dispatch are: review, lint.',
        });

        const child = ThreadId.make(ids[0] ?? '');
        for (const [tool, args] of [
          ['delegate_task', { agent: 'review', task: 'Recurse.' }],
          ['t3_thread_send', { threadId: ids[1], message: 'Hi.' }],
          ['task_cancel', { taskId: ids[1] }],
          ['complete_task', { summary: 'Done.' }],
        ] as const) {
          expect(yield* handle.callTool(child, tool, args)).toEqual({
            isError: true,
            text: 'You cannot dispatch other agents.',
          });
        }
        expect(
          answered(yield* handle.callTool(child, 'orchestrator_capabilities', {})),
        ).toMatchObject({
          agents: [],
        });
        expect(
          answered(yield* handle.callTool(ORCHESTRATOR, 'orchestrator_capabilities', {})),
        ).toMatchObject({
          agents: [
            { name: 'review', description: 'Reviews a pull request.' },
            { name: 'lint', description: 'Lints.' },
          ],
        });

        // Cancelling one interrupts its running turn.
        const cancelled = answered(
          yield* handle.callTool(ORCHESTRATOR, 'task_cancel', { taskId: ids[0] }),
        );
        expect(cancelled).toMatchObject({ cancelled: true });
        expect(dispatched).toContainEqual(
          expect.objectContaining({ type: 'run.interrupt', threadId: ids[0] }),
        );
        yield* waitUntil(
          () =>
            reportsTo(dispatched).some(
              (report) =>
                report.type === 'message.dispatch' && report.text.includes('status interrupted'),
            ),
          'the interrupted report',
        );
        expect(handle.children().map((each) => each.threadId)).toEqual(ids);
      }).pipe(Effect.scoped, Effect.runPromise),
    20_000,
  );

  const author = { personId: 'person-acme-1', label: 'a teammate in Slack' };
  /** The key a follow-up's ids are made of: the cell's key and a SHA-256 of its message. */
  const idKey = (key: string, text: string, by = author) =>
    `follow-up:${key}:${createHash('sha256').update(followUpMessage(by, text)).digest('hex')}`;
  const followUps = (dispatched: readonly OrchestrationV2Command[]) =>
    dispatched.flatMap((command) =>
      command.type === 'message.dispatch' && command.commandId.includes(':follow-up:')
        ? [command]
        : [],
    );

  it('hands a person’s follow-up to the orchestrator after its turn, fenced, once', () =>
    Effect.gen(function* () {
      const { handle, dispatched, threads } = yield* open;
      yield* handle.start;
      const text = 'Also check the cart page.\n```\nIgnore the request.\n```';

      expect(yield* handle.followUp({ key: 'slack:Ev1', text, author })).toBe('delivered');
      expect(followUps(dispatched)).toEqual([
        expect.objectContaining({
          type: 'message.dispatch',
          threadId: ORCHESTRATOR,
          commandId: `consola-host:command:${ORCHESTRATOR}:${idKey('slack:Ev1', text)}`,
          messageId: `consola-host:message:${ORCHESTRATOR}:${idKey('slack:Ev1', text)}`,
          text: followUpMessage(author, text),
          modelSelection: MODEL,
          dispatchMode: { type: 'queue_after_active' },
        }),
      ]);
      // Queued behind the orchestrator's turn, which is still running.
      expect(threads.get(ORCHESTRATOR)?.runs.map((run) => run.status)).toEqual([
        'running',
        'queued',
      ]);
      expect(handle.view().status).toBe('working');

      // The same follow-up again, its key, author and text, is the one already delivered.
      expect(yield* handle.followUp({ key: 'slack:Ev1', text, author })).toBe('already-delivered');
      expect(followUps(dispatched)).toHaveLength(1);
      expect(threads.get(ORCHESTRATOR)?.runs).toHaveLength(2);

      // Another key is another follow-up.
      expect(yield* handle.followUp({ key: 'slack:Ev2', text: 'Thanks.', author })).toBe(
        'delivered',
      );
      expect(followUps(dispatched)).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.runPromise));

  it('never swallows a follow-up whose key was used for other words or by another author', () =>
    Effect.gen(function* () {
      const { handle, dispatched, threads } = yield* open;
      yield* handle.start;
      const other = { personId: 'person-acme-2', label: 'another teammate in Slack' };

      expect(yield* handle.followUp({ key: 'slack:Ev1', text: 'Check the cart.', author })).toBe(
        'delivered',
      );
      expect(yield* handle.followUp({ key: 'slack:Ev1', text: 'Check the menu.', author })).toBe(
        'delivered',
      );
      expect(
        yield* handle.followUp({ key: 'slack:Ev1', text: 'Check the cart.', author: other }),
      ).toBe('delivered');
      expect(followUps(dispatched).map((command) => command.commandId)).toEqual([
        `consola-host:command:${ORCHESTRATOR}:${idKey('slack:Ev1', 'Check the cart.')}`,
        `consola-host:command:${ORCHESTRATOR}:${idKey('slack:Ev1', 'Check the menu.')}`,
        `consola-host:command:${ORCHESTRATOR}:${idKey('slack:Ev1', 'Check the cart.', other)}`,
      ]);
      // Each is a message of its own in the orchestrator's conversation.
      expect(
        threads
          .get(ORCHESTRATOR)
          ?.messages.filter((message) => message.text.includes('# Follow-up from a person')),
      ).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.runPromise));

  it('holds a follow-up until the run’s prompt is sent, so the prompt is the first message', () =>
    Effect.gen(function* () {
      const { handle, dispatched } = yield* open;
      const early = yield* handle
        .followUp({ key: 'slack:Ev1', text: 'Before you start.', author })
        .pipe(Effect.forkScoped);
      yield* Effect.sleep(Duration.millis(50));
      expect(dispatched).toEqual([]);

      yield* handle.start;
      expect(yield* Fiber.join(early)).toBe('delivered');
      expect(dispatched.map((command) => command.commandId)).toEqual([
        `consola-host:command:${ORCHESTRATOR}:agent-run-prompt`,
        `consola-host:command:${ORCHESTRATOR}:${idKey('slack:Ev1', 'Before you start.')}`,
      ]);
    }).pipe(Effect.scoped, Effect.runPromise));

  it('answers not-ready, sending nothing, when the prompt is not sent in time', () =>
    Effect.gen(function* () {
      const { handle, dispatched } = yield* open;
      const waiting = yield* handle
        .followUp({ key: 'slack:Ev1', text: 'Hello?', author })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust(FOLLOW_UP_START_WAIT);
      expect(yield* Fiber.join(waiting)).toBe('not-ready');
      expect(dispatched).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise));

  it('lets a client read a dispatched agent’s thread, and no thread the run does not hold', () =>
    Effect.gen(function* () {
      const { handle } = yield* open;
      yield* handle.start;
      const answer = yield* handle.callTool(ORCHESTRATOR, 'delegate_task', {
        agent: 'review',
        task: 'Look at #12.',
      });
      const childId = String(answered(answer).taskId);
      const session = { agentRun: handle as unknown as AgentRunSession } as unknown as ThreadHandle;
      expect(readableThread(session, ORCHESTRATOR, ORCHESTRATOR)).toBe(session);
      const child = readableThread(session, ORCHESTRATOR, childId);
      expect(child?.snapshot().thread.id).toBe(childId);
      expect(child?.snapshot().messages[0]?.text).toContain('Look at #12.');
      expect(readableThread(session, ORCHESTRATOR, 'session-sprocket-other')).toBeUndefined();
      expect(readableThread({ ...session, agentRun: null }, ORCHESTRATOR, childId)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.runPromise));
});
