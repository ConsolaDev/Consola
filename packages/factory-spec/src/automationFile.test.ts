import { describe, expect, it } from 'vitest';
import { parseAutomationFile } from './automationFile';
import { parseFactorySpec } from './parse';
import type { Automation } from './schema';

const FILE = `# automations/investigate-alerts.yaml
on:
  poll: { every: 5m, run: "gh api /alerts", key: .ts }
scope: ops-notes
mode: auto
steps:
  - id: investigate
    prompt: Investigate the alert.
    outputs:
      severity: { enum: [noise, low, high] }
`;

const withoutPlace = ({ file: _file, line: _line, ...rest }: Automation) => rest;

describe('parseAutomationFile', () => {
  it("takes its name from the file's, its file and line 1", () => {
    const result = parseAutomationFile('investigate-alerts', FILE);
    expect(result.issues).toEqual([]);
    expect(result.unreadable).toBe(false);
    expect(result.automation).toMatchObject({
      name: 'investigate-alerts',
      file: 'automations/investigate-alerts.yaml',
      line: 1,
      mode: 'auto',
      scope: 'ops-notes',
    });
  });

  it('parses an entry moved from factory.yml into its own file to an identical automation', () => {
    const indented = FILE.split('\n')
      .slice(1)
      .map((line) => (line === '' ? line : `    ${line}`))
      .join('\n');
    const yml = `version: 1\nautomations:\n  - name: investigate-alerts\n${indented}`;
    const [fromYml] = parseFactorySpec(yml).automations;
    expect(fromYml).toBeDefined();
    const fromFile = parseAutomationFile('investigate-alerts', FILE).automation!;
    expect(withoutPlace(fromFile)).toEqual(withoutPlace(fromYml));
  });

  it('refuses name:, saying the file names it', () => {
    const result = parseAutomationFile('investigate-alerts', `name: investigate-alerts\n${FILE}`);
    expect(result.automation).toBeUndefined();
    expect(result.unreadable).toBe(false);
    expect(result.issues).toEqual([
      {
        message: "The file's name is the automation's name: remove `name:`, or rename the file.",
        path: 'name',
        line: 1,
        file: 'automations/investigate-alerts.yaml',
        automation: 'investigate-alerts',
      },
    ]);
  });

  it('refuses version:', () => {
    expect(parseAutomationFile('investigate-alerts', `version: 1\n${FILE}`).issues).toMatchObject([
      { message: '`version` belongs to factory.yml.', path: 'version', line: 1 },
    ]);
  });

  it.each([
    ['a list', '- on: { cron: "0 9 * * *" }\n'],
    ['a scalar', 'hello\n'],
    ['empty', ''],
    ['comments only', '# nothing yet\n'],
  ])('refuses a root that is %s, unreadable', (_, text) => {
    const result = parseAutomationFile('investigate-alerts', text);
    expect(result.automation).toBeUndefined();
    expect(result.unreadable).toBe(true);
    expect(result.issues).toMatchObject([
      {
        message:
          'Expected an automation: a mapping of its keys (`on:`, `steps:` and the rest), with no `name:`.',
        path: '',
        file: 'automations/investigate-alerts.yaml',
        automation: 'investigate-alerts',
      },
    ]);
  });

  it('is unreadable when the YAML does not parse, with its line', () => {
    const result = parseAutomationFile(
      'investigate-alerts',
      'on: { cron: "0 9 * * *" }\nsteps: [\n',
    );
    expect(result.unreadable).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toMatchObject({
      path: '',
      file: 'automations/investigate-alerts.yaml',
    });
    expect(result.issues[0].line).toBeGreaterThanOrEqual(2);
  });

  it('refuses a file name that is no name', () => {
    expect(parseAutomationFile('Investigate_Alerts', FILE)).toMatchObject({
      unreadable: false,
      issues: [
        {
          message:
            "`automations/Investigate_Alerts.yaml`: an automation's file name is its name: lowercase letters, digits and dashes, e.g. automations/investigate-alerts.yaml.",
          path: '',
          file: 'automations/Investigate_Alerts.yaml',
        },
      ],
    });
  });

  it("pins an issue to the file's own line", () => {
    const result = parseAutomationFile(
      'investigate-alerts',
      'on: { cron: "0 9 * * *" }\nscope: ops-notes\nmode: sometimes\nsteps:\n  - prompt: hi\n',
    );
    expect(result.unreadable).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: 'mode',
        line: 3,
        file: 'automations/investigate-alerts.yaml',
        automation: 'investigate-alerts',
      }),
    ]);
  });

  it('keeps an agent step, and gives the line of any path in the file', () => {
    const text = 'on: { cron: "0 9 * * *" }\nscope: ops-notes\nsteps:\n  - agent: investigator\n';
    const result = parseAutomationFile('investigate-alerts', text);
    expect(result.issues).toEqual([]);
    expect(result.automation).toMatchObject({ steps: [{ agent: 'investigator' }] });
    expect(result.lineAt(['steps', 0, 'agent'])).toBe(4);
    expect(result.lineAt(['scope'])).toBe(2);
  });

  it('gives the lines a node is written on, and none for a path with no node', () => {
    const result = parseAutomationFile('investigate-alerts', FILE);
    expect(result.rangeAt(['steps', 0])).toEqual({ start: 7, end: 10 });
    expect(result.rangeAt(['steps', 0, 'outputs'])).toEqual({ start: 10, end: 10 });
    expect(result.rangeAt(['mode'])).toEqual({ start: 5, end: 5 });
    // Unlike lineAt, which gives the nearest ancestor's (the steps' list), never another node's.
    expect(result.rangeAt(['steps', 1])).toBeUndefined();
    expect(result.lineAt(['steps', 1])).toBe(7);
    expect(parseAutomationFile('Bad Name', FILE).rangeAt(['steps', 0])).toBeUndefined();
  });
});
