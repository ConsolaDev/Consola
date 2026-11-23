import { describe, expect, it } from 'vitest';
import { CONTINUE_AFTER_RUN as ENGINE } from '@consola/automation-engine';
import { TERMINAL_RUN_STATUSES } from '@consola/factory-spec';
import {
  CONTINUE_AFTER_RUN as RENDERER,
  continuationBlock,
} from '../../renderer/components/Terminal/continuation';

/**
 * The full-tools button's title and the engine's refusal are one sentence,
 * and the renderer turns the button off for exactly the runs the engine
 * still counts as open (slice 3-B Task 20). Two copies on purpose: the
 * renderer loads none of the engine's runtime.
 */
describe("the renderer's continuation words and the engine's", () => {
  it('are the same sentence', () => expect(RENDERER).toBe(ENGINE));

  it.each([
    'queued',
    'running',
    'needs-approval',
    'waiting',
    'completed',
    'failed',
    'rejected',
  ] as const)('agree on whether a %s run is open', (status) => {
    const session = { automation: { name: 'a', runId: 'r', step: { id: 's', attempt: 1 } } };
    expect(continuationBlock(session, [{ id: 'r', status }]) !== null).toBe(
      !TERMINAL_RUN_STATUSES.includes(status),
    );
  });
});
