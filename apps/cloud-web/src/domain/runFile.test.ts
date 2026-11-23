import { describe, expect, it } from 'vitest';
import {
  appliesToWords,
  fileLines,
  fileVersionWords,
  holdsOthers,
  inRange,
  modeWords,
  rangeWords,
  triggerDefinitionWords,
} from './runFile';

const TEXT = `teams: [core]
automations:
  - name: review-prs
    steps:
      - id: build
        run: pnpm build
      - id: review
        agent: reviewer
  - name: triage
    steps: []
`;

const source = { text: TEXT, range: { start: 3, end: 8 } };
const steps = [
  { id: 'build', range: { start: 5, end: 6 } },
  { id: 'review', range: { start: 7, end: 8 } },
  { id: 'unknown', range: null },
];

describe('fileLines', () => {
  const lines = fileLines(source, steps);

  it('numbers the lines from 1, with no empty last line', () => {
    expect(lines.map((line) => line.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('marks the automation’s own lines and each step’s', () => {
    expect(lines.filter((line) => line.own).map((line) => line.number)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(lines.map((line) => line.step)).toEqual([
      null,
      null,
      null,
      null,
      'build',
      'build',
      'review',
      'review',
      null,
      null,
    ]);
  });

  it('shades each line as YAML', () => {
    expect(lines[5].tokens.map((token) => token.kind)).toContain('key');
  });
});

describe('a file’s range', () => {
  it('says whether a file holds more than the automation', () => {
    expect(holdsOthers(source)).toBe(true);
    expect(holdsOthers({ text: 'a: 1\nb: 2\n', range: { start: 1, end: 2 } })).toBe(false);
  });

  it('reads and says a range', () => {
    expect(inRange(5, { start: 5, end: 6 })).toBe(true);
    expect(inRange(7, { start: 5, end: 6 })).toBe(false);
    expect(rangeWords({ start: 12, end: 20 })).toBe('lines 12–20');
    expect(rangeWords({ start: 4, end: 4 })).toBe('line 4');
  });
});

describe('the definition’s words', () => {
  it('says the version against the latest', () => {
    expect(fileVersionWords(3, 3)).toBe('v3 · latest');
    expect(fileVersionWords(3, 5)).toBe('v3 · latest is v5');
  });

  it('says the mode, the trigger and what it applies to', () => {
    expect(modeWords('confirm')).toBe('Asks before every run');
    expect(modeWords('auto')).toBe('Runs on its own');
    expect(modeWords('someday')).toBe('someday');
    expect(triggerDefinitionWords('cron')).toBe('On a schedule');
    expect(triggerDefinitionWords('manual')).toBe('When someone runs it');
    expect(appliesToWords(['pr'])).toBe('Pull requests');
    expect(appliesToWords(['issue', 'pr'])).toBe('Pull requests and issues');
    expect(appliesToWords([])).toBe('No pull request or issue');
  });
});
