import { describe, expect, it } from 'vitest';
import type { Harness } from '../../shared/harness';
import { agentHarnessView } from './agentHarness';

/** A harness record named Stub, on the claude driver unless `fields` say otherwise. */
function harness(fields: Partial<Harness> = {}): Harness {
  return {
    id: 'stub',
    driverId: 'claude',
    name: 'Stub',
    accentColor: '#888888',
    enabled: true,
    archived: false,
    isBuiltIn: false,
    extraArgs: [],
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

describe('agentHarnessView', () => {
  it('answers which harnesses can run steps', () => {
    expect(agentHarnessView(harness({ extraArgs: ['--max-turns', '50'] }))).toEqual({
      name: 'Stub',
      problem: null,
      stepProblem:
        "This harness's extra arguments set `--max-turns`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    });
  });

  it('names every flag a step turn compiles that the extra arguments set', () => {
    expect(
      agentHarnessView(harness({ extraArgs: ['--output-format=text', '--max-turns', '9'] }))
        .stepProblem,
    ).toBe(
      "This harness's extra arguments set `--output-format` and `--max-turns`, which would override what Consola launches each step's turn with. Remove them in Settings › Harnesses.",
    );
  });

  it('keeps today’s read-only refusal, and that is no step problem', () => {
    expect(agentHarnessView(harness({ extraArgs: ['--settings', '{}'] }))).toEqual({
      name: 'Stub',
      problem:
        "This harness's extra arguments (--settings) would loosen a read-only session, so automations cannot start sessions on it. Remove them in Settings › Harnesses, or make another harness this workspace’s default.",
      stepProblem: null,
    });
  });

  it('answers for the built-in Claude when the workspace has no harness', () => {
    expect(agentHarnessView(undefined)).toEqual({
      name: 'Claude',
      problem: null,
      stepProblem: null,
    });
  });

  it('a driver with no step turns to override has no step problem', () => {
    expect(
      agentHarnessView(harness({ driverId: 'codex', extraArgs: ['--max-turns', '50'] }))
        .stepProblem,
    ).toBeNull();
  });
});
