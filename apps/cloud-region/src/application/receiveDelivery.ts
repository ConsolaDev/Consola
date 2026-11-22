import { type OutboxMessage, type ReadResult, readOutboxMessage } from '@consola/cloud-contract';
import type { Region } from '../domain/region.js';
import { copyChangeOf, placeMessage } from '../domain/workspaceCopy.js';
import type { DeliveryVerifier, WorkspaceCopies } from './ports.js';

/** What the cell makes of one outbox delivery, in the order it checks. */
export type DeliveryAnswer =
  /**
   * The cell has the message: this delivery applied it (`now`), or the cell had applied it
   * before, and the delivery changed nothing.
   */
  | { kind: 'applied'; message: OutboxMessage; now: boolean }
  /** The delivery is not signed by `cloud-global`. */
  | { kind: 'unsigned'; reason: string }
  /** Signed, but its payload is no message the contract reads. */
  | { kind: 'unreadable'; reason: string }
  /** A message about a workspace in another region, which this cell does not serve. */
  | { kind: 'other-region'; message: OutboxMessage }
  /** Messages of the workspace before this one are missing; `nextSequence` is the next. */
  | { kind: 'out-of-order'; message: OutboxMessage; nextSequence: number }
  /** `cloud-global`'s keys could not be had, so the delivery could not be checked. */
  | { kind: 'keys-unavailable' }
  /** The cell's database did not answer, so the message was not applied. */
  | { kind: 'database-unavailable'; message: OutboxMessage; reason: string };

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Reads a checked payload: UTF-8 text, JSON, then a message the contract reads. */
function readPayload(payload: Uint8Array): ReadResult<OutboxMessage> {
  let text: string;
  try {
    text = UTF8.decode(payload);
  } catch {
    return { ok: false, reason: 'the payload is not UTF-8' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the payload is not JSON' };
  }
  return readOutboxMessage(value);
}

/** The innermost cause's first line: what failed, without the query that failed. */
function whatFailed(error: unknown): string {
  let current = error;
  for (
    let depth = 0;
    current instanceof Error && current.cause !== undefined && depth < 5;
    depth++
  ) {
    current = current.cause;
  }
  const line = current instanceof Error ? current.message.split('\n')[0]?.trim() : undefined;
  return line || 'an unexpected error';
}

/**
 * How many times a message is placed against its workspace's copy. A message placed as the next
 * one loses its compare-and-set only to a delivery that applied it, or one after it, first, so
 * the second placement finds it applied: a third is never needed.
 */
const PLACEMENTS = 3;

/** Applies a message once, in its workspace's order, or says where that order stands. */
async function applyInOrder(
  copies: WorkspaceCopies,
  message: OutboxMessage,
): Promise<DeliveryAnswer> {
  const { workspaceId, sequence } = message;
  for (let placed = 0; placed < PLACEMENTS; placed++) {
    const lastApplied = await copies.lastApplied(workspaceId);
    const placement = placeMessage(sequence, lastApplied);
    if (placement.kind === 'applied-before') return { kind: 'applied', message, now: false };
    if (placement.kind === 'ahead') {
      return { kind: 'out-of-order', message, nextSequence: placement.nextSequence };
    }
    const step = {
      workspaceId,
      sequence,
      after: lastApplied,
      change: copyChangeOf(message.change),
    };
    if ((await copies.applyAfter(step)) === 'applied')
      return { kind: 'applied', message, now: true };
    // Another delivery moved the copy's sequence first: place the message again.
  }
  throw new Error(`the sequence of workspace ${workspaceId} kept moving`);
}

/**
 * Receives one outbox delivery, `delivery` being its body, for the cell serving `cellRegion`. It
 * checks, in the contract's order, that `cloud-global` signed it, that its payload is a message
 * the contract reads, that the message's workspace is in this cell's region, and that it is the
 * workspace's next message, and only then applies it, once. A message the cell has applied
 * already changes nothing.
 */
export async function receiveDelivery(
  ports: { deliveries: DeliveryVerifier; workspaceCopies: WorkspaceCopies },
  cellRegion: Region,
  delivery: string,
): Promise<DeliveryAnswer> {
  const signature = await ports.deliveries.verify(delivery);
  if (signature.kind !== 'verified') return signature;

  const read = readPayload(signature.payload);
  if (!read.ok) return { kind: 'unreadable', reason: read.reason };
  const message = read.value;

  if (message.region !== cellRegion) return { kind: 'other-region', message };

  try {
    return await applyInOrder(ports.workspaceCopies, message);
  } catch (error) {
    return { kind: 'database-unavailable', message, reason: whatFailed(error) };
  }
}
