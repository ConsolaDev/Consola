import { describe, expect, expectTypeOf, it } from 'vitest';
import type { components } from './apiContract';
import {
  checkFactoryName,
  checkNewFactory,
  FACTORY_NAME_MAX,
  fileGroups,
  firstFile,
  isFactoryNameProblem,
  isMove,
  newFactoryDraft,
  owningTeam,
  SOURCE_OPTIONS,
} from './factories';
import type { Factory, FactoryNameProblem, FactorySourceKind } from './factories';
import {
  messageForFactoryProblem,
  messagesForFactoryChange,
  messagesForFactoryProblems,
  moveQuestion,
  sourceName,
  teamLabel,
  versionLine,
  whenSaved,
} from './factoryMessages';
import type { Team } from './teams';

type Schemas = components['schemas'];

const general: Team = { id: 't-1', name: 'General', first: true, memberIds: ['p-ada'] };
const platform: Team = { id: 't-2', name: 'Platform', first: false, memberIds: ['p-ada'] };
const releases: Factory = {
  id: 'f-1',
  name: 'Releases',
  teamId: 't-1',
  source: { kind: 'stored' },
  latestVersion: 1,
  updatedAt: '2026-11-22T10:00:00.000Z',
};

describe("the cell's contract", () => {
  it('is what the page names: the problems, the sources and the factory', () => {
    expectTypeOf<FactoryNameProblem>().toEqualTypeOf<
      Schemas['InvalidFactory']['problems'][number]
    >();
    expectTypeOf<FactorySourceKind>().toEqualTypeOf<Schemas['FactorySource']['kind']>();
    expectTypeOf<Factory>().toEqualTypeOf<Schemas['Factory']>();
  });
});

describe('checkFactoryName', () => {
  it('takes a name, trimmed', () => {
    expect(checkFactoryName('  Releases ')).toEqual({ ok: true, name: 'Releases' });
  });

  it("names every problem the cell would, as the cell's rule does", () => {
    expect(checkFactoryName(' ')).toEqual({ ok: false, problems: ['name_missing'] });
    expect(checkFactoryName('🚀'.repeat(FACTORY_NAME_MAX)).ok).toBe(true);
    expect(checkFactoryName(`${'a'.repeat(FACTORY_NAME_MAX)}\tb`)).toEqual({
      ok: false,
      problems: ['name_too_long', 'name_invalid'],
    });
  });
});

describe('isFactoryNameProblem', () => {
  it('is true only for the problems the cell names', () => {
    expect(isFactoryNameProblem('name_taken')).toBe(false);
    expect(isFactoryNameProblem('name_invalid')).toBe(true);
    expect(isFactoryNameProblem('toString')).toBe(false);
    expect(isFactoryNameProblem(3)).toBe(false);
  });
});

describe('a new factory', () => {
  it('chooses the team for the person only when the cell lists one', () => {
    expect(newFactoryDraft([general])).toEqual({ name: '', teamId: 't-1' });
    expect(newFactoryDraft([general, platform])).toEqual({ name: '', teamId: null });
    expect(newFactoryDraft([])).toEqual({ name: '', teamId: null });
  });

  it('is a good name and one of the teams the cell lists for the person', () => {
    expect(checkNewFactory({ name: ' Releases ', teamId: 't-2' }, [general, platform])).toEqual({
      ok: true,
      factory: { name: 'Releases', teamId: 't-2' },
    });
  });

  it('names every problem at once', () => {
    expect(checkNewFactory({ name: '', teamId: null }, [general])).toEqual({
      ok: false,
      problems: ['name_missing', 'team_missing'],
    });
  });

  it('never offers a team the cell does not list for the person', () => {
    // A team the person is not in, or one gone since the list was read.
    expect(checkNewFactory({ name: 'Releases', teamId: 't-9' }, [general, platform])).toEqual({
      ok: false,
      problems: ['team_missing'],
    });
    expect(checkNewFactory({ name: 'Releases', teamId: 't-1' }, [])).toEqual({
      ok: false,
      problems: ['team_missing'],
    });
  });
});

