import { readOutboxMessage } from '@consola/cloud-contract';
import type { Region } from '@consola/cloud-contract';
import { retryDelayMs } from '../domain/outbox.js';
import type {
  CellDelivery,
  DeliveryAnswer,
  OutboxMessageKey,
  OutboxSigner,
  OutboxStore,
  UndeliveredMessage,
} from './ports.js';

/** What became of one message in a pass, in ids and statuses only. */
export type DeliveryOutcome =
  | { kind: 'delivered'; key: OutboxMessageKey; attempts: number; status: number }
  | {
      kind: 'failed';
      key: OutboxMessageKey;
      attempts: number;
      error: string;
      nextAttemptAt: Date;
    };

export type OutboxPass = {
  /** Every delivery the pass made, in the order each ended. */
  outcomes: DeliveryOutcome[];
  /** The regions that have messages waiting and no cell to deliver them to. */
  waiting: Region[];
  /**
   * When the earliest message left to deliver is due, or null when none is left. A region with
   * no cell does not count: nothing it holds can be delivered until its cell is configured.
   */
  nextDueAt: Date | null;
};

/**
 * One pass through the outbox: every message that is due is delivered to its workspace's cell,
 * and the pass ends when none is left that can be sent now.
 *
 * - Each workspace's messages go in sequence order, one at a time: the next is sent only once
 *   the cell has confirmed the one before (a 2xx), so the order per workspace is kept, and none
 *   is ever skipped.
 * - Workspaces are delivered side by side, so a message that fails, or a cell that is slow to
 *   answer, holds up its own workspace alone.
 * - A failed delivery is recorded with its reason and tried again after `retryDelayMs`, which
 *   grows with each failure up to a cap. A message is never given up on.
 * - A region with no cell keeps its messages as they are, and is reported in `waiting`.
 * - A stored message is read with the contract's reader before it is signed. One that does not
 *   read is never sent, and fails, with the reader's reason, like a refused delivery.
 *
 * It does no I/O of its own: `now` is the clock, and `signal` stops the pass early, abandoning
 * the delivery in flight without recording it, so it is sent again later.
 */
export async function deliverOutbox(
  ports: { outbox: OutboxStore; signer: OutboxSigner; cells: CellDelivery },
  options: { now: () => Date; signal?: AbortSignal },
): Promise<OutboxPass> {
  const { outbox, signer, cells } = ports;
  const { now, signal } = options;
  const outcomes: DeliveryOutcome[] = [];
  const waiting = new Set<Region>();
  let nextDueAt: Date | null = null;
  const dueLater = (at: Date) => {
    if (nextDueAt === null || at < nextDueAt) nextDueAt = at;
  };

  async function send(message: UndeliveredMessage): Promise<DeliveryAnswer | 'waits'> {
    const read = readOutboxMessage(message.stored);
    if (read.ok && !cells.reaches(read.value.region)) {
      waiting.add(read.value.region);
      return 'waits';
    }
    if (message.nextAttemptAt !== null && message.nextAttemptAt > now()) {
      dueLater(message.nextAttemptAt);
      return 'waits';
    }
    if (!read.ok) {
      return { kind: 'failed', error: `the stored message does not read: ${read.reason}` };
    }
    return cells.deliver(read.value.region, await signer.signOutboxMessage(read.value), signal);
  }

  async function deliverWorkspace(first: UndeliveredMessage): Promise<void> {
    let message: UndeliveredMessage | null = first;
    while (message !== null && !signal?.aborted) {
      const answer = await send(message);
      if (answer === 'waits' || answer.kind === 'stopped') return;

      const { key } = message;
      const attempts = message.attempts + 1;
      const at = now();
      if (answer.kind === 'confirmed') {
        await outbox.recordDelivered(key, at);
        outcomes.push({ kind: 'delivered', key, attempts, status: answer.status });
        message = await outbox.firstUndeliveredOf(key.workspaceId);
        continue;
      }
      const nextAttemptAt = new Date(at.getTime() + retryDelayMs(attempts));
      await outbox.recordFailed(key, { at, error: answer.error, nextAttemptAt });
      outcomes.push({ kind: 'failed', key, attempts, error: answer.error, nextAttemptAt });
      dueLater(nextAttemptAt);
      return;
    }
  }

  // Every workspace runs to its end before the pass does, even when one fails, so no delivery
  // from this pass is still in flight when the next begins.
  const ended = await Promise.allSettled((await outbox.firstUndelivered()).map(deliverWorkspace));
  const failure = ended.find((each) => each.status === 'rejected');
  if (failure) throw failure.reason;

  return { outcomes, waiting: [...waiting].sort(), nextDueAt };
}
