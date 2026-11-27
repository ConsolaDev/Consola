import { describe, expect, it } from 'vitest';
import {
  broughtInLine,
  changeLine,
  DEFINITION_BANNER_TEXT,
  discardQuestion,
  FACTORY_GONE,
  fixToSave,
  messageForSave,
  NAME_HINT,
  NO_FILES_HINT,
  namingLabel,
  nameSentence,
  noFileMatches,
  problemsCount,
  removedSaid,
  renamedTitle,
  restoreBlocked,
  restoredSaid,
  SKILL_FILE_HINT,
  savedWords,
  templateAddedLine,
  templateFilesCount,
} from './factoryMessages';

describe('adding a template', () => {
  it('says how many files it added and replaced, and that saving keeps them', () => {
    const name = 'Code review team';
    expect(templateAddedLine(name, ['a', 'b', 'c', 'd', 'e', 'f'], [])).toBe(
      'Code review team added 6 files. Save to keep them, or Discard to drop them.',
    );
    expect(templateAddedLine(name, ['a', 'b'], ['c'])).toBe(
      'Code review team added 2 files and replaced 1 file. Save to keep them, or Discard to drop them.',
    );
    expect(templateAddedLine(name, [], ['c'])).toBe(
      'Code review team replaced 1 file. Save to keep it, or Discard to drop it.',
    );
    expect(templateAddedLine(name, [], [])).toBe(
      'This factory already holds every file of Code review team as it is. Nothing changed.',
    );
    expect(templateAddedLine(name, ['a'], [], ['b'])).toBe(
      'Code review team added 1 file. Save to keep it, or Discard to drop it. It left 1 file under Removed on save alone: restore it and add Code review team again to take its version.',
    );
    expect(templateAddedLine(name, [], [], ['b', 'c'])).toBe(
      'Code review team changed nothing. It left 2 files under Removed on save alone: restore them and add Code review team again to take its version.',
    );
    expect(templateFilesCount(1)).toBe('1 file');
    expect(templateFilesCount(6)).toBe('6 files');
  });
});

