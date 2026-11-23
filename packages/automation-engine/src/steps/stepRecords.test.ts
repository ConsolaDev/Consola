import { describe, expect, it } from 'vitest';
import type { StepRun } from '@consola/factory-spec';
import { retrySteps, withAttemptStarted } from './stepRecords';

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

describe('retrySteps (review M1)', () => {
  it("drops the earlier attempt's call, so the next attempt starts with none", () => {
    const failed: StepRun[] = [
      {
        id: 'post',
        kind: 'uses',
        status: 'failed',
        attempt: 1,
        error: '`slack#chat_post_message` reported an error: rate_limited.',
        startedAt: AT,
        finishedAt: AT,
        call: {
          server: { pgid: 4242, startedAt: 'Mon Nov 16 08:00:00 2026', ended: true },
          intentAt: AT,
          resultAt: AT,
          resultBytes: 40,
          isError: true,
        },
      },
    ];
    const [post] = retrySteps(failed, 'post', AT);
    expect(post).toMatchObject({ id: 'post', status: 'pending', attempt: 2 });
    expect(Object.prototype.hasOwnProperty.call(post, 'call')).toBe(false);
    expect(post.previous).toEqual([
      {
        attempt: 1,
        status: 'failed',
        error: '`slack#chat_post_message` reported an error: rate_limited.',
        finishedAt: AT,
      },
    ]);
  });
});
