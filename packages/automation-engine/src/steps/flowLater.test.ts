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
  it('names the first key the engine does not run yet', () => {
    expect(flowNotYet(entryWith(gateStep('decide')))).toBe(
      '`gate` runs from the next update; this automation does not run yet.',
    );
    expect(flowNotYet(entryWith(commandStep('a', { stop: true })))).toBe(
      '`then` runs from the next update; this automation does not run yet.',
    );
    expect(flowNotYet(entryWith(commandStep('a')))).toBeNull();
  });

  it('names repeat for a loop, and what a loop holds before it', () => {
    expect(flowNotYet(entryWith(loop('polish', commandStep('a'))))).toBe(
      '`repeat` runs from the next update; this automation does not run yet.',
    );
    expect(flowNotYet(entryWith(loop('polish', gateStep('decide'))))).toBe(
      '`gate` runs from the next update; this automation does not run yet.',
    );
    expect(flowNotYet(entryWith(loop('polish', commandStep('a', { stop: true }))))).toBe(
      '`then` runs from the next update; this automation does not run yet.',
    );
  });

  it('names on_failure on a step or on the entry, and budget', () => {
    expect(flowNotYet(entryWith(commandStep('a', { onFailure: { retry: 1 } })))).toBe(
      '`on_failure` runs from the next update; this automation does not run yet.',
    );
    expect(flowNotYet({ ...entryWith(commandStep('a')), onFailure: { retry: 1 } })).toBe(
      '`on_failure` runs from the next update; this automation does not run yet.',
    );
    expect(flowNotYet({ ...entryWith(commandStep('a')), budget: { usd: 5 } })).toBe(
      '`budget` runs from the next update; this automation does not run yet.',
    );
    // A retry of 0 is written, so it is refused as any other: the key is what the engine does not run.
    expect(flowNotYet(entryWith(commandStep('a', { onFailure: { retry: 0 } })))).toBe(
      '`on_failure` runs from the next update; this automation does not run yet.',
    );
    // `checkout: { pr: item }` means what absent means: nothing to lift.
    expect(flowNotYet({ ...entryWith(commandStep('a')), checkout: { pr: 'item' } })).toBeNull();
  });

  it('names gate before then when an entry writes both', () => {
    expect(flowNotYet(entryWith(commandStep('a', { stop: true }), gateStep('decide')))).toBe(
      '`gate` runs from the next update; this automation does not run yet.',
    );
  });
});