describe('the definition’s sentences', () => {
  it('count problems, and say what Save waits for', () => {
    expect(problemsCount(0)).toBe('No problems');
    expect(problemsCount(1)).toBe('1 problem');
    expect(problemsCount(3)).toBe('3 problems');
    expect(fixToSave(1)).toBe('Fix the problem to save.');
    expect(fixToSave(2)).toBe('Fix the 2 problems to save.');
  });

  it('say a filter that matches nothing, and what Discard drops', () => {
    expect(noFileMatches('  revw ')).toBe('No file matches “revw”.');
    expect(discardQuestion(1)).toBe('Discard your changes to 1 file? This can’t be undone.');
    expect(discardQuestion(2)).toBe('Discard your changes to 2 files? This can’t be undone.');
  });

  it('say who saved a version only when it was the person', () => {
    const now = new Date('2026-11-24T12:00:00.000Z');
    const savedAt = '2026-11-24T11:59:40.000Z';
    expect(savedWords({ savedAt, savedBy: 'p-ada' }, now, 'p-ada')).toBe('saved just now by you');
    expect(savedWords({ savedAt, savedBy: 'p-bo' }, now, 'p-ada')).toBe('saved just now');
    expect(savedWords({ savedAt: 'never', savedBy: 'p-ada' }, now, 'p-ada')).toBeNull();
  });

  it('say what bringing a newer version in came to', () => {
    const none = { bothChanged: [], goneThere: [], removedChanged: [], followed: [] };
    expect(broughtInLine(8, none)).toBe('Brought in version 8. Your changes are on top of it.');
    expect(broughtInLine(8, { ...none, bothChanged: ['agents/reviewer.md', 'factory.yml'] })).toBe(
      'Brought in version 8. You and they both changed agents/reviewer.md and factory.yml: yours is kept, so check it before saving.',
    );
    expect(broughtInLine(8, { ...none, goneThere: ['automations/triage.yaml'] })).toBe(
      'Brought in version 8. Version 8 removed automations/triage.yaml: saving adds your copy back.',
    );
  });

  it('name the files the person removed or renamed that the newer version changed', () => {
    const none = { bothChanged: [], goneThere: [], removedChanged: [], followed: [] };
    expect(broughtInLine(8, { ...none, removedChanged: ['agents/old.md'] })).toBe(
      'Brought in version 8. Version 8 changed agents/old.md, which you removed: it stays removed, and Restore brings back yours.',
    );
    expect(
      broughtInLine(8, { ...none, removedChanged: ['agents/old.md', 'skills/triage/refs/a.md'] }),
    ).toBe(
      'Brought in version 8. Version 8 changed agents/old.md and skills/triage/refs/a.md, which you removed: they stay removed, and Restore brings back yours.',
    );
    expect(broughtInLine(8, { ...none, followed: ['agents/checker.md'] })).toBe(
      'Brought in version 8. Version 8 changed agents/checker.md under its old name: the change moved with your rename, so check it before saving.',
    );
    expect(broughtInLine(8, { ...none, followed: ['agents/a.md', 'agents/b.md'] })).toBe(
      'Brought in version 8. Version 8 changed agents/a.md and agents/b.md under their old names: the changes moved with your renames, so check them before saving.',
    );
  });

  it('say what Save will add, rename, remove and change', () => {
    expect(changeLine({ added: 2, renamed: 0, changed: 3, removed: 1, files: 6 })).toBe(
      '2 new · 1 removed · 3 changed',
    );
    expect(changeLine({ added: 0, renamed: 1, changed: 0, removed: 0, files: 1 })).toBe(
      '1 renamed',
    );
    expect(changeLine({ added: 0, renamed: 0, changed: 0, removed: 0, files: 0 })).toBe('');
  });

  it('say under a naming field what a name needs, and why one cannot be made', () => {
    const agent = { type: 'new', kind: 'agent' } as const;
    const inSkill = { type: 'new-in-skill', skill: 'triage' } as const;
    const hint = nameSentence(agent, { ok: false, problem: 'empty', path: null });
    expect(hint).toEqual({ text: NAME_HINT, refused: false });
    expect(nameSentence(agent, { ok: true, path: 'agents/a.md' })).toEqual(hint);
    expect(nameSentence(inSkill, { ok: true, path: 'skills/triage/a.md' })).toEqual({
      text: SKILL_FILE_HINT,
      refused: false,
    });
    const rule = nameSentence(agent, { ok: false, problem: 'rule', path: null });
    expect(rule.refused).toBe(true);
    expect(rule.text).not.toBe(NAME_HINT);
    expect(nameSentence(agent, { ok: false, problem: 'taken', path: 'agents/a.md' }).text).toBe(
      'There’s already a file at agents/a.md.',
    );
    expect(
      nameSentence(
        { type: 'new', kind: 'skill' },
        { ok: false, problem: 'taken', path: 'skills/triage/' },
      ).text,
    ).toBe('There’s already a skill at skills/triage/.');
    expect(nameSentence(agent, { ok: false, problem: 'removed', path: 'agents/a.md' }).text).toBe(
      'agents/a.md is under Removed on save. Restore it, or choose another name.',
    );
    expect(
      nameSentence(
        { type: 'new', kind: 'automation' },
        { ok: false, problem: 'defined', path: 'automations/weekly.yaml' },
      ).text,
    ).toBe('factory.yml already defines an automation named weekly.');
    expect(nameSentence(inSkill, { ok: false, problem: 'path', path: null }).refused).toBe(true);
    expect(nameSentence(inSkill, { ok: false, problem: 'long', path: null }).text).toMatch(/256/);
  });

  it('name each naming field for a screen reader', () => {
    expect(namingLabel({ type: 'new', kind: 'automation' })).toBe('Name the new automation');
    expect(namingLabel({ type: 'new-in-skill', skill: 'triage' })).toBe(
      'Path of the new file in triage',
    );
    expect(namingLabel({ type: 'rename', path: 'agents/reviewer.md' })).toBe(
      'New name for agents/reviewer.md',
    );
    expect(namingLabel({ type: 'rename-skill', skill: 'triage' })).toBe(
      'New name for the skill triage',
    );
  });

  it('say a factory with no files, and what Restore waits for', () => {
    expect(NO_FILES_HINT).not.toMatch(/setup helper|repository/);
    expect(DEFINITION_BANNER_TEXT).toMatch(/[Aa]dd/);
    expect(restoreBlocked('agents/checker.md')).toBe(
      'agents/checker.md is a file again: rename or remove it to restore this.',
    );
    expect(renamedTitle('agents/reviewer.md')).toBe('Renamed from agents/reviewer.md');
    expect(removedSaid('skills/triage/')).toBe(
      'skills/triage/ is under Removed on save, where Restore brings it back.',
    );
    expect(restoredSaid('agents/old.md')).toBe('Restored agents/old.md.');
  });

  it('say a save that did not land', () => {
    expect(messageForSave({ kind: 'not-found' })).toBe(FACTORY_GONE);
    expect(messageForSave({ kind: 'too-large' })).toMatch(/nothing was saved/);
    expect(messageForSave({ kind: 'unavailable' })).toMatch(/Consola Cloud isn’t answering/);
  });
});