describe("a factory's team", () => {
  it('is named from the teams the cell lists', () => {
    expect(owningTeam(releases, [platform, general])).toBe(general);
    expect(teamLabel(owningTeam(releases, [platform]))).toBe('Another team');
  });

  it('moves only to another of the teams the cell lists for the person', () => {
    expect(isMove(releases, 't-2', [general, platform])).toBe(true);
    expect(isMove(releases, 't-1', [general, platform])).toBe(false);
    expect(isMove(releases, 't-9', [general, platform])).toBe(false);
  });

  it('says what a move changes before it is made', () => {
    expect(moveQuestion('Releases', 'General', 'Platform')).toBe(
      'Give Releases to Platform? People in General who aren’t in Platform won’t see it any more, unless they’re owners or admins.',
    );
  });
});

describe('where the files come from', () => {
  it('offers the stored source, and shows a GitHub repository as coming later', () => {
    expect(SOURCE_OPTIONS).toEqual([
      { kind: 'stored', available: true },
      { kind: 'github', available: false },
    ]);
    expect(sourceName('stored')).toBe('Stored by Consola');
    expect(sourceName('github')).toBe('GitHub repository');
  });
});

describe("a factory's files", () => {
  const paths = (list: string[]) => list.map((path) => ({ path }));

  it('are grouped as the folder holds them: its top, then automations, agents and skills', () => {
    const groups = fileGroups(
      paths([
        'skills/release/SKILL.md',
        'agents/reviewer.md',
        'environments/ci.yaml',
        'automations/nightly.yaml',
        'factory.yml',
        'automations/deploy.yaml',
        'skills/release/notes/template.md',
      ]),
    );
    expect(groups).toEqual([
      { folder: null, files: [{ path: 'factory.yml', name: 'factory.yml' }], skills: [] },
      {
        folder: 'automations',
        files: [
          { path: 'automations/deploy.yaml', name: 'deploy.yaml' },
          { path: 'automations/nightly.yaml', name: 'nightly.yaml' },
        ],
        skills: [],
      },
      {
        folder: 'agents',
        files: [{ path: 'agents/reviewer.md', name: 'reviewer.md' }],
        skills: [],
      },
      {
        folder: 'skills',
        files: [],
        skills: [
          {
            skill: 'release',
            files: [
              { path: 'skills/release/SKILL.md', name: 'SKILL.md' },
              { path: 'skills/release/notes/template.md', name: 'notes/template.md' },
            ],
          },
        ],
      },
      {
        folder: 'environments',
        files: [{ path: 'environments/ci.yaml', name: 'ci.yaml' }],
        skills: [],
      },
    ]);
  });

  it('group each skill’s files under it, its SKILL.md first, the skills by name', () => {
    const [skills] = fileGroups(
      paths([
        'skills/triage/refs/queries.md',
        'skills/catalog/SKILL.md',
        'skills/triage/SKILL.md',
        'skills/triage/notes.md',
      ]),
    );
    expect(skills?.skills).toEqual([
      { skill: 'catalog', files: [{ path: 'skills/catalog/SKILL.md', name: 'SKILL.md' }] },
      {
        skill: 'triage',
        files: [
          { path: 'skills/triage/SKILL.md', name: 'SKILL.md' },
          { path: 'skills/triage/notes.md', name: 'notes.md' },
          { path: 'skills/triage/refs/queries.md', name: 'refs/queries.md' },
        ],
      },
    ]);
  });

  it('list the format’s folders when asked, empty or not', () => {
    expect(fileGroups([], { formatFolders: true })).toEqual([
      { folder: 'automations', files: [], skills: [] },
      { folder: 'agents', files: [], skills: [] },
      { folder: 'skills', files: [], skills: [] },
    ]);
    expect(fileGroups(paths(['agents/a.md']))).toEqual([
      { folder: 'agents', files: [{ path: 'agents/a.md', name: 'a.md' }], skills: [] },
    ]);
  });

  it('open on factory.yml, else the first listed, else none', () => {
    expect(firstFile(fileGroups(paths(['agents/a.md', 'factory.yml'])))).toBe('factory.yml');
    expect(firstFile(fileGroups(paths(['skills/x/SKILL.md', 'agents/a.md'])))).toBe('agents/a.md');
    expect(firstFile(fileGroups(paths(['skills/x/refs/a.md', 'skills/x/SKILL.md'])))).toBe(
      'skills/x/SKILL.md',
    );
    expect(firstFile(fileGroups([], { formatFolders: true }))).toBeNull();
  });
});

