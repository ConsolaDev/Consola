import { describe, expect, it } from 'vitest';
import { CONTINUE_AFTER_RUN, continuationBlock } from './continuation';

describe('continuationBlock (slice 3-B Task 20)', () => {
  const step = {
    automation: { name: 'ui-bug-to-pr', runId: 'run-1', step: { id: 'fix', attempt: 1 } },
  };

  it.each(['queued', 'needs-approval', 'running', 'waiting'] as const)(
    "turns the button off while the step's run is %s",
    (status) => {
      expect(continuationBlock(step, [{ id: 'run-1', status }])).toBe(
        'Continue with full tools after the run ends',
      );
      expect(CONTINUE_AFTER_RUN).toBe('Continue with full tools after the run ends');
    },
  );

  it.each(['completed', 'failed', 'rejected'] as const)(
    'leaves it on once the run is %s',
    (status) => {
      expect(continuationBlock(step, [{ id: 'run-1', status }])).toBeNull();
    },
  );

  it('leaves it on for a run the snapshot no longer lists, a session that is no step, and before the snapshot loads', () => {
    expect(continuationBlock(step, [{ id: 'run-2', status: 'running' }])).toBeNull();
    expect(
      continuationBlock({ automation: { name: 'review', runId: 'run-1' } }, [
        { id: 'run-1', status: 'running' },
      ]),
    ).toBeNull();
    expect(continuationBlock({}, [{ id: 'run-1', status: 'running' }])).toBeNull();
    expect(continuationBlock(step, undefined)).toBeNull();
  });
});
