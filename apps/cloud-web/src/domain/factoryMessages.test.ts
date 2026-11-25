import { describe, expect, it } from 'vitest';
import {
  addedLine,
  broughtInLine,
  deletedLine,
  deleteFileLabel,
  discardQuestion,
  FACTORY_GONE,
  fixToSave,
  laterFolderNote,
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
    expect(broughtInLine(8, [], [])).toBe('Brought in version 8. Your changes are on top of it.');
    expect(broughtInLine(8, ['agents/reviewer.md', 'factory.yml'], [])).toBe(
      'Brought in version 8. You and they both changed agents/reviewer.md and factory.yml: yours is kept, so check it before saving.',
    );
    expect(broughtInLine(8, [], ['automations/triage.yaml'])).toBe(
      'Brought in version 8. Version 8 removed automations/triage.yaml: saving adds your edited copy back.',
    );
    expect(broughtInLine(8, [], [], ['agents/reviewer.md'])).toBe(
      'Brought in version 8. You deleted agents/reviewer.md, which version 8 changed: saving still deletes it.',
    );
    expect(broughtInLine(8, [], [], ['agents/a.md', 'agents/b.md'])).toMatch(
      /You deleted agents\/a\.md and agents\/b\.md, .*: saving still deletes them\.$/,
    );
  });

  it('say a file added or deleted, and a folder whose files do nothing yet', () => {
    expect(addedLine('agents/reviewer.md')).toBe('Added agents/reviewer.md. Save to keep it.');
    expect(deletedLine('agents/reviewer.md', true)).toBe(
      'Deleted agents/reviewer.md. Saving removes it from the factory.',
    );
    expect(deletedLine('agents/sprocket.md', false)).toBe('Deleted agents/sprocket.md.');
    expect(deleteFileLabel('agents/reviewer.md')).toBe('Delete agents/reviewer.md');
    expect(laterFolderNote('evals')).toBe('Files in `evals/` are kept, but have no effect yet.');
  });

  it('say a save that did not land', () => {
    expect(messageForSave({ kind: 'not-found' }, ACME)).toBe(FACTORY_GONE);
    expect(messageForSave({ kind: 'too-large' }, ACME)).toMatch(/nothing was saved/);
    expect(messageForSave({ kind: 'unavailable' }, ACME)).toMatch(/Europe|region/);
  });
});
