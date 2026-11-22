import { describe, expect, it } from 'vitest';
import type { RunDefinition } from '../../../shared/automations';
import { approvalAgent, approvalNotes, dryRunCommands } from './approvalCard';

type Step = RunDefinition['automation']['steps'][number];

const agent = (id: string): Step =>
  ({
    id,
    kind: 'agent',
    action: 'Review',
    outputs: {},
    artifacts: [],
    reads: [],
    handover: 'required',
    named: true,
  }) as Step;
const command = (id: string, dryRun: 'report' | 'run' = 'report'): Step =>
  ({
    id,
    kind: 'run',
    run: 'git fetch',
    env: {},
    outputs: {},
    timeoutMs: 1000,
    dryRun,
    named: true,
  }) as Step;

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
    const definition = definitionOf(
      command('fresh', 'run'),
      agent('review'),
      command('post'),
      command('tidy', 'run'),
    );
    expect(dryRunCommands(definition)).toEqual(['fresh', 'tidy']);
  });

  it('is empty when no command opts in', () => {
    expect(dryRunCommands(definitionOf(agent('review'), command('post')))).toEqual([]);
  });
});

describe('approvalAgent', () => {
  const look = { ...agent('look'), action: undefined, agent: 'reviewer' } as Step;
  const tell = { ...agent('tell'), action: undefined, prompt: 'Turn it into a note.' } as Step;
  const withAgents = (agents: RunDefinition['agents']): RunDefinition => ({
    ...definitionOf(look, tell),
    ...(agents ? { agents } : {}),
  });

  it("gives a step's agent as its node words, its file, description and body", () => {
    const definition = withAgents({
      look: {
        name: 'reviewer',
        hash: 'a'.repeat(64),
        harnessId: 'claude-work',
        model: 'opus',
        description: "Reviews catalog-portal's changes.",
        body: 'Read what changed.\n',
        mcpServers: [],
        skills: [],
      },
    });
    expect(approvalAgent(definition, 'look')).toEqual({
      words: 'reviewer · claude-work · opus',
      file: 'agents/reviewer.md',
      description: "Reviews catalog-portal's changes.",
      body: 'Read what changed.\n',
      head: 'Agent, read-only',
      servers: [],
      skills: null,
      readsOthers: false,
    });
  });

  it('gives a body-only agent its name and body, with no description', () => {
    const definition = withAgents({
      look: {
        name: 'noter',
        hash: 'b'.repeat(64),
        body: 'Write a note.\n',
        mcpServers: [],
        skills: [],
      },
    });
    const shown = approvalAgent(definition, 'look');
    expect(shown).toEqual({
      words: 'noter',
      file: 'agents/noter.md',
      body: 'Write a note.\n',
      head: 'Agent, read-only',
      servers: [],
      skills: null,
      readsOthers: false,
    });
    expect(Object.prototype.hasOwnProperty.call(shown, 'description')).toBe(false);
  });

  it("gives its agent's servers, skills and the item line, with no tool names (2-C)", () => {
    const investigator = {
      name: 'investigator',
      hash: 'c'.repeat(64),
      harnessId: 'stub-work',
      model: 'opus',
      body: 'INVESTIGATOR-BODY-1\n',
      mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
      skills: ['incident-triage'],
    };
    const reading = { ...withAgents({ look: investigator }), readsItems: true as const };
    expect(approvalAgent(reading, 'look')).toMatchObject({
      words: 'investigator · stub-work · opus',
      head: 'Agent, read-only but for its servers',
      servers: [
        'claude.ai Coralogix: all its tools, including any that post or change things',
        'grafana: query_logs only',
      ],
      skills: 'Skills: incident-triage',
      readsOthers: true,
    });
    // A cron entry's run, or a definition from before 2-C, has no `readsItems`.
    expect(approvalAgent(withAgents({ look: investigator }), 'look')?.readsOthers).toBe(false);
  });

  it('is null for a step with no agent', () => {
    expect(approvalAgent(withAgents(undefined), 'tell')).toBeNull();
    expect(
      approvalAgent(
        withAgents({
          look: { name: 'noter', hash: 'b'.repeat(64), body: 'x', mcpServers: [], skills: [] },
        }),
        'tell',
      ),
    ).toBeNull();
  });
});
