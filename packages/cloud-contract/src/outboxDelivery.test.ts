import { describe, expect, it } from 'vitest';
import { CELL_TOKEN_KEYS_PATH } from './cellToken.js';
import { FIRST_SEQUENCE } from './outbox.js';
import {
  OUTBOX_ANSWER,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  OUTBOX_DELIVERY_PATH,
  OUTBOX_MESSAGE_TYPE,
  type OutOfOrderAnswer,
  readOutOfOrderAnswer,
} from './outboxDelivery.js';

const asSent = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const reasonFor = (value: unknown): string | null => {
  const result = readOutOfOrderAnswer(value);
  return result.ok ? null : result.reason;
};

describe('the outbox delivery', () => {
  it('is a path on the cell of its own, under /api, beside the key set', () => {
    expect(OUTBOX_DELIVERY_PATH.startsWith('/api/')).toBe(true);
    expect(OUTBOX_DELIVERY_PATH).not.toBe(CELL_TOKEN_KEYS_PATH);
  });

  it('is a compact JWS, typed as an outbox message', () => {
    expect(OUTBOX_DELIVERY_MEDIA_TYPE).toBe('application/jose');
    // A JWT's usual `typ`, which a cell token may carry, is never an outbox message's.
    expect(OUTBOX_MESSAGE_TYPE.toUpperCase()).not.toBe('JWT');
  });

  it('is confirmed by a 2xx alone, and every other answer is one of its own', () => {
    const statuses = Object.values(OUTBOX_ANSWER);
    expect(new Set(statuses).size).toBe(statuses.length);
    const confirming = statuses.filter((status) => status >= 200 && status < 300);
    expect(confirming).toEqual([OUTBOX_ANSWER.applied]);
  });
});

describe('readOutOfOrderAnswer', () => {
  it('reads the sequence the cell applies next', () => {
    const answer: OutOfOrderAnswer = { nextSequence: 3 };
    expect(readOutOfOrderAnswer(asSent(answer))).toEqual({ ok: true, value: answer });
  });

  it('reads a cell that holds nothing of the workspace yet', () => {
    expect(readOutOfOrderAnswer(asSent({ nextSequence: FIRST_SEQUENCE }))).toEqual({
      ok: true,
      value: { nextSequence: FIRST_SEQUENCE },
    });
  });

  it('refuses what is not an object', () => {
    expect(reasonFor(null)).toBe('the answer is not an object');
    expect(reasonFor([3])).toBe('the answer is not an object');
    expect(reasonFor('3')).toBe('the answer is not an object');
  });

  it('refuses an answer with no `nextSequence`', () => {
    expect(reasonFor({})).toBe('the answer has no `nextSequence`');
  });

  it('refuses a field the contract does not name', () => {
    expect(reasonFor({ nextSequence: 3, workspaceId: 'workspace-acme' })).toBe(
      'the answer has `workspaceId`, which the contract does not name',
    );
  });

  it('refuses a `nextSequence` that is not a whole number from 1', () => {
    const reason = '`nextSequence` is not a whole number from 1';
    expect(reasonFor({ nextSequence: 0 })).toBe(reason);
    expect(reasonFor({ nextSequence: -2 })).toBe(reason);
    expect(reasonFor({ nextSequence: 2.5 })).toBe(reason);
    expect(reasonFor({ nextSequence: '3' })).toBe(reason);
    expect(reasonFor({ nextSequence: Number.MAX_SAFE_INTEGER + 1 })).toBe(reason);
  });
});
