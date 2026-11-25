import { describe, expect, it } from 'vitest';
import {
  broughtInLine,
  discardQuestion,
  FACTORY_GONE,
  fixToSave,
  messageForSave,
  noFileMatches,
  problemsCount,
  savedWords,
} from './factoryMessages';

const ACME = { name: 'Acme', region: 'eu' };

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

  it('say a save that did not land', () => {
    expect(messageForSave({ kind: 'not-found' }, ACME)).toBe(FACTORY_GONE);
    expect(messageForSave({ kind: 'too-large' }, ACME)).toMatch(/nothing was saved/);
    expect(messageForSave({ kind: 'unavailable' }, ACME)).toMatch(/Europe|region/);
  });
});
