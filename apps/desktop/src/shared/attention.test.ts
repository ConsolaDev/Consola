import { describe, expect, it } from 'vitest';
import { activityOf, RANK, worstStatus, type Attention } from './attention';
import type { Session } from './workspace';

const session = { id: 's1', lastActiveAt: 100 } as Session;

describe('activityOf', () => {
  it('falls back to the session value when the ledger has no record', () => {
    expect(activityOf(session, undefined)).toBe(100);
  });

  it('prefers the ledger record', () => {
    expect(activityOf(session, { sessionId: 's1', workspaceId: 'w1', lastActiveAt: 500 })).toBe(500);
  });

  it('trusts a record even when it is older than the seed', () => {
    expect(activityOf(session, { sessionId: 's1', workspaceId: 'w1', lastActiveAt: 50 })).toBe(50);
  });
});

describe('worstStatus', () => {
  it('picks the most urgent, in the order needs-attention, done, working, ready, exited, settled', () => {
    const order: Attention[] = ['needs-attention', 'done', 'working', 'ready', 'exited', 'settled'];
    order.forEach((expected, index) => {
      expect(worstStatus([...order.slice(index)].reverse())).toBe(expected);
    });
  });

  it('ranks exited below ready: a finished process is not more urgent than a live one', () => {
    expect(worstStatus(['exited', 'ready'])).toBe('ready');
    expect(RANK.exited).toBeLessThan(RANK.ready);
  });

  it('is settled for an empty set', () => {
    expect(worstStatus([])).toBe('settled');
  });
});
