import { describe, expect, it } from 'vitest';
import { checkFactory } from './factoryCheck';
import {
  checkNewFilePath,
  FACTORY_FILES_MAX,
  FACTORY_PATH_MAX,
  NEW_FILE_STARTS,
  type NewFilePathCheck,
  withStart,
} from './factoryNewFile';

/** The sprocket org's factory, as its definition shows it. */
const PATHS = ['factory.yml', 'agents/reviewer.md', 'automations/triage.yaml'];

const message = (check: NewFilePathCheck): string | null =>
  check.kind === 'refused' ? check.message : null;

const [AUTOMATION, AGENT] = NEW_FILE_STARTS as [
  (typeof NEW_FILE_STARTS)[number],
  (typeof NEW_FILE_STARTS)[number],
];

describe('checkNewFilePath, the forms it takes', () => {
  it.each([
    'factory.yml',
    'automations/review-pr.yaml',
    'agents/pr-reviewer-2.md',
    'skills/incident-triage/SKILL.md',
    'skills/incident-triage/refs/queries.md',
    'automations/a.yaml',
    `agents/${'a'.repeat(64)}.md`,
  ])('takes %s', (path) => {
    const others = PATHS.filter((there) => there !== 'factory.yml');
    expect(checkNewFilePath(path, others)).toEqual({ kind: 'ok', path, laterFolder: null });
  });

  it('takes a file in a folder a later slice reads, and names the folder', () => {
    expect(checkNewFilePath('evals/smoke.yaml', PATHS)).toEqual({
      kind: 'ok',
      path: 'evals/smoke.yaml',
      laterFolder: 'evals',
    });
    expect(checkNewFilePath('connections/linear/manifest.yaml', PATHS)).toMatchObject({
      kind: 'ok',
      laterFolder: 'connections',
    });
  });

  it('adds the path without the spaces around it', () => {
    expect(checkNewFilePath('  agents/sprocket-bot.md \t', PATHS)).toEqual({
      kind: 'ok',
      path: 'agents/sprocket-bot.md',
      laterFolder: null,
    });
  });

  it('says nothing while nothing is typed', () => {
    expect(checkNewFilePath('', PATHS)).toEqual({ kind: 'empty' });
    expect(checkNewFilePath('   ', PATHS)).toEqual({ kind: 'empty' });
  });

  it('takes a path the person deleted, since they no longer see it', () => {
    const shown = PATHS.filter((path) => path !== 'agents/reviewer.md');
    expect(checkNewFilePath('agents/reviewer.md', shown).kind).toBe('ok');
  });
});

describe('checkNewFilePath, the cell’s rules for the set', () => {
  it('refuses any file once the factory holds as many as it may', () => {
    const full = Array.from({ length: FACTORY_FILES_MAX }, (_, n) => `agents/a${n}.md`);
    expect(message(checkNewFilePath('agents/one-more.md', full))).toBe(
      'A factory holds at most 500 files.',
    );
    expect(message(checkNewFilePath('', full))).toBe('A factory holds at most 500 files.');
    expect(checkNewFilePath('agents/one-more.md', full.slice(1)).kind).toBe('ok');
  });

  it('refuses a path longer than the cell keeps', () => {
    const name = 'a'.repeat(FACTORY_PATH_MAX - 'skills/x/.md'.length + 1);
    expect(message(checkNewFilePath(`skills/x/${name}.md`, PATHS))).toBe(
      'Keep the path to 256 characters.',
    );
    expect(checkNewFilePath(`skills/x/${name.slice(1)}.md`, PATHS).kind).toBe('ok');
  });

  it.each([
    '/agents/reviewer.md',
    'agents/',
    'agents//reviewer.md',
    './factory.yml',
    'agents/../factory.yml',
    'agents\\reviewer.md',
    'agents/re\tviewer.md',
    'agents/\u0007.md',
    'agents/\uD800.md',
  ])('refuses %j as no path inside a factory, in the cell’s words', (path) => {
    expect(message(checkNewFilePath(path, PATHS))).toBe(
      `\`${path}\` is not a path inside a factory: name it like \`agents/reviewer.md\`, with no empty, \`.\` or \`..\` part.`,
    );
  });

  it('refuses a path that is already a file', () => {
    expect(message(checkNewFilePath('agents/reviewer.md', PATHS))).toBe(
      '`agents/reviewer.md` is already a file in this factory.',
    );
    expect(message(checkNewFilePath(' factory.yml ', PATHS))).toBe(
      '`factory.yml` is already a file in this factory.',
    );
  });
});

