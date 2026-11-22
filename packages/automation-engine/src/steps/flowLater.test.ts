import { describe, expect, it } from 'vitest';
import type {
  CommandStep,
  GateStep,
  RepeatStep,
  Step,
  StepEntry,
  StepsAutomation,
} from '@consola/factory-spec';
import { flowNotYet } from './flowLater';

function commandStep(id: string, extra: Partial<CommandStep> = {}): CommandStep {
  return {
    kind: 'run',
    id,
    named: true,
    run: 'echo',
    env: {},
    outputs: {},
    timeoutMs: 600_000,
    dryRun: 'report',
    ...extra,
  };
}

function gateStep(id: string, extra: Partial<GateStep> = {}): GateStep {
  return { kind: 'gate', id, named: true, ask: 'Post it?', show: [], ...extra };
}

function loop(id: string, ...steps: Step[]): RepeatStep {
  return { kind: 'repeat', id, named: true, max: 2, until: 'steps.a.ok', steps };
}

function entryWith(...steps: StepEntry[]): StepsAutomation {
  return {
    name: 'gated',
    trigger: {
      kind: 'event',
      connection: 'github',
      events: ['pull_request.review_requested'],
      params: {},
    },
    mode: 'auto',
    steps,
  };
}

describe('flowNotYet', () => {
  it('runs gates and then: stop: an entry with one is not refused for it', () => {
    expect(flowNotYet(entryWith(gateStep('decide')))).toBeNull();
    expect(flowNotYet(entryWith(commandStep('a', { stop: true })))).toBeNull();
    expect(flowNotYet(entryWith(commandStep('a')))).toBeNull();
  });

  it('runs loops and retries: an entry with them is not refused for them', () => {
    expect(flowNotYet(entryWith(loop('polish', commandStep('a'))))).toBeNull();
    expect(flowNotYet(entryWith(loop('polish', gateStep('decide'))))).toBeNull();
    expect(flowNotYet(entryWith(commandStep('a', { onFailure: { retry: 1 } })))).toBeNull();
    expect(flowNotYet({ ...entryWith(commandStep('a')), onFailure: { retry: 1 } })).toBeNull();
  });

  it('names budget, the one key it does not run yet', () => {
    expect(flowNotYet({ ...entryWith(commandStep('a')), budget: { usd: 5 } })).toBe(
      '`budget` runs from the next update; this automation does not run yet.',
    );
    expect(
      flowNotYet({
        ...entryWith(gateStep('decide'), loop('polish', commandStep('a'))),
        onFailure: { retry: 1 },
        budget: { usd: 5 },
      }),
    ).toBe('`budget` runs from the next update; this automation does not run yet.');
    // `checkout: { pr: item }` means what absent means: nothing to lift.
    expect(flowNotYet({ ...entryWith(commandStep('a')), checkout: { pr: 'item' } })).toBeNull();
  });
});
