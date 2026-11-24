import { describe, expect, it } from 'vitest';
import {
  type FactoryProblem,
  messageParts,
  ownProblems,
  problemCounts,
  problemOf,
  problemPath,
  sortedProblems,
} from './factoryProblems';

const PATHS = [
  'factory.yml',
  'automations/triage.yaml',
  'agents/reviewer.md',
  'skills/release/notes.md',
  'skills/release/SKILL.md',
];

const problem = (over: Partial<FactoryProblem>): FactoryProblem => ({
  message: 'Something is wrong.',
  file: null,
  line: null,
  cause: null,
  ...over,
});

describe('problemOf', () => {
  it('reads an issue in factory-spec’s shape', () => {
    expect(
      problemOf({ message: 'm', file: 'agents/a.md', path: 'tools', line: 4, cause: 'skills/x' }),
    ).toEqual({ message: 'm', file: 'agents/a.md', line: 4, cause: 'skills/x' });
  });

  it('leaves out what the issue does not say, and a line that is no line', () => {
    expect(problemOf({ message: 'm', line: 0 })).toEqual({
      message: 'm',
      file: null,
      line: null,
      cause: null,
    });
  });
});

describe('problemPath', () => {
  it('is the problem’s own file', () => {
    expect(problemPath(problem({ file: 'agents/reviewer.md' }), PATHS)).toBe('agents/reviewer.md');
  });

  it('is a skill’s SKILL.md for a problem with its folder', () => {
    expect(problemPath(problem({ file: 'skills/release' }), PATHS)).toBe('skills/release/SKILL.md');
    expect(problemPath(problem({ file: 'skills/release/' }), PATHS)).toBe(
      'skills/release/SKILL.md',
    );
  });

  it('is null for the set’s own problem and a file the set does not hold', () => {
    expect(problemPath(problem({}), PATHS)).toBeNull();
    expect(problemPath(problem({ file: 'agents/gone.md' }), PATHS)).toBeNull();
  });
});

describe('problemCounts and ownProblems', () => {
  const problems = [
    problem({ file: 'agents/reviewer.md', line: 3 }),
    problem({ file: 'agents/reviewer.md', line: 5 }),
    problem({ file: 'automations/triage.yaml', line: 4, cause: 'agents/reviewer.md' }),
    problem({}),
  ];

  it('counts each file’s own problems, never one shown through another', () => {
    expect([...problemCounts(problems, PATHS)]).toEqual([['agents/reviewer.md', 2]]);
  });

  it('keeps the problems a person has to fix', () => {
    expect(ownProblems(problems)).toHaveLength(3);
  });
});

describe('sortedProblems', () => {
  it('lists the set’s first, then by the files’ order and by line', () => {
    const sorted = sortedProblems(
      [
        problem({ file: 'agents/reviewer.md', line: 9 }),
        problem({ file: 'factory.yml', line: 2 }),
        problem({ file: 'agents/reviewer.md', line: 1 }),
        problem({ message: 'set' }),
      ],
      PATHS,
    );
    expect(sorted.map((p) => [p.file, p.line])).toEqual([
      [null, null],
      ['factory.yml', 2],
      ['agents/reviewer.md', 1],
      ['agents/reviewer.md', 9],
    ]);
  });
});

describe('messageParts', () => {
  it('sets what sits between backticks as code', () => {
    expect(messageParts('No skill named `relase`: did you mean `release`?')).toEqual([
      { text: 'No skill named ', code: false },
      { text: 'relase', code: true },
      { text: ': did you mean ', code: false },
      { text: 'release', code: true },
      { text: '?', code: false },
    ]);
  });

  it('keeps an unmatched backtick as text', () => {
    expect(messageParts('a `b` c `d')).toEqual([
      { text: 'a ', code: false },
      { text: 'b', code: true },
      { text: ' c `d', code: false },
    ]);
  });
});
