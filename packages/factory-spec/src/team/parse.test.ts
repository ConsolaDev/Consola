import { describe, expect, it } from 'vitest';
import { CODE_REVIEW_TEAM_FILES } from './codeReviewTeam.generated';
import { hasAgentTeam, parseAgentTeam } from './parse';
import type { TeamFile } from './types';

const file = (path: string, content: string): TeamFile => ({ path, content });
const agent = (name: string, front: string, body = `# ${name}\n\nDo the work.\n`) =>
  file(`agents/${name}/agent.md`, `---\n${front}\n---\n${body}`);
const automation = (name: string, front: string, body = 'Review it.\n') =>
  file(`automations/${name}/automation.md`, `---\n${front}\n---\n${body}`);
const GITHUB_OPENED = 'triggers:\n  - provider: github\n    event: pull_request_opened';
const FOREMAN = agent('foreman', 'agentType: FOREMAN');

describe('hasAgentTeam', () => {
  it('sees an agent or an automation of the Warp layout', () => {
    expect(hasAgentTeam(CODE_REVIEW_TEAM_FILES)).toBe(true);
    expect(hasAgentTeam([FOREMAN])).toBe(true);
    expect(hasAgentTeam([automation('x', GITHUB_OPENED)])).toBe(true);
  });

  it("does not take the steps design's files, or a skills folder alone, for a team", () => {
    expect(
      hasAgentTeam([
        file('factory.yml', 'automations: []\n'),
        file('agents/investigator.md', '---\nharness: claude\n---\nLook.\n'),
        file('automations/nightly.yaml', 'name: nightly\n'),
        file('skills/triage/SKILL.md', 'Triage.\n'),
      ]),
    ).toBe(false);
  });
});

