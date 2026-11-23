import { describe, expect, it } from 'vitest';
import type { RunDefinition } from '../../../shared/automations';
import {
  approvalAgent,
  approvalNotes,
  approvalSkills,
  definitionEntries,
  definitionLeaves,
  definitionRows,
  dryRunCommands,
  gateChoicesWords,
  loopFoot,
  writeBlocks,
} from './approvalCard';

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

const loop = (id: string, ...steps: Step[]): Step =>
  ({
    id,
    kind: 'repeat',
    named: true,
    max: 3,
    until: 'steps.review.findings == 0',
    steps,
  }) as unknown as Step;

describe('a definition with a loop (slice 3)', () => {
  it('names the commands of an entry whose only command is inside a loop', () => {
    const definition = definitionOf(
      agent('review'),
      loop('polish', agent('again'), command('check', 'run')),
    );
    expect(approvalNotes(definition, null)).toEqual([
      'Its commands run as you (your logins, the bound GitHub account).',
    ]);
    expect(dryRunCommands(definition)).toEqual(['check']);
  });

  it('walks the tree in record order, and its leaves in file order', () => {
    const definition = definitionOf(
      command('fresh'),
      loop('polish', agent('review'), command('check')),
      command('pr'),
    );
    expect(
      definitionEntries(definition.automation.steps).map(({ step, loop: block }) => [
        step.id,
        block,
      ]),
    ).toEqual([
      ['fresh', undefined],
      ['polish', undefined],
      ['review', 'polish'],
      ['check', 'polish'],
      ['pr', undefined],
    ]);
    expect(definitionLeaves(definition.automation.steps).map((step) => step.id)).toEqual([
      'fresh',
      'review',
      'check',
      'pr',
    ]);
  });

  it("lists a loop's steps under it", () => {
    // North-star §4.1's steps, as the approval card draws them.
    const SECTION_41_AUTOMATION = definitionOf(
      agent('triage'),
      command('not-ours'),
      agent('fix'),
      loop('polish', agent('review'), agent('address')),
      command('pr'),
      command('ticket'),
    ).automation;
    expect(
      definitionRows(SECTION_41_AUTOMATION).map(({ step, depth }) => [step.id, depth]),
    ).toEqual([
      ['triage', 0],
      ['not-ours', 0],
      ['fix', 0],
      ['polish', 0],
      ['review', 1],
      ['address', 1],
      ['pr', 0],
      ['ticket', 0],
    ]);
  });

  it("words a loop's foot by how it ends, and a gate's choices with Reject last", () => {
    expect(loopFoot('fail')).toBe('then fails');
    expect(loopFoot('continue')).toBe('then goes on');
    expect(loopFoot('gate')).toBe('then asks you');
    expect(loopFoot(undefined)).toBe('then fails');
    expect(gateChoicesWords(['approve', 'request-changes'])).toBe(
      'Approve, Request changes or Reject',
    );
    expect(gateChoicesWords(undefined)).toBe('Approve or Reject');
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

  it("gives its agent's servers, skills and the item line, with no tool names where its definition keeps none (2-C)", () => {
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

  it("names each whole server's tools as its run's definition keeps them, as the Allow card does (review S1)", () => {
    const definition = withAgents({
      look: {
        name: 'investigator',
        hash: 'c'.repeat(64),
        harnessId: 'stub-work',
        body: 'INVESTIGATOR-BODY-1\n',
        mcpServers: [
          { name: 'claude.ai Coralogix', knownTools: ['query_logs', 'list_alerts'] },
          { name: 'claude.ai Slack', knownTools: [] },
          { name: 'grafana', tools: ['query_logs'] },
        ],
        skills: [],
      },
    });
    expect(approvalAgent(definition, 'look')?.servers).toEqual([
      'claude.ai Coralogix: all its tools (query_logs, list_alerts), including any that post or change things',
      'claude.ai Slack: all its tools, including any that post or change things',
      'grafana: query_logs only',
    ]);
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

describe('approvalSkills (review M4)', () => {
  const detail = (fields: Record<string, unknown>) =>
    ({
      runId: 'run-1',
      step: { id: 'look', kind: 'agent' },
      record: { id: 'look', kind: 'agent', status: 'queued', attempt: 1 },
      ...fields,
    }) as unknown as Parameters<typeof approvalSkills>[0];

  it("gives each skill's SKILL.md as the run's copy holds it, by its file", () => {
    expect(
      approvalSkills(
        detail({
          skillTexts: [
            { name: 'incident-triage', text: 'TRIAGE\n' },
            { name: 'release-notes', text: 'NOTES\n' },
          ],
        }),
      ),
    ).toEqual({
      texts: [
        { file: 'skills/incident-triage/SKILL.md', text: 'TRIAGE\n' },
        { file: 'skills/release-notes/SKILL.md', text: 'NOTES\n' },
      ],
    });
  });

  it('says why when the copy cannot be shown, and when the step is gone', () => {
    expect(approvalSkills(detail({ skillsProblem: 'Its skills could not be read.' }))).toEqual({
      problem: 'Its skills could not be read.',
    });
    for (const gone of [null, detail({})])
      expect(approvalSkills(gone)).toEqual({
        problem: "Its skills can't be shown from this run's folder.",
      });
  });
});

describe('writeBlocks (slice 3-B Task 21)', () => {
  it("lists the checkout, each agent's head and sentences, the commands and the variables, in that order", () => {
    expect(
      writeBlocks({
        writes: {
          checkout: 'Cuts `fix/<ticket>` from sprocket/catalog-portal’s default branch.',
          agents: [
            {
              agent: 'ui-bugfixer',
              head: 'ui-bugfixer · claude-work',
              sentences: ['One.', 'Two.'],
            },
            { agent: 'docs', head: 'docs · claude-work', sentences: ['Three.'] },
          ],
          commands: ['`pr` · on host, after ui-bugfixer: …'],
          variables: 'Passes from your environment: CI.',
        },
      }),
    ).toEqual([
      {
        kind: 'checkout',
        text: 'Cuts `fix/<ticket>` from sprocket/catalog-portal’s default branch.',
      },
      { kind: 'head', agent: 'ui-bugfixer', text: 'ui-bugfixer · claude-work' },
      { kind: 'sentence', agent: 'ui-bugfixer', text: 'One.' },
      { kind: 'sentence', agent: 'ui-bugfixer', text: 'Two.' },
      { kind: 'head', agent: 'docs', text: 'docs · claude-work' },
      { kind: 'sentence', agent: 'docs', text: 'Three.' },
      { kind: 'command', text: '`pr` · on host, after ui-bugfixer: …' },
      { kind: 'variables', text: 'Passes from your environment: CI.' },
    ]);
  });

  it('shows nothing for a view that writes nothing, and only what a view has', () => {
    expect(writeBlocks({})).toEqual([]);
    expect(writeBlocks({ writes: { agents: [], commands: [] } })).toEqual([]);
    expect(
      writeBlocks({ writes: { checkout: 'Cuts `x/<run>`.', agents: [], commands: [] } }),
    ).toEqual([{ kind: 'checkout', text: 'Cuts `x/<run>`.' }]);
  });
});
