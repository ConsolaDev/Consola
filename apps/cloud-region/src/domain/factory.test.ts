import { MAX_FACTORY_TEXT_BYTES } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import {
  checkFactoryFiles,
  checkFactoryName,
  FACTORY_BYTES_MAX,
  FACTORY_FILES_MAX,
  FACTORY_NAME_MAX,
  type Factory,
  type FactoryFile,
  factoriesSeenBy,
} from './factory.js';
import type { Team } from './team.js';

// A small factory, in the format `packages/factory-spec` defines: an automation in factory.yml,
// one in a file of its own, the agent its step names and the skill that agent names.
const FACTORY_YML = `version: 1
automations:
  - name: morning-summary
    on: { cron: "0 9 * * 1-5" }
    scope: ops-notes
    mode: notify
    run: { prompt: "Summarise yesterday's alerts in five lines." }
`;
const TRIAGE = `on: manual
scope: ops-notes
mode: confirm
steps:
  - id: investigate
    agent: investigator
`;
const INVESTIGATOR = `---
description: Investigates production alerts.
harness: claude-work
skills: [incident-triage]
---
You investigate production alerts and end with cause, impact and the next action.
`;
const SKILL = `---
name: incident-triage
description: The team's triage checklist.
---
Check the alert first.
`;

const file = (path: string, content: string): FactoryFile => ({ path, content });

const VALID: FactoryFile[] = [
  file('factory.yml', FACTORY_YML),
  file('automations/triage.yaml', TRIAGE),
  file('agents/investigator.md', INVESTIGATOR),
  file('skills/incident-triage/SKILL.md', SKILL),
  file('skills/incident-triage/refs/queries.md', 'Use rate() over five minutes.\n'),
];

describe('checkFactoryName', () => {
  it('takes a name, trimmed', () => {
    expect(checkFactoryName('  Ops alerts ')).toEqual({ ok: true, name: 'Ops alerts' });
    expect(checkFactoryName('a'.repeat(FACTORY_NAME_MAX))).toMatchObject({ ok: true });
  });

  it('names every problem with one at once', () => {
    expect(checkFactoryName('   ')).toEqual({ ok: false, problems: ['name_missing'] });
    expect(checkFactoryName(`${'a'.repeat(FACTORY_NAME_MAX + 1)}\u0007`)).toEqual({
      ok: false,
      problems: ['name_too_long', 'name_invalid'],
    });
  });
});

