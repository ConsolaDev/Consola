import { describe, expect, it } from 'vitest';
import type { CommandStep, GateStep, Step, StepsAutomation } from '@consola/factory-spec';
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

function entryWith(...steps: Step[]): StepsAutomation {
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
  it('names the first key the engine does not run yet', () => {
    expect(flowNotYet(entryWith(gateStep('decide')))).toBe(
      '`gate` runs from the next update; this automation does not run yet.',
    );
    expect(flowNotYet(entryWith(commandStep('a', { stop: true })))).toBe(
      '`then` runs from the next update; this automation does not run yet.',
    );
    expect(flowNotYet(entryWith(commandStep('a')))).toBeNull();
  });

  it('names gate before then when an entry writes both', () => {
    expect(flowNotYet(entryWith(commandStep('a', { stop: true }), gateStep('decide')))).toBe(
      '`gate` runs from the next update; this automation does not run yet.',
    );
  });
});
