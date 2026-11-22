import { describe, expect, it } from 'vitest';
import type { StepRun } from '@consola/factory-spec';
import { retryTargetOf as engineRetryTargetOf } from '@consola/automation-engine';
import { retryTargetOf as rendererRetryTargetOf } from '../../renderer/components/Automations/runPage';

/**
 * The run page's Retry sends the step the renderer's `retryTargetOf` names,
 * and the engine refuses any other id. Two copies exist on purpose (the
 * renderer loads none of the engine's runtime); this is what keeps them one
 * rule (review B1).
 */

const row = (id: string, status: StepRun['status'], extra: Partial<StepRun> = {}): StepRun => ({
  id,
  kind: 'agent',
  status,
  attempt: 1,
  ...extra,
});

const RECORDS: Array<[string, StepRun[], string | undefined]> = [
  [
    'a loop with a failed inner step',
    [
      row('fix', 'completed'),
      row('polish', 'failed', { kind: 'repeat', round: 2, max: 3 }),
      row('review', 'completed', { round: 2, attempt: 2 }),
      row('address', 'failed', { round: 2, attempt: 2, error: 'x' }),
      row('pr', 'not-run', { kind: 'run' }),
    ],
    'address',
  ],
  [
    'an exhausted loop',
    [
      row('fix', 'completed'),
      row('polish', 'failed', {
        kind: 'repeat',
        round: 3,
        max: 3,
        error: 'polish: not clean after 3 rounds',
      }),
      row('review', 'completed', { round: 3, attempt: 3 }),
      row('address', 'completed', { round: 3, attempt: 3 }),
      row('pr', 'not-run', { kind: 'run' }),
    ],
    'polish',
  ],
  [
    'a run that failed between steps',
    [row('fix', 'completed'), row('review', 'not-run'), row('pr', 'not-run', { kind: 'run' })],
    'review',
  ],
  [
    'a run with no loop that failed at a step',
    [row('fix', 'completed'), row('review', 'failed', { error: 'x' }), row('pr', 'not-run')],
    'review',
  ],
  [
    'a completed run',
    [row('fix', 'completed'), row('pr', 'completed', { kind: 'run' })],
    undefined,
  ],
];

describe('the two retry targets', () => {
  it.each(RECORDS)('agree on %s', (_, records, expected) => {
    expect(engineRetryTargetOf(records)?.id).toBe(expected);
    expect(rendererRetryTargetOf(records)?.id).toBe(expected);
  });
});
