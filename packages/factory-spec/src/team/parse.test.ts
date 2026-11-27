import { describe, expect, it } from 'vitest';
import { CODE_REVIEW_TEAM_FILES } from './codeReviewTeam.generated';
import { parseFactory, storedFactoryFiles } from '../factory';
import { hasAgentTeam, parseAgentTeam } from './parse';
import type { TeamFile } from './types';

const file = (path: string, content: string): TeamFile => ({ path, content });
const agent = (name: string, front: string, body = `# ${name}\n\nDo the work.\n`) =>
  file(`agents/${name}/agent.md`, `---\n${front}\n---\n${body}`);
const automation = (name: string, front: string, body = 'Review it.\n') =>
  file(`automations/${name}/automation.md`, `---\n${front}\n---\n${body}`);
const GITHUB_OPENED = 'triggers:\n  - provider: github\n    event: pull_request_opened';
const ORCHESTRATOR = agent('orchestrator', 'agentType: ORCHESTRATOR');

describe('hasAgentTeam', () => {
  it('sees an agent or an automation of the agent team layout', () => {
    expect(hasAgentTeam(CODE_REVIEW_TEAM_FILES)).toBe(true);
    expect(hasAgentTeam([ORCHESTRATOR])).toBe(true);
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
    expect(team.orchestrator?.name).toBe('orchestrator');
    expect(team.orchestrator?.model).toBe('claude-sonnet-5-5');
    const review = team.agents.find((a) => a.name === 'review');
    expect(review).toMatchObject({ agentType: 'REVIEW', model: 'claude-opus-5-5' });
    expect(team.automations).toHaveLength(1);
    expect(team.automations[0]).toMatchObject({
      name: 'review-pull-requests',
      enabled: true,
      agent: 'orchestrator',
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
    expect(team.orchestrator).toMatchObject({
      name: 'lead',
      agentType: 'ORCHESTRATOR',
      harness: 'codex',
    });
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

  it('defaults an automation to the orchestrator', () => {
    const { team, issues } = parseAgentTeam([ORCHESTRATOR, automation('a', GITHUB_OPENED)]);
    expect(issues).toEqual([]);
    expect(team.automations[0].agent).toBe('orchestrator');
  });

  const issueCases: Array<[string, TeamFile[], string, RegExp]> = [
    [
      'an unknown agent key',
      [agent('orchestrator', 'agentType: ORCHESTRATOR\ntools: write')],
      'agents/orchestrator/agent.md',
      /Unknown key `tools`/,
    ],
    [
      'an unknown filter key',
      [ORCHESTRATOR, automation('a', `${GITHUB_OPENED}\n    filter:\n      branches: [main]`)],
      'automations/a/automation.md',
      /Unknown key `branches`/,
    ],
    [
      'two orchestrators',
      [ORCHESTRATOR, agent('second', 'agentType: ORCHESTRATOR')],
      'agents/second/agent.md',
      /at most one orchestrator/,
    ],
    [
      'both agentType and workerRole',
      [agent('orchestrator', 'agentType: ORCHESTRATOR\nworkerRole: MAIN')],
      'agents/orchestrator/agent.md',
      /`agentType` and `workerRole` are one setting/,
    ],
    [
      'both agent and worker',
      [
        ORCHESTRATOR,
        automation('a', `agent: orchestrator\nworker: orchestrator\n${GITHUB_OPENED}`),
      ],
      'automations/a/automation.md',
      /`agent` and `worker` are one setting/,
    ],
    [
      'an unknown target agent',
      [ORCHESTRATOR, automation('a', `agent: nobody\n${GITHUB_OPENED}`)],
      'automations/a/automation.md',
      /`nobody`, which is not an agent/,
    ],
    [
      'no orchestrator to default to',
      [agent('helper', 'description: Helps.'), automation('a', GITHUB_OPENED)],
      'automations/a/automation.md',
      /no orchestrator/,
    ],
    [
      'missing triggers',
      [ORCHESTRATOR, automation('a', 'agent: orchestrator')],
      'automations/a/automation.md',
      /needs `triggers:`/,
    ],
    [
      'a bad name',
      [ORCHESTRATOR, agent('Bad_Name', 'description: x')],
      'agents/Bad_Name/agent.md',
      /`Bad_Name` is not a name/,
    ],
    [
      'an unknown agent type',
      [agent('orchestrator', 'agentType: BOSS')],
      'agents/orchestrator/agent.md',
      /Expected `agentType`/,
    ],
    [
      'spawnableBy naming no agent',
      [ORCHESTRATOR, agent('helper', 'spawnableBy: [ghost]')],
      'agents/helper/agent.md',
      /`ghost`, which is not an agent/,
    ],
    [
      'an unclosed frontmatter',
      [file('agents/orchestrator/agent.md', '---\nagentType: ORCHESTRATOR\n# Orchestrator\n')],
      'agents/orchestrator/agent.md',
      /ends with a line of `---`/,
    ],
    [
      'a skill folder with no SKILL.md',
      [ORCHESTRATOR, file('skills/notes/README.md', 'Notes.\n')],
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
      agent('orchestrator', 'agentType: ORCHESTRATOR\ncolour: blue'),
      automation('a', GITHUB_OPENED),
    ]);
    expect(team.agents).toEqual([]);
    expect(team.orchestrator).toBeUndefined();
    expect(team.automations).toEqual([]);
    expect(issues.map((issue) => issue.file)).toEqual([
      'agents/orchestrator/agent.md',
      'automations/a/automation.md',
    ]);
  });

  it("ignores files outside the three trees and the steps design's files", () => {
    const { team, issues } = parseAgentTeam([
      ORCHESTRATOR,
      file('factory.yml', 'nonsense: ['),
      file('agents/investigator.md', 'Not a team agent.'),
      file('README.md', '# Hi'),
      file('skills/x/.DS_Store', ''),
    ]);
    expect(issues).toEqual([]);
    expect(team.agents.map((a) => a.name)).toEqual(['orchestrator']);
    expect(team.skills).toEqual([]);
    expect(team.repositories).toEqual([]);
  });
});

describe("parseAgentTeam's repositories", () => {
  const yml = (text: string) => file('factory.yml', text);
  const REPOS = 'version: 1\nrepos: [sprocket/catalog-portal, sprocket/catalog-api]\n';

  it("reads factory.yml's repos:, in the order written", () => {
    const { team, issues } = parseAgentTeam([ORCHESTRATOR, yml(REPOS)]);
    expect(issues).toEqual([]);
    expect(team.repositories).toEqual(['sprocket/catalog-portal', 'sprocket/catalog-api']);
  });

  it('has none without a factory.yml, or with one that lists none', () => {
    expect(parseAgentTeam(CODE_REVIEW_TEAM_FILES).team.repositories).toEqual([]);
    expect(parseAgentTeam([ORCHESTRATOR, yml('version: 1\n')]).team.repositories).toEqual([]);
    expect(parseAgentTeam([ORCHESTRATOR, yml('')]).team.repositories).toEqual([]);
  });

  it("keeps them when a steps entry of factory.yml has a problem: that is the entry's", () => {
    const text = `${REPOS}automations:\n  - name: broken\n    on: { cron: nonsense }\n`;
    expect(parseAgentTeam([ORCHESTRATOR, yml(text)]).team.repositories).toEqual([
      'sprocket/catalog-portal',
      'sprocket/catalog-api',
    ]);
  });

  it.each([
    ['repos: that is no list', 'version: 1\nrepos: sprocket/catalog-portal\n'],
    [
      'an entry that is not owner/name',
      'version: 1\nrepos: [sprocket/catalog-portal, catalog-api]\n',
    ],
    [
      'an entry listed twice',
      'version: 1\nrepos: [sprocket/catalog-portal, Sprocket/Catalog-Portal]\n',
    ],
    ['a factory.yml that does not parse', 'version: 1\nrepos: [sprocket/catalog-portal\n'],
    ['a factory.yml with a key it does not take', `${REPOS}colour: blue\n`],
  ])('has none for %s, and leaves the issue to the steps parser', (_kind, text) => {
    const files = [ORCHESTRATOR, yml(text)];
    const { team, issues } = parseAgentTeam(files);
    expect(team.repositories).toEqual([]);
    expect(issues).toEqual([]);
    const steps = parseFactory(storedFactoryFiles([yml(text)]));
    expect(steps.issues.length).toBeGreaterThan(0);
    expect(steps.issues.every((issue) => issue.file === 'factory.yml')).toBe(true);
  });

  it('reads them as the steps design does, from the same files', () => {
    for (const text of [
      REPOS,
      'version: 1\n',
      'version: 1\nrepos: [sprocket/.github]\n',
      `${REPOS}automations:\n  - name: broken\n`,
    ]) {
      const files = [ORCHESTRATOR, yml(text)];
      const steps = parseFactory(storedFactoryFiles([yml(text)]));
      expect(parseAgentTeam(files).team.repositories).toEqual(steps.repos);
    }
  });
});
