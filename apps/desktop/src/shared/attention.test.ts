import { describe, expect, it } from 'vitest';
import { activityOf } from './attention';
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
