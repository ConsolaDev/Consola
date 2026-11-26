/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFactory } from './factoryCheck';
import { problemCounts, sortedProblems } from './factoryProblems';

const REVIEWER = '---\ndescription: Reviews changes.\n---\nYou review changes carefully.\n';

const NIGHTLY = `on: { cron: "0 3 * * *" }
scope: storefront
mode: auto
steps:
  - id: report
    agent: reviewer
    prompt: Summarise last night's build.
`;

/** A small factory that keeps the schema, as the API's demo seed stores one. */
const FACTORY = [
  { path: 'factory.yml', content: 'version: 1\n' },
  { path: 'agents/reviewer.md', content: REVIEWER },
  { path: 'automations/nightly.yaml', content: NIGHTLY },
];

const paths = FACTORY.map((file) => file.path);

const editing = (path: string, content: string) =>
  FACTORY.map((file) => (file.path === path ? { path, content } : file));

describe('checkFactory', () => {
  it('finds nothing wrong with a factory that keeps the schema', () => {
    expect(checkFactory(FACTORY)).toEqual([]);
  });

  it('finds nothing wrong with a blank factory', () => {
    expect(checkFactory([])).toEqual([]);
  });

  it('says a YAML mistake on its file and line', () => {
    const problems = checkFactory(
      editing('automations/nightly.yaml', NIGHTLY.replace('mode: auto', 'mode auto\n  oops: [')),
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.file === 'automations/nightly.yaml')).toBe(true);
    expect(problems[0]?.line).toBeGreaterThan(0);
  });

  it('pins a schema problem to the line of its key', () => {
    const problems = checkFactory(
      editing('automations/nightly.yaml', NIGHTLY.replace('mode: auto', 'mode: sometimes')),
    );
    expect(problems).toEqual([
      expect.objectContaining({ file: 'automations/nightly.yaml', line: 3, cause: null }),
    ]);
  });

  it('pins an agent’s problem to its line in the whole file, front matter included', () => {
    const problems = checkFactory(
      editing(
        'agents/reviewer.md',
        '---\ndescription: Reviews changes.\nname: Reviewer\n---\nBody\n',
      ),
    );
    const own = problems.filter((problem) => problem.file === 'agents/reviewer.md');
    expect(own).toEqual([expect.objectContaining({ line: 3, cause: null })]);
  });

  it('keeps a problem shown through another file apart from that file’s own', () => {
    const problems = checkFactory(
      editing('agents/reviewer.md', '---\ndescription: Reviews.\nskills: [missing]\n---\nBody\n'),
    );
    // The agent's own problem counts on it; the step naming it shows it, and is not counted.
    expect(problems).toContainEqual(
      expect.objectContaining({ file: 'automations/nightly.yaml', cause: 'agents/reviewer.md' }),
    );
    const counts = problemCounts(problems, paths);
    expect([...counts]).toEqual([['agents/reviewer.md', 1]]);
    // The panel lists the files' problems in the tree's order.
    const sorted = sortedProblems(problems, paths).map((problem) => problem.file);
    expect(sorted).toEqual(
      [...sorted].sort((a, b) => paths.indexOf(a ?? '') - paths.indexOf(b ?? '')),
    );
  });

  it('refuses a stray file as the API does', () => {
    const problems = checkFactory([...FACTORY, { path: 'README.md', content: 'Hello' }]);
    expect(problems.length).toBeGreaterThan(0);
  });
});

/**
 * The code review team, as the API offers it (`GET /api/factory-templates`): factory-spec embeds
 * these very files. Read from disk, since no test imports a workspace package.
 */
const TEMPLATE_ROOT = fileURLToPath(
  new URL('../../../../packages/factory-spec/templates/code-review-team/', import.meta.url),
);
const TEAM = readdirSync(TEMPLATE_ROOT, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => {
    const absolute = join(entry.parentPath, entry.name);
    return {
      path: relative(TEMPLATE_ROOT, absolute).split(sep).join('/'),
      content: readFileSync(absolute, 'utf8'),
    };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

describe('checkFactory on an agent team', () => {
  it('reads the code review team’s files', () => {
    expect(TEAM.map((file) => file.path)).toEqual([
      'agents/orchestrator/agent.md',
      'agents/review/agent.md',
      'automations/review-pull-requests/automation.md',
      'skills/code-quality/SKILL.md',
      'skills/code-review/SKILL.md',
      'skills/github/SKILL.md',
    ]);
  });

  it('finds nothing wrong with the template, alone or beside a steps factory', () => {
    expect(checkFactory(TEAM)).toEqual([]);
    expect(checkFactory([...FACTORY, ...TEAM])).toEqual([]);
  });

  it('says a broken agent.md on its own file', () => {
    const broken = TEAM.map((file) =>
      file.path === 'agents/review/agent.md'
        ? { ...file, content: '---\ndescription: [unclosed\n---\nBody\n' }
        : file,
    );
    const problems = checkFactory(broken);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems).toContainEqual(expect.objectContaining({ file: 'agents/review/agent.md' }));
    const counts = problemCounts(
      problems,
      broken.map((file) => file.path),
    );
    expect(counts.get('agents/review/agent.md')).toBeGreaterThan(0);
  });

  it('says an agent type the team does not know, on its file', () => {
    const problems = checkFactory(
      TEAM.map((file) =>
        file.path === 'agents/review/agent.md'
          ? { ...file, content: file.content.replace('agentType: REVIEW', 'agentType: JUDGE') }
          : file,
      ),
    );
    expect(problems).toEqual([expect.objectContaining({ file: 'agents/review/agent.md' })]);
  });

  it('still refuses a stray file in a team’s set, outside the team’s own trees', () => {
    const problems = checkFactory([...TEAM, { path: 'README.md', content: 'Hello' }]);
    expect(problems).toContainEqual(expect.objectContaining({ file: 'README.md' }));
  });

  it('leaves a team’s trees to the steps parser in a set that holds no team', () => {
    // No agent.md or automation.md: no team, so the steps design reads the folder as strays.
    const problems = checkFactory([
      ...FACTORY,
      { path: 'agents/orchestrator/notes.md', content: 'Notes' },
    ]);
    expect(problems.length).toBeGreaterThan(0);
  });
});