describe('when a version was saved', () => {
  const now = new Date('2026-11-23T12:00:00');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('is said in words for the last week, then as a date', () => {
    expect(whenSaved(ago(20_000), now)).toBe('just now');
    expect(whenSaved(ago(5 * 60_000), now)).toBe('5 minutes ago');
    expect(whenSaved(ago(3 * 3_600_000), now)).toBe('3 hours ago');
    expect(whenSaved(new Date('2026-11-22T08:00:00').toISOString(), now)).toBe('yesterday');
    expect(whenSaved(new Date('2026-11-19T08:00:00').toISOString(), now)).toBe('4 days ago');
    expect(whenSaved(new Date('2026-10-02T08:00:00').toISOString(), now)).toBe('Oct 2, 2026');
  });

  it('heads the definition, without a time it cannot read', () => {
    expect(versionLine({ version: 3, savedAt: ago(2 * 3_600_000) }, now)).toBe(
      'Version 3, saved 2 hours ago',
    );
    expect(versionLine({ version: 1, savedAt: 'never' }, now)).toBe('Version 1');
  });
});

describe('the sentences', () => {
  const acme = { name: 'Acme', region: 'eu' };

  it('put each problem under the field it is about', () => {
    expect(messagesForFactoryProblems(['name_too_long', 'name_invalid', 'team_missing'])).toEqual({
      name: `${messageForFactoryProblem('name_too_long')} ${messageForFactoryProblem('name_invalid')}`,
      team: 'Choose the team that owns it.',
    });
    expect(messagesForFactoryProblems([])).toEqual({});
  });

  it("say each of the cell's answers where it belongs", () => {
    expect(messagesForFactoryChange({ kind: 'changed', factory: releases }, acme)).toEqual({});
    expect(messagesForFactoryChange({ kind: 'invalid', problems: ['name_missing'] }, acme)).toEqual(
      { name: 'Give the factory a name.' },
    );
    expect(messagesForFactoryChange({ kind: 'name-taken' }, acme)).toEqual({
      name: 'Another factory already has that name.',
    });
    expect(messagesForFactoryChange({ kind: 'team-not-found' }, acme).team).toMatch(
      /That team was deleted/,
    );
    expect(messagesForFactoryChange({ kind: 'factory-not-found' }, acme)).toEqual({
      form: 'This factory was deleted, or moved to a team you’re not in.',
    });
    expect(messagesForFactoryChange({ kind: 'pending' }, acme).form).toContain('Acme');
    expect(messagesForFactoryChange({ kind: 'unavailable' }, acme).form).toContain('EU region');
    expect(messagesForFactoryChange({ kind: 'signed-out' }, acme).form).toMatch(/signed out/);
    expect(messagesForFactoryChange({ kind: 'switched' }, acme).form).toMatch(/another workspace/);
  });

  it('never leave an invalid name unexplained', () => {
    expect(messagesForFactoryChange({ kind: 'invalid', problems: [] }, acme).name).toBe(
      'That name can’t be used.',
    );
  });
});
