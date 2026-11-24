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

/** A small factory that keeps the schema, as the cell's demo seed stores one. */
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

  it('refuses a stray file as the cell does', () => {
    const problems = checkFactory([...FACTORY, { path: 'README.md', content: 'Hello' }]);
    expect(problems.length).toBeGreaterThan(0);
  });
});
