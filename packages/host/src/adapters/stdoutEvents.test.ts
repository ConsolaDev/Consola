import { CommandId, ThreadId } from '@t3tools/contracts';
import type { RuntimeMode } from '@t3tools/contracts';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { SessionSpec } from '../core/sessionSpec.ts';
import type { ThreadHandle } from '../runtime/threadRuntime.ts';
import * as ThreadRuntime from '../runtime/threadRuntime.ts';
import { isolateMachine } from '../testing/machine.ts';
import {
  loadReplay,
  REPLAY_TIMEOUT_MS,
  REPLAY_TITLE,
  replayClaudeDriver,
  sendMessage,
  sessionSpec,
  statuses,
  waitForSnapshot,
  withState,
} from '../testing/replay.ts';
import {
  currentStatus,
  encodeHostLine,
  HOST_LINE_TYPES,
  reportAgentRun,
  reportSession,
  sessionStatusOf,
} from './stdoutEvents.ts';
import type { HostLine } from './stdoutEvents.ts';

/** Every test runs on a machine of its own, with fake CLIs (`../testing/machine.ts`). */
isolateMachine();

/** These tests run offline: any request through `fetch` fails the test. */
const fetched: string[] = [];
beforeAll(() => {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Promise.reject(new Error('These tests make no network request.'));
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  expect(fetched.splice(0)).toEqual([]);
});

/**
 * Opens a session whose Claude driver replays one of t3's fixtures (as `threadRuntime.test.ts`
 * does), reports it into `lines` from the start, and runs `body`.
 */
