import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  WAITING_FOR_CHECKOUT,
  type CommandResult,
} from '@consola/automation-engine';
import { CHECKOUT_WAIT } from '../../renderer/components/Automations/presentation';
import { COMMAND_STOPPED, COMMAND_TIMED_OUT } from '../../renderer/components/Automations/runPage';

/**
 * The renderer recognises some of the engine's words by their text, and may
 * not import the engine to read them (it takes the engine's types only). Main
 * may, so this is what keeps each pair one string.
 */
describe('words the renderer reads from the engine', () => {
  it("the checkout wait a run's row shows is the summary the engine gives it", () => {
    expect(WAITING_FOR_CHECKOUT).toBe("waiting for this item's checkout");
    expect(CHECKOUT_WAIT).toBe(WAITING_FOR_CHECKOUT);
  });

  it('a command step stopped or timed out fails with the words its retry warning looks for', () => {
    const ended = (changes: Partial<CommandResult>): CommandResult => ({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: false,
      stopped: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      ...changes,
    });
    expect(describeFailure(ended({ stopped: true }), 600_000)).toBe(COMMAND_STOPPED);
    expect(describeFailure(ended({ timedOut: true }), 600_000)).toMatch(COMMAND_TIMED_OUT);
    expect(describeFailure(ended({ timedOut: true }), 30_000)).toMatch(COMMAND_TIMED_OUT);
  });
});
