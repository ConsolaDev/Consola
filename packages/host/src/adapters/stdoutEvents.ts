import type { OrchestrationV2ThreadProjection } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { isActiveRun } from 't3/orchestration-v2/CommandPolicy.ts';
import type { ThreadHandle } from '../runtime/threadRuntime.ts';

/**
 * What the session is doing, as whoever started the host shows it: `waiting` while a runtime
 * request (an approval or a question) waits on the person, `working` while a run is active, and
 * `idle` otherwise.
 */
export type SessionStatus = 'working' | 'waiting' | 'idle';

/**
 * One line of the host's stdout, which carries these and nothing else: it is how Track B's
 * runner (or a person running the host) learns what the host is doing. t3's logs go to stderr.
 *
 * - `ready`: the host serves the session at `port` (the one it got, for `--port 0`). It is idle,
 *   and the thread has its first title.
 * - `dev-pass`: with `--dev` only, right after `ready`: a pass for the session.
 * - `title`, `status`: the thread's title or the session's status changed.
 * - `exit`: the host is stopping by itself (`idle`); the process exits 0 once it has stopped.
 */
export type HostLine =
  | { readonly type: 'ready'; readonly port: number }
  | { readonly type: 'dev-pass'; readonly pass: string; readonly expiresInSeconds: number }
  | { readonly type: 'title'; readonly title: string }
  | { readonly type: 'status'; readonly status: SessionStatus }
  | { readonly type: 'exit'; readonly reason: 'idle' };

/** Every `type` a `HostLine` has: the runner may refuse any other. */
export const HOST_LINE_TYPES: ReadonlyArray<HostLine['type']> = [
  'ready',
  'dev-pass',
  'title',
  'status',
  'exit',
];

/** A `HostLine` as printed: one JSON object on one line. */
export const encodeHostLine = (line: HostLine): string => `${JSON.stringify(line)}\n`;

/**
 * Prints one line on stdout and waits until Node has handed it on (a pipe to the runner is
 * asynchronous on macOS), so a process that exits right after loses no line.
 */
export const writeHostLine = (line: HostLine): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    process.stdout.write(encodeHostLine(line), () => resume(Effect.void));
  });

/**
 * The session's status from t3's projection of its thread: a pending runtime request (t3's
 * `runtimeRequests[].status`) is `waiting`, an active run (t3's own `isActiveRun`: preparing,
 * starting, running or waiting) is `working`, and anything else is `idle`.
 */
export function sessionStatusOf(
  projection: Pick<OrchestrationV2ThreadProjection, 'runs' | 'runtimeRequests'>,
): SessionStatus {
  if (projection.runtimeRequests.some((request) => request.status === 'pending')) return 'waiting';
  if (projection.runs.some(isActiveRun)) return 'working';
  return 'idle';
}

/**
 * Follows the thread's projection (`handle.snapshots()`) and writes a `status` line when the
 * session's status changes and a `title` line when t3 retitles the thread, each only on a change
 * from what was last said: `ready` said idle and the thread's title when this starts.
 */
export const reportSession = (
  handle: ThreadHandle,
  write: (line: HostLine) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    let status: SessionStatus = 'idle';
    let title = handle.snapshot().thread.title;
    yield* handle.snapshots().pipe(
      Stream.runForEach((projection) =>
        Effect.gen(function* () {
          const nextStatus = sessionStatusOf(projection);
          if (nextStatus !== status) {
            status = nextStatus;
            yield* write({ type: 'status', status });
          }
          if (projection.thread.title !== title) {
            title = projection.thread.title;
            yield* write({ type: 'title', title });
          }
        }),
      ),
    );
  });
