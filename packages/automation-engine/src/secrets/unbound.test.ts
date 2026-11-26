import { parseAutomationEntry } from '@consola/factory-spec';
import type { Automation } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import type { SecretsPort } from './secretsPort';
import { NO_SECRETS, unboundOf, unboundProblem } from './unbound';

const H = 'on this Mac (Settings › Secrets)';

const entry = (yaml: string): Automation => {
  const parsed = parseAutomationEntry(yaml);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.automation;
};

/** A port that has bound `bound`, and is asked nothing else here. */
const portBinding = (...bound: string[]): SecretsPort => ({
  bindHint: H,
  boundNames: () => new Set(bound),
  describe: () => null,
  fingerprint: () => null,
  resolve: async () => {
    throw new Error('not read here');
  },
});

const USES_A_AND_B = entry(
  [
    '- name: page',
    '  on: { cron: "0 9 * * 1-5" }',
    '  scope: api',
    '  steps:',
    '    - run: page "$A"',
    '      secrets: [A]',
    '    - run: track "$B"',
    '      secrets: [B]',
  ].join('\n'),
);

describe('unboundProblem', () => {
  it('names one, two or more, as every resolve problem reads', () => {
    expect(unboundProblem(['A'], H)).toBe(`needs \`A\` bound ${H}`);
    expect(unboundProblem(['A', 'B'], H)).toBe(`needs \`A\` and \`B\` bound ${H}`);
    expect(unboundProblem(['A', 'B', 'C'], H)).toBe(`needs \`A\`, \`B\` and \`C\` bound ${H}`);
  });

  it('says a runner with no port cannot bind', () => {
    expect(NO_SECRETS).toBe("this runner can't bind secrets, so `secrets:` can't run here");
  });
});

describe('unboundOf', () => {
  it('is what the entry uses less what the port has bound', () => {
    expect(unboundOf(USES_A_AND_B, portBinding('B'), 'ws-1')).toEqual({
      problem: `needs \`A\` bound ${H}`,
      unbound: ['A'],
    });
    expect(unboundOf(USES_A_AND_B, portBinding(), 'ws-1')).toEqual({
      problem: `needs \`A\` and \`B\` bound ${H}`,
      unbound: ['A', 'B'],
    });
    expect(unboundOf(USES_A_AND_B, portBinding('A', 'B'), 'ws-1')).toBeNull();
  });

  it('asks nothing of an entry that names none, port or no port', () => {
    const none = entry(
      '- name: p\n  on: { cron: "0 9 * * 1-5" }\n  scope: api\n  run: { prompt: "x" }',
    );
    expect(unboundOf(none, undefined, 'ws-1')).toBeNull();
    expect(unboundOf(none, portBinding(), 'ws-1')).toBeNull();
  });

  it('with no port, every name is unbound and says why', () => {
    expect(unboundOf(USES_A_AND_B, undefined, 'ws-1')).toEqual({
      problem: NO_SECRETS,
      unbound: ['A', 'B'],
    });
  });

  it('names a command inside a repeat: loop (the merge with slice 3)', () => {
    const loop = entry(
      [
        '- name: loop-page',
        '  on: manual',
        '  scope: api',
        '  steps:',
        '    - id: polish',
        '      repeat: { max: 3, until: steps.check.clean }',
        '      steps:',
        '        - id: check',
        '          run: page "$PAGER_TOKEN"',
        '          secrets: [PAGER_TOKEN]',
        '          outputs: { clean: { type: boolean } }',
      ].join('\n'),
    );
    expect(unboundOf(loop, portBinding(), 'ws-1')).toEqual({
      problem: 'needs `PAGER_TOKEN` bound on this Mac (Settings › Secrets)',
      unbound: ['PAGER_TOKEN'],
    });
    expect(unboundOf(loop, portBinding('PAGER_TOKEN'), 'ws-1')).toBeNull();
  });

  it("counts a check's name", () => {
    const watch = entry(
      [
        '- name: watch',
        '  on: { poll: { every: 30m, run: tracker list, key: .id, secrets: [TRACKER_TOKEN] } }',
        '  scope: api',
        '  run: { prompt: "Look." }',
      ].join('\n'),
    );
    expect(unboundOf(watch, portBinding(), 'ws-1')).toEqual({
      problem: `needs \`TRACKER_TOKEN\` bound ${H}`,
      unbound: ['TRACKER_TOKEN'],
    });
  });
});
