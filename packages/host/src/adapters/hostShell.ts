/**
 * t3's shell for one session: the thread list t3's client keeps beside a thread, which it loads
 * over HTTP (`GET /api/orchestration/shell`, t3's `orchestration-v2/http.ts` `"shellSnapshot"`)
 * and then follows over the socket (`orchestration.subscribeShell`, `ws.ts`
 * `subscribeOrchestrationV2Shell`), both read from the session's rows (`ThreadHandle.shell`): its
 * project and its thread, nothing else. t3's client opens no thread its shell says is not there,
 * and reads a listed thread's title and status from its row, so the row is the thread's own,
 * read from the store its projection is read from, and sent again after each of its events.
 *
 * Both follow t3's composition, with the lifted `ShellStream.ts` helpers, for one thread: a
 * snapshot, then the completion marker the client asks for, then the thread's row after each
 * batch of its stored events. What t3 adds and the host leaves out: repository identities and
 * their enrichment refreshes (the host resolves none, and its descriptor says so), idle subagents
 * and older settled threads (the host lists one thread, and offers neither), and the archive.
 */
import {
  type OrchestrationV2ShellHttpSnapshot,
  type OrchestrationV2ShellResumable,
  type OrchestrationV2ShellStreamItem,
  OrchestrationV2GetShellSnapshotError,
  type OrchestrationV2SubscribeShellInput,
} from '@t3tools/contracts';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import {
  bufferShellLiveStream,
  coalesceShellApplicationEvents,
  projectIdentitiesDigest,
  type ShellApplicationEvent,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  skipUnchangedThreadShells,
  toShellApplicationEvent,
} from 't3/orchestration-v2/ShellStream.ts';
import { rpcInitialItems } from 't3/rpcInitialItems.ts';
import type { ThreadHandle } from '../runtime/threadRuntime.ts';

/** t3's `toShellStream` (`ws.ts`): events are gathered for up to 50 ms, 512 at most, per row read. */
const SHELL_BATCH_SIZE = 512;
const SHELL_BATCH_WINDOW = Duration.millis(50);

/**
 * Whether a client that holds the session's shell at `cursor` can keep its rows and be sent what
 * followed (t3's `canResumeShellFrom`, which the socket's resume and the HTTP route's `resumeFrom`
 * both ask). t3's limits on a replay (its gap, its bytes, what was pruned) bound the rows it
 * reads again for every event between; for one thread that is one row, read once, whatever the
 * gap. A cursor past the thread's last event is from another store (a host restarted under the
 * client) and is answered with a snapshot.
 */
export const canResumeShell = (cursor: number, highWater: number): boolean =>
  cursor >= 0 && cursor <= highWater;

/**
 * The HTTP route's answer (`OrchestrationV2ShellHttpSnapshot`, or `resumable` for a `resumeFrom`
 * the socket can resume from, as t3's `loadShellUnlessResumable`), with the digest t3 names its
 * projects' repository identities by.
 */
export const shellHttpAnswer = (
  runtime: ThreadHandle,
  resumeFrom: number | undefined,
): Effect.Effect<
  OrchestrationV2ShellHttpSnapshot | OrchestrationV2ShellResumable,
  OrchestrationV2GetShellSnapshotError
> =>
  resumeFrom !== undefined && canResumeShell(resumeFrom, runtime.snapshotSequence())
    ? Effect.succeed({ resumable: true as const })
    : runtime.shell.snapshot.pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          projectIdentities: projectIdentitiesDigest(snapshot.projects),
        })),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: 'Failed to load the application shell',
              cause,
            }),
        ),
      );

/**
 * t3's `subscribeOrchestrationV2Shell` over the session's rows. With no cursor: the snapshot, the
 * completion marker if asked for, then the thread's row after each batch of its events. With a
 * cursor it can resume from: the thread's row as it is now if anything followed the cursor, the
 * marker, then the same updates; with one it cannot: `snapshot-required` for a client that asked
 * for it (`httpSnapshotFallback`), else the snapshot.
 */
export const subscribeHostShell = (
  runtime: ThreadHandle,
  input: OrchestrationV2SubscribeShellInput,
): Stream.Stream<OrchestrationV2ShellStreamItem, OrchestrationV2GetShellSnapshotError> => {
  const threadItems = (events: ReadonlyArray<ShellApplicationEvent>) =>
    Effect.forEach(coalesceShellApplicationEvents(events), (stored) =>
      'aggregateKind' in stored
        ? Effect.succeed([])
        : Effect.map(runtime.shell.thread, (shell) => [
            shellStreamItemFromThreadShell({ stored, shell }),
          ]),
    ).pipe(Effect.map((items) => items.flat()));

  // t3's `liveFrom`: the thread's stored events after the cursor (replayed, then live), each
  // batch answered by its row now, an unchanged row not sent again within t3's window, and the
  // live tail buffered by t3's budget.
  const liveFrom = (afterSequence: number) =>
    bufferShellLiveStream(
      runtime.events(afterSequence).pipe(
        Stream.map(toShellApplicationEvent),
        Stream.groupedWithin(SHELL_BATCH_SIZE, SHELL_BATCH_WINDOW),
        Stream.mapEffect((events) => threadItems(Array.from(events))),
        Stream.flatMap(Stream.fromIterable),
        skipUnchangedThreadShells,
      ),
    );

  const completionMarker: Stream.Stream<OrchestrationV2ShellStreamItem> =
    input.requestCompletionMarker === true
      ? Stream.make({ kind: 'synchronized' as const })
      : Stream.empty;
  const completionThenLive = (afterSequence: number) =>
    Stream.concat(completionMarker, liveFrom(afterSequence));

  const fromSnapshot = Effect.map(runtime.shell.snapshot, (snapshot) =>
    Stream.concat(
      rpcInitialItems(
        shellStreamItemsFromInitialSnapshot({ snapshot, resolvedRepositoryIdentityRoots: [] }),
      ),
      completionThenLive(snapshot.snapshotSequence),
    ),
  );

  return Stream.unwrap(
    Effect.gen(function* () {
      const { afterSequence } = input;
      if (afterSequence === undefined) return yield* fromSnapshot;
      const highWater = runtime.snapshotSequence();
      if (!canResumeShell(afterSequence, highWater)) {
        return input.httpSnapshotFallback === true
          ? Stream.make({ kind: 'snapshot-required' as const })
          : yield* fromSnapshot;
      }
      const replay =
        afterSequence === highWater
          ? []
          : yield* threadItems([
              { sequence: highWater, event: { threadId: runtime.snapshot().thread.id } },
            ]);
      return Stream.concat(rpcInitialItems(replay), completionThenLive(highWater));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: 'Failed to prepare the application shell stream',
            cause,
          }),
      ),
    ),
  ).pipe(
    Stream.mapError((cause) =>
      cause._tag === 'OrchestrationV2GetShellSnapshotError'
        ? cause
        : new OrchestrationV2GetShellSnapshotError({
            message: 'Failed while streaming the application shell',
            cause,
          }),
    ),
  );
};