describe('checkFactoryFiles', () => {
  it('takes files that keep the factory schema', () => {
    expect(checkFactoryFiles(VALID)).toEqual({ ok: true, notices: [] });
  });

  it('takes no files at all: a blank factory', () => {
    expect(checkFactoryFiles([])).toEqual({ ok: true, notices: [] });
  });

  it("refuses files that fail the schema, with factory-spec's issues, each naming its file", () => {
    const check = checkFactoryFiles([
      file('factory.yml', 'version: 1\nautomations:\n  - name: x\n    bogus: 1\n'),
      file('agents/investigator.md', '---\ncolour: blue\n---\nYou investigate.\n'),
    ]);
    expect(check.ok).toBe(false);
    const issues = check.ok ? [] : check.issues;
    expect(issues.length).toBeGreaterThan(1);
    expect(issues).toContainEqual(
      expect.objectContaining({
        file: 'factory.yml',
        line: 4,
        message: 'Unrecognized key: "bogus"',
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        file: 'agents/investigator.md',
        line: 2,
        message: 'Unrecognized key in an agent file: `colour`.',
      }),
    );
  });

  it('checks the references across files: a step names an agent the factory has', () => {
    const check = checkFactoryFiles(VALID.filter((f) => f.path !== 'agents/investigator.md'));
    expect(check).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          file: 'automations/triage.yaml',
          message: '`investigator` is not an agent here: there is no agents/investigator.md.',
        }),
      ],
    });
  });

  it('refuses a file that is no part of a factory, as the folder does', () => {
    const check = checkFactoryFiles([...VALID, file('automations/triage.yml', TRIAGE)]);
    expect(check).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          file: 'automations/triage.yml',
          message:
            '`automations/triage.yml` is not an automation: automation files are `automations/<name>.yaml`.',
        }),
      ],
    });
  });

  it("refuses a file whose name is an object's own key, rather than losing it", () => {
    const check = checkFactoryFiles([file('agents/__proto__.md', INVESTIGATOR)]);
    expect(check.ok).toBe(false);
    expect(check.ok ? [] : check.issues.map((issue) => issue.file)).toEqual([
      'agents/__proto__.md',
    ]);
  });

  it("keeps a later slice's folder, with factory-spec's notice that it has no effect yet", () => {
    const check = checkFactoryFiles([...VALID, file('evals/accuracy.yaml', 'cases: []\n')]);
    expect(check).toEqual({
      ok: true,
      notices: [{ message: expect.stringContaining('`evals/`') }],
    });
  });

  it.each([
    ['/factory.yml'],
    ['agents//investigator.md'],
    ['agents/./investigator.md'],
    ['skills/incident-triage/../../factory.yml'],
    ['agents\\investigator.md'],
    ['agents/investigator.md\n'],
    [''],
    [`agents/${'a'.repeat(300)}.md`],
  ])('refuses %j, which is no path inside a factory', (path) => {
    expect(checkFactoryFiles([file(path, INVESTIGATOR)])).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          file: path,
          message: expect.stringContaining('is not a path inside a factory'),
        }),
      ],
    });
  });

  it('refuses a path given twice', () => {
    expect(checkFactoryFiles([...VALID, file('factory.yml', FACTORY_YML)])).toEqual({
      ok: false,
      issues: [{ file: 'factory.yml', path: '', message: '`factory.yml` is given twice.' }],
    });
  });

  it('refuses text the cell cannot store as it was sent', () => {
    const check = checkFactoryFiles([
      file('agents/a.md', 'a\u0000b'),
      file('agents/b.md', 'a\ud800b'),
    ]);
    expect(check.ok ? [] : check.issues.map((issue) => issue.file)).toEqual([
      'agents/a.md',
      'agents/b.md',
    ]);
  });

  it('refuses a file over the size a factory file may be', () => {
    const big = 'a'.repeat(MAX_FACTORY_TEXT_BYTES + 1);
    expect(checkFactoryFiles([file('agents/big.md', big)])).toEqual({
      ok: false,
      issues: [expect.objectContaining({ file: 'agents/big.md' })],
    });
  });

  it('refuses more files, or more bytes, than a factory holds', () => {
    const many = Array.from({ length: FACTORY_FILES_MAX + 1 }, (_, n) =>
      file(`evals/${n}.yaml`, ''),
    );
    expect(checkFactoryFiles(many)).toEqual({
      ok: false,
      issues: [{ path: '', message: `A factory holds at most ${FACTORY_FILES_MAX} files.` }],
    });

    const chunk = 'a'.repeat(MAX_FACTORY_TEXT_BYTES);
    const heavy = Array.from({ length: FACTORY_BYTES_MAX / MAX_FACTORY_TEXT_BYTES + 1 }, (_, n) =>
      file(`evals/${n}.yaml`, chunk),
    );
    expect(checkFactoryFiles(heavy)).toEqual({
      ok: false,
      issues: [{ path: '', message: 'A factory holds at most 8 MB of files.' }],
    });
  });

  it('names the problems with the set first, and checks the schema once they are fixed', () => {
    const check = checkFactoryFiles([
      file('agents/investigator.md', 'not an agent'),
      file('/factory.yml', FACTORY_YML),
    ]);
    expect(check.ok ? [] : check.issues.map((issue) => issue.file)).toEqual(['/factory.yml']);
  });
});

describe('factoriesSeenBy', () => {
  const team = (id: string, memberIds: string[]): Team => ({
    id,
    name: id,
    first: false,
    memberIds,
  });
  const factory = (id: string, teamId: string): Factory => ({
    id,
    name: id,
    teamId,
    source: { kind: 'stored' },
    latestVersion: 1,
    updatedAt: '2026-11-22T10:00:00.000Z',
  });
  const teams = [team('platform', ['person-fay']), team('apps', ['person-gus'])];
  const factories = [factory('deploys', 'platform'), factory('reviews', 'apps')];

  it('shows owners and admins every factory', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(factoriesSeenBy({ personId: 'person-dana', role }, teams, factories)).toEqual(
        factories,
      );
    }
  });

  it("shows a member the factories of the teams they are in, and no other team's", () => {
    const fay = { personId: 'person-fay', role: 'member' } as const;
    expect(factoriesSeenBy(fay, teams, factories)).toEqual([factories[0]]);
    const nobody = { personId: 'person-hal', role: 'member' } as const;
    expect(factoriesSeenBy(nobody, teams, factories)).toEqual([]);
  });
});
