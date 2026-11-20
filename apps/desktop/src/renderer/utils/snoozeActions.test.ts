import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SnoozeBatchResult } from '../../shared/preferences';

vi.mock('../services/attentionBridge', () => ({ attentionBridge: {} }));

let snoozeMessage: typeof import('./snoozeActions').snoozeMessage;
let wakeMessage: typeof import('./snoozeActions').wakeMessage;

beforeAll(async () => {
  ({ snoozeMessage, wakeMessage } = await import('./snoozeActions'));
});

const NOW = new Date(2026, 10, 19, 15, 0).getTime();
const TOMORROW_9 = new Date(2026, 10, 20, 9, 0).getTime();
const names = { a: 'Fix login', b: 'Bump deps', c: 'Docs', d: 'CI' };
const result = (applied: string[], until: number | null = TOMORROW_9): SnoozeBatchResult => ({
  applied,
  refused: [],
  memento: {},
  until,
});

describe('snoozeMessage', () => {
  it('names one session and when it comes back', () => {
    expect(snoozeMessage(result(['a']), ['a'], names, NOW)).toMatch(
      /^Snoozed Fix login until tomorrow at 9:00\sAM\.$/,
    );
  });

  it('counts a batch, and says how many could not be snoozed', () => {
    expect(snoozeMessage(result(['a', 'b', 'c']), ['a', 'b', 'c', 'd'], names, NOW)).toMatch(
      /^Snoozed 3 of 4 sessions until tomorrow at 9:00\sAM\. 1 could not be snoozed\.$/,
    );
    expect(snoozeMessage(result(['a', 'b']), ['a', 'b'], names, NOW)).toMatch(
      /^Snoozed 2 sessions until/,
    );
  });

  it('says why one could not be snoozed', () => {
    const refused: SnoozeBatchResult = {
      ...result([]),
      refused: [{ sessionId: 'a', reason: 'in-use', message: 'An automation is using it.' }],
    };
    expect(snoozeMessage(refused, ['a'], names, NOW)).toBe(
      'Could not snooze Fix login. An automation is using it.',
    );
  });

  it('says "their limits reset" when each waits for its own', () => {
    expect(snoozeMessage(result(['a', 'b'], null), ['a', 'b'], names, NOW)).toBe(
      'Snoozed 2 sessions until their limits reset.',
    );
  });
});

describe('wakeMessage', () => {
  it('says it is back in the list', () => {
    expect(wakeMessage({ applied: ['a'], refused: [], memento: {} }, ['a'], names)).toBe(
      'Woke Fix login. It is back in the list.',
    );
  });
});