const withReportedReplay = <A, E>(
  name: string,
  runtimeMode: RuntimeMode | undefined,
  body: (session: {
    readonly spec: SessionSpec;
    readonly handle: ThreadRuntime.ThreadHandle;
    readonly lines: HostLine[];
    /** The fixture's first message. */
    readonly text: string;
    /** That message, sent. */
    readonly send: ReturnType<ThreadRuntime.ThreadHandle['dispatch']>;
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const { variant, transcript, text, cwd } = yield* loadReplay(name);
    return yield* withState((stateDir) =>
      Effect.gen(function* () {
        const spec = sessionSpec(name, cwd, variant.modelSelection);
        const handle = yield* (yield* ThreadRuntime.ThreadRuntime).open(spec);
        const lines: HostLine[] = [];
        const said = { status: 'idle' as const, title: handle.snapshot().thread.title };
        yield* reportSession(handle, (line) => Effect.sync(() => lines.push(line)), said).pipe(
          Effect.forkScoped,
        );
        const send = handle.dispatch(sendMessage(spec, text, variant.modelSelection));
        return yield* body({ spec, handle, lines, text, send });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ThreadRuntime.layerForTests(
            { stateDir },
            {
              drivers: [replayClaudeDriver(transcript)],
              ...(runtimeMode === undefined ? {} : { runtimeMode }),
            },
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.runPromise);

/** Waits until the lines written so far satisfy `done`. */
const waitForLines = (lines: readonly HostLine[], done: (lines: readonly HostLine[]) => boolean) =>
  Effect.gen(function* () {
    while (!done(lines)) yield* Effect.sleep(Duration.millis(10));
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(30),
      orElse: () => Effect.die(new Error(`no such line; got ${JSON.stringify(lines)}`)),
    }),
  );

const statusLines = (lines: readonly HostLine[]) =>
  lines.flatMap((line) => (line.type === 'status' ? [line.status] : []));
const titleLines = (lines: readonly HostLine[]) =>
  lines.flatMap((line) => (line.type === 'title' ? [line.title] : []));

describe('the host lines', () => {
  it('are one JSON object per line, of the types the runner reads', () => {
    expect(HOST_LINE_TYPES).toEqual(['ready', 'dev-pass', 'title', 'status', 'exit', 'agent-run']);
    expect(encodeHostLine({ type: 'ready', port: 7420 })).toBe('{"type":"ready","port":7420}\n');
    expect(encodeHostLine({ type: 'title', title: 'Tidy the "Acme" docs\n' })).toBe(
      '{"type":"title","title":"Tidy the \\"Acme\\" docs\\n"}\n',
    );
    expect(encodeHostLine({ type: 'exit', reason: 'idle' })).toBe(
      '{"type":"exit","reason":"idle"}\n',
    );
  });
});

/** Just what `reportSession` reads of a projection: its title, runs and runtime requests. */
const projectionTitled = (title: string) =>
  ({ thread: { title }, runs: [], runtimeRequests: [] }) as unknown as ReturnType<
    ThreadHandle['snapshot']
  >;

describe('reportSession', () => {
  it('says a title that changed after ready was said, whenever it starts following', () =>
    Effect.gen(function* () {
      // `ready` said the thread's first title; by the time the report starts, t3 retitled it.
      const handle = {
        snapshot: () => projectionTitled('Sprocket catalog'),
        snapshots: () => Stream.make(projectionTitled('Sprocket catalog')),
      } as unknown as ThreadHandle;
      const lines: HostLine[] = [];
      yield* reportSession(handle, (line) => Effect.sync(() => lines.push(line)), {
        status: 'idle',
        title: 'New thread',
      });
      expect(lines).toEqual([{ type: 'title', title: 'Sprocket catalog' }]);
    }).pipe(Effect.runPromise));

  it(
    'tool_call_denied_write: working, then waiting on the approval, then idle once answered; and the titles',
    () =>
      withReportedReplay(
        'tool_call_denied_write',
        undefined,
        ({ spec, handle, lines, text, send }) =>
          Effect.gen(function* () {
            expect(sessionStatusOf(handle.snapshot())).toBe('idle');
            yield* send.pipe(Effect.forkScoped);
            const waiting = yield* waitForSnapshot(handle, (current) =>
              current.runtimeRequests.some((request) => request.status === 'pending'),
            );
            const request = waiting.runtimeRequests.find(
              (candidate) => candidate.status === 'pending',
            );
            if (request === undefined) return yield* Effect.die(new Error('no request'));
            expect(sessionStatusOf(waiting)).toBe('waiting');
            yield* waitForLines(lines, (written) => statusLines(written).includes('waiting'));

            yield* handle.dispatch({
              type: 'runtime-request.respond',
              commandId: CommandId.make(`command:${spec.sessionId}:respond-1`),
              threadId: ThreadId.make(spec.sessionId),
              requestId: request.id,
              decision: 'decline',
            });
            const done = yield* waitForSnapshot(
              handle,
              (current) =>
                statuses(current).includes('completed') && current.thread.title === REPLAY_TITLE,
            );
            expect(sessionStatusOf(done)).toBe('idle');
            yield* waitForLines(
              lines,
              (written) =>
                titleLines(written).at(-1) === REPLAY_TITLE &&
                statusLines(written).at(-1) === 'idle',
            );

            const said = statusLines(lines);
            expect(said[0]).toBe('working');
            expect(said).toContain('waiting');
            expect(said.slice(said.indexOf('waiting') + 1)).toContain('idle');
            // Each line says something new.
            for (const [index, status] of said.entries()) expect(status).not.toBe(said[index - 1]);
            // t3 titles the thread from the message's seed, then with its generated title.
            expect(titleLines(lines)).toEqual([text, REPLAY_TITLE]);
          }),
      ),
    REPLAY_TIMEOUT_MS,
  );
});

describe('an agent run’s lines', () => {
  const view = (state: 'working' | 'done', status: 'working' | 'idle', summary?: string) => ({
    report: { state, ...(summary === undefined ? {} : { summary }) },
    status,
  });

  it('says the report whenever it changes, and the status of every thread', () =>
    Effect.gen(function* () {
      const views = [
        view('working', 'working'),
        view('working', 'working'),
        view('done', 'idle', 'Posted the review.'),
      ];
      const handle = {
        snapshot: () => projectionTitled('New thread'),
        snapshots: () => Stream.make(projectionTitled('New thread')),
        agentRun: { views: () => Stream.fromIterable(views), view: () => views[2] },
      } as unknown as ThreadHandle;
      const lines: HostLine[] = [];
      const write = (line: HostLine) => Effect.sync(() => lines.push(line));
      yield* reportAgentRun(handle.agentRun as NonNullable<ThreadHandle['agentRun']>, write);
      expect(lines).toEqual([
        { type: 'agent-run', state: 'working' },
        { type: 'agent-run', state: 'done', summary: 'Posted the review.' },
      ]);
      lines.length = 0;
      yield* reportSession(handle, write, { status: 'idle', title: 'New thread' });
      expect(lines).toEqual([
        { type: 'status', status: 'working' },
        { type: 'status', status: 'idle' },
      ]);
      expect(currentStatus(handle)).toBe('idle');
    }).pipe(Effect.runPromise));

  it(
    'simple: the host sends the run’s prompt as the first message, in full access, and says working then done',
    () =>
      Effect.gen(function* () {
        const { variant, transcript, text, cwd } = yield* loadReplay('simple');
        return yield* withState((stateDir) =>
          Effect.gen(function* () {
            const spec: SessionSpec = {
              ...sessionSpec('agent-run', cwd, variant.modelSelection),
              agentRun: { agent: 'orchestrator', prompt: text, agents: [], files: [] },
            };
            const handle = yield* (yield* ThreadRuntime.ThreadRuntime).open(spec);
            const agentRun = handle.agentRun;
            if (agentRun === null) return yield* Effect.die(new Error('no agent run'));
            expect(handle.snapshot().thread.runtimeMode).toBe('full-access');
            const lines: HostLine[] = [];
            yield* reportAgentRun(agentRun, (line) => Effect.sync(() => lines.push(line))).pipe(
              Effect.forkScoped,
            );
            yield* agentRun.start;
            const done = yield* waitForSnapshot(handle, (current) =>
              statuses(current).includes('completed'),
            );
            const first = done.messages.find((message) => message.role === 'user');
            expect(first?.text).toBe(text);
            yield* waitForLines(lines, (written) =>
              written.some((line) => line.type === 'agent-run' && line.state === 'done'),
            );
            const states = lines.flatMap((line) => (line.type === 'agent-run' ? [line.state] : []));
            expect(states[0]).toBe('working');
            expect(states.at(-1)).toBe('done');
            const last = lines.at(-1);
            expect(last?.type === 'agent-run' && last.summary).toBeTruthy();
            expect(currentStatus(handle)).toBe('idle');
          }).pipe(
            Effect.scoped,
            Effect.provide(
              ThreadRuntime.layerForTests(
                { stateDir },
                // The fixture's first frame holds no MCP server, so the replay starts without one.
                { drivers: [replayClaudeDriver(transcript)], agentRunMcp: false },
              ),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.runPromise),
    REPLAY_TIMEOUT_MS,
  );
});