describe('checkNewFilePath, where a file goes and what it is named', () => {
  const refusals: [string, string][] = [
    [
      'automations/review-pr.yml',
      '`automations/review-pr.yml` is not an automation: automation files are `automations/<name>.yaml`.',
    ],
    [
      'automations/nightly/review.yaml',
      '`automations/nightly/review.yaml` is not an automation: automation files are `automations/<name>.yaml`.',
    ],
    [
      'automations/Review.yaml',
      "`automations/Review.yaml`: an automation's file name is its name: lowercase letters, digits and dashes, e.g. automations/investigate-alerts.yaml.",
    ],
    [
      'automations/-review.yaml',
      "`automations/-review.yaml`: an automation's file name is its name: lowercase letters, digits and dashes, e.g. automations/investigate-alerts.yaml.",
    ],
    [
      `automations/${'a'.repeat(65)}.yaml`,
      `\`automations/${'a'.repeat(65)}.yaml\`: an automation's file name is its name: lowercase letters, digits and dashes, e.g. automations/investigate-alerts.yaml.`,
    ],
    [
      'agents/reviewer.txt',
      '`agents/reviewer.txt` is not an agent: agent files are `agents/<name>.md`.',
    ],
    [
      'agents/team/reviewer.md',
      '`agents/team/reviewer.md` is not an agent: agent files are `agents/<name>.md`.',
    ],
    [
      'agents/pr_reviewer.md',
      "`agents/pr_reviewer.md`: an agent's file name is its name: lowercase letters, digits and dashes, e.g. agents/investigator.md.",
    ],
    [
      'skills/incident-triage',
      '`skills/incident-triage` is not a skill: a skill is a folder, `skills/<name>/SKILL.md`.',
    ],
    [
      'skills/Triage/SKILL.md',
      "`skills/Triage`: a skill's folder name is its name: lowercase letters, digits and dashes, e.g. skills/incident-triage.",
    ],
    ['factory.yaml', '`factory.yaml` is not an agent, an automation or a skill.'],
    ['README.md', '`README.md` is not an agent, an automation or a skill.'],
    ['docs/setup.md', '`docs/setup.md` is not an agent, an automation or a skill.'],
    ['evals', '`evals` is not an agent, an automation or a skill.'],
    [
      'environments/sandbox.yaml',
      '`environments/sandbox.yaml` is not an environment: environment files are `environments/<name>.yaml`.',
    ],
  ];

  it.each(refusals)('refuses %s', (path, said) => {
    expect(message(checkNewFilePath(path, PATHS))).toBe(said);
  });

  it.each(refusals)('says of %s what the cell’s parser says on Save', (path, said) => {
    const parsed = checkFactory([{ path, content: '' }]).map((problem) => problem.message);
    expect(parsed).toContain(said);
  });

  it('takes only paths the parser reads as a file of the factory', () => {
    for (const path of ['automations/review-pr.yaml', 'agents/reviewer.md', 'evals/smoke.yaml']) {
      const parsed = checkFactory([{ path, content: '' }]).map((problem) => problem.message);
      expect(parsed.filter((said) => said.startsWith(`\`${path}\``))).toEqual([]);
    }
  });
});

describe('withStart', () => {
  it('fills an automation’s folder and ending, the caret between them', () => {
    expect(withStart('', AUTOMATION)).toEqual({ value: 'automations/.yaml', caret: 12 });
    expect(withStart('', AGENT)).toEqual({ value: 'agents/.md', caret: 7 });
  });

  it('keeps a name already typed, and puts the caret after it', () => {
    expect(withStart('review-pr', AUTOMATION)).toEqual({
      value: 'automations/review-pr.yaml',
      caret: 21,
    });
    expect(withStart(' reviewer.md ', AGENT)).toEqual({ value: 'agents/reviewer.md', caret: 15 });
    expect(withStart('review-pr.yml', AUTOMATION).value).toBe('automations/review-pr.yaml');
  });

  it('moves a name from one start to the other', () => {
    expect(withStart('agents/reviewer.md', AUTOMATION).value).toBe('automations/reviewer.yaml');
    expect(withStart('automations/.yaml', AGENT)).toEqual({ value: 'agents/.md', caret: 7 });
  });

  it('starts afresh from a path in another folder', () => {
    expect(withStart('skills/triage/SKILL.md', AGENT)).toEqual({ value: 'agents/.md', caret: 7 });
  });
});