describe('parseAgentTeam', () => {
  it('reads the code-review template with no issues', () => {
    const { team, issues } = parseAgentTeam(CODE_REVIEW_TEAM_FILES);
    expect(issues).toEqual([]);
    expect(team.foreman?.name).toBe('foreman');
    expect(team.foreman?.model).toBe('claude-sonnet-5-5');
    const review = team.agents.find((a) => a.name === 'review');
    expect(review).toMatchObject({ agentType: 'REVIEW', model: 'claude-opus-5-5' });
    expect(team.automations).toHaveLength(1);
    expect(team.automations[0]).toMatchObject({
      name: 'review-pull-requests',
      enabled: true,
      agent: 'foreman',
    });
    expect(team.automations[0].triggers.map((t) => t.event)).toEqual([
      'pull_request_opened',
      'pull_request_ready',
      'pull_request_reopened',
    ]);
    expect(team.skills.map((s) => s.name)).toEqual(['code-quality', 'code-review', 'github']);
    expect(team.skills[0].files[0].path).toBe('skills/code-quality/SKILL.md');
    expect(team.skills.every((s) => s.description !== '')).toBe(true);
  });

  it('reads the aliases, the defaults and the filters', () => {
    const { team, issues } = parseAgentTeam([
      agent('lead', 'workerRole: MAIN\nharness: codex'),
      agent('helper', 'description: Helps.\nspawnableBy: [lead]'),
      automation(
        'gated',
        `worker: helper\nenabled: false\n${GITHUB_OPENED}\n    filter:\n      repos: [Acme/App]\n      labels: { not_in: [wip] }\n      authors: []\n      skip_bots: none`,
      ),
    ]);
    expect(issues).toEqual([]);
    expect(team.foreman).toMatchObject({ name: 'lead', agentType: 'FOREMAN', harness: 'codex' });
    expect(team.agents.find((a) => a.name === 'helper')).toMatchObject({
      agentType: 'CUSTOM',
      description: 'Helps.',
      spawnableBy: ['lead'],
      instructions: '# helper\n\nDo the work.',
    });
    expect(team.automations[0]).toMatchObject({
      agent: 'helper',
      enabled: false,
      prompt: 'Review it.',
    });
    expect(team.automations[0].triggers[0].filter).toEqual({
      repos: { in: ['Acme/App'] },
      labels: { not_in: ['wip'] },
      skip_bots: 'none',
    });
  });

  it('defaults an automation to the foreman', () => {
    const { team, issues } = parseAgentTeam([FOREMAN, automation('a', GITHUB_OPENED)]);
    expect(issues).toEqual([]);
    expect(team.automations[0].agent).toBe('foreman');
  });

  const issueCases: Array<[string, TeamFile[], string, RegExp]> = [
    [
      'an unknown agent key',
      [agent('foreman', 'agentType: FOREMAN\ntools: write')],
      'agents/foreman/agent.md',
      /Unknown key `tools`/,
    ],
    [
      'an unknown filter key',
      [FOREMAN, automation('a', `${GITHUB_OPENED}\n    filter:\n      branches: [main]`)],
      'automations/a/automation.md',
      /Unknown key `branches`/,
    ],
    [
      'two foremen',
      [FOREMAN, agent('second', 'agentType: FOREMAN')],
      'agents/second/agent.md',
      /at most one foreman/,
    ],
    [
      'both agentType and workerRole',
      [agent('foreman', 'agentType: FOREMAN\nworkerRole: MAIN')],
      'agents/foreman/agent.md',
      /`agentType` and `workerRole` are one setting/,
    ],
    [
      'both agent and worker',
      [FOREMAN, automation('a', `agent: foreman\nworker: foreman\n${GITHUB_OPENED}`)],
      'automations/a/automation.md',
      /`agent` and `worker` are one setting/,
    ],
    [
      'an unknown target agent',
      [FOREMAN, automation('a', `agent: nobody\n${GITHUB_OPENED}`)],
      'automations/a/automation.md',
      /`nobody`, which is not an agent/,
    ],
    [
      'no foreman to default to',
      [agent('helper', 'description: Helps.'), automation('a', GITHUB_OPENED)],
      'automations/a/automation.md',
      /no foreman/,
    ],
    [
      'missing triggers',
      [FOREMAN, automation('a', 'agent: foreman')],
      'automations/a/automation.md',
      /needs `triggers:`/,
    ],
    [
      'a bad name',
      [FOREMAN, agent('Bad_Name', 'description: x')],
      'agents/Bad_Name/agent.md',
      /`Bad_Name` is not a name/,
    ],
    [
      'an unknown agent type',
      [agent('foreman', 'agentType: BOSS')],
      'agents/foreman/agent.md',
      /Expected `agentType`/,
    ],
    [
      'spawnableBy naming no agent',
      [FOREMAN, agent('helper', 'spawnableBy: [ghost]')],
      'agents/helper/agent.md',
      /`ghost`, which is not an agent/,
    ],
    [
      'an unclosed frontmatter',
      [file('agents/foreman/agent.md', '---\nagentType: FOREMAN\n# Foreman\n')],
      'agents/foreman/agent.md',
      /ends with a line of `---`/,
    ],
    [
      'a skill folder with no SKILL.md',
      [FOREMAN, file('skills/notes/README.md', 'Notes.\n')],
      'skills/notes/',
      /has none/,
    ],
  ];

  it.each(issueCases)('reports %s', (_kind, files, path, message) => {
    const { issues } = parseAgentTeam(files);
    expect(issues).toContainEqual({ file: path, message: expect.stringMatching(message) });
  });

  it('leaves a file with problems out, and an automation that names it', () => {
    const { team, issues } = parseAgentTeam([
      agent('foreman', 'agentType: FOREMAN\ncolour: blue'),
      automation('a', GITHUB_OPENED),
    ]);
    expect(team.agents).toEqual([]);
    expect(team.foreman).toBeUndefined();
    expect(team.automations).toEqual([]);
    expect(issues.map((issue) => issue.file)).toEqual([
      'agents/foreman/agent.md',
      'automations/a/automation.md',
    ]);
  });

  it("ignores files outside the three trees and the steps design's files", () => {
    const { team, issues } = parseAgentTeam([
      FOREMAN,
      file('factory.yml', 'nonsense: ['),
      file('agents/investigator.md', 'Not a team agent.'),
      file('README.md', '# Hi'),
      file('skills/x/.DS_Store', ''),
    ]);
    expect(issues).toEqual([]);
    expect(team.agents.map((a) => a.name)).toEqual(['foreman']);
    expect(team.skills).toEqual([]);
  });
});
