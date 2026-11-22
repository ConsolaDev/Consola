import { describe, expect, it } from 'vitest';
import type { StepRun } from '@consola/factory-spec';
import { withAttemptStarted } from './stepRecords';

const AT = '2026-11-22T08:00:00.000Z';

const records = (): StepRun[] => [
  {
    id: 'look',
    kind: 'agent',
    status: 'queued',
    attempt: 1,
    sessionId: 'session-old',
    conversation: { harnessId: 'claude', id: 'conversation-old' },
  },
  { id: 'tell', kind: 'agent', status: 'pending', attempt: 1 },
];

describe('withAttemptStarted', () => {
  it('records the agent the step runs as', () => {
    const [look, tell] = withAttemptStarted(records(), 'look', AT, 'investigator');
    expect(look).toEqual({
      id: 'look',
      kind: 'agent',
      status: 'running',
      attempt: 1,
      startedAt: AT,
      agent: 'investigator',
    });
    expect(tell).toEqual(records()[1]);
  });

  it('writes no agent without one', () => {
    const [look] = withAttemptStarted(records(), 'look', AT);
    expect(look).toEqual({
      id: 'look',
      kind: 'agent',
      status: 'running',
      attempt: 1,
      startedAt: AT,
    });
    expect(Object.prototype.hasOwnProperty.call(look, 'agent')).toBe(false);
  });
});
