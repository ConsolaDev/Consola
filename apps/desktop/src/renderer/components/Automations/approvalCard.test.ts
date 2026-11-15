import { describe, expect, it } from 'vitest';
import type { RunDefinition } from '../../../shared/automations';
import { approvalNotes, dryRunCommands } from './approvalCard';

type Step = RunDefinition['automation']['steps'][number];

const agent = (id: string): Step =>
  ({ id, kind: 'agent', action: 'Review', outputs: {}, artifacts: [], reads: [], handover: 'required', named: true }) as Step;
const command = (id: string, dryRun: 'report' | 'run' = 'report'): Step =>
  ({ id, kind: 'run', run: 'git fetch', env: {}, outputs: {}, timeoutMs: 1000, dryRun, named: true }) as Step;

const definitionOf = (...steps: Step[]): RunDefinition => ({
  automation: { name: 'review', steps } as unknown as RunDefinition['automation'],
  version: 'v1',
  actions: {},
});

describe('approvalNotes', () => {
  it('says commands run as the person when there is one', () => {
    expect(approvalNotes(definitionOf(agent('review'), command('fresh')), null)).toEqual([
      'Its commands run as you (your logins, the bound GitHub account).',
    ]);
    expect(approvalNotes(definitionOf(agent('review'), command('fresh')), 'issue')).toHaveLength(1);
  });

  it("adds the pull request worktree note for a pull request's commands", () => {
    expect(approvalNotes(definitionOf(command('fresh')), 'pr')).toEqual([
      'Its commands run as you (your logins, the bound GitHub account).',
      "In a pull request's worktree, a command that builds or tests runs the author's code with your logins.",
    ]);
  });

  it('says nothing for agent steps only, pull request or not', () => {
    expect(approvalNotes(definitionOf(agent('review')), 'pr')).toEqual([]);
  });
});

describe('dryRunCommands', () => {
  it('lists the commands that run in a dry run, in file order', () => {
    const definition = definitionOf(command('fresh', 'run'), agent('review'), command('post'), command('tidy', 'run'));
    expect(dryRunCommands(definition)).toEqual(['fresh', 'tidy']);
  });

  it('is empty when no command opts in', () => {
    expect(dryRunCommands(definitionOf(agent('review'), command('post')))).toEqual([]);
  });
});
