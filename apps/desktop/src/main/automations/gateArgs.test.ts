import { describe, expect, it } from 'vitest';
import { gateArgs, gateAnswerArgs } from './gateArgs';

/*
 * What the renderer hands the gate's two channels is checked in main before
 * anything reaches the engine: only strings (3-A code review M10, the
 * guard D12 removed without a test failing).
 */

const NOT_STRINGS: unknown[] = [undefined, null, 7, {}, ['run-1'], true];

describe('gateArgs', () => {
  it('takes a run id and a step id', () => {
    expect(gateArgs('run-1', 'decide')).toEqual({ runId: 'run-1', stepId: 'decide' });
  });

  it.each(NOT_STRINGS)('refuses %j for either', (value) => {
    expect(() => gateArgs(value, 'decide')).toThrow('Run id and step id required.');
    expect(() => gateArgs('run-1', value)).toThrow('Run id and step id required.');
  });
});

describe('gateAnswerArgs', () => {
  it('takes a run id, a step id and a decision', () => {
    expect(gateAnswerArgs('run-1', 'decide', 'approve')).toEqual({
      runId: 'run-1',
      stepId: 'decide',
      decision: 'approve',
    });
  });

  it.each(NOT_STRINGS)('refuses %j for any of the three', (value) => {
    const refused = 'Run id, step id and decision required.';
    expect(() => gateAnswerArgs(value, 'decide', 'approve')).toThrow(refused);
    expect(() => gateAnswerArgs('run-1', value, 'approve')).toThrow(refused);
    expect(() => gateAnswerArgs('run-1', 'decide', value)).toThrow(refused);
  });
});
