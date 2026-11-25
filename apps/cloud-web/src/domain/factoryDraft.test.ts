import { describe, expect, it } from 'vitest';
import {
  afterSave,
  broughtIn,
  contentOf,
  draftOf,
  filesOf,
  isChanged,
  isSaved,
  pathsOf,
  withEdit,
  withFile,
  withoutEdits,
  withoutFile,
  withRestored,
} from './factoryDraft';

const V3 = {
  version: 3,
  files: [
    { path: 'factory.yml', content: 'version: 1\n' },
    { path: 'agents/reviewer.md', content: 'reviewer v3' },
    { path: 'automations/triage.yaml', content: 'triage v3' },
  ],
};

describe('a draft', () => {
  it('starts with no edits over its version', () => {
    const draft = draftOf(V3);
    expect(draft.baseVersion).toBe(3);
    expect(isChanged(draft)).toBe(false);
    expect(filesOf(draft)).toEqual(V3.files);
  });

  it('keeps an edit, and drops one taken back to the version’s text', () => {
    const edited = withEdit(draftOf(V3), 'agents/reviewer.md', 'mine');
    expect(isChanged(edited)).toBe(true);
    expect(contentOf(edited, 'agents/reviewer.md')).toBe('mine');
    expect(filesOf(edited).map((file) => file.content)).toEqual([
      'version: 1\n',
      'mine',
      'triage v3',
    ]);
    const undone = withEdit(edited, 'agents/reviewer.md', 'reviewer v3');
    expect(isChanged(undone)).toBe(false);
  });

  it('is the same draft when an edit changes nothing', () => {
    const draft = draftOf(V3);
    expect(withEdit(draft, 'factory.yml', 'version: 1\n')).toBe(draft);
    const edited = withEdit(draft, 'factory.yml', 'x');
    expect(withEdit(edited, 'factory.yml', 'x')).toBe(edited);
  });

  it('discards edits by path', () => {
    const edited = withEdit(withEdit(draftOf(V3), 'factory.yml', 'a'), 'agents/reviewer.md', 'b');
    expect([...withoutEdits(edited, ['factory.yml']).edits.keys()]).toEqual(['agents/reviewer.md']);
  });

  it('keeps a file named like an object’s own property', () => {
    const draft = draftOf({ version: 1, files: [{ path: '__proto__', content: 'x' }] });
    expect(contentOf(draft, '__proto__')).toBe('x');
    expect(contentOf(draft, 'constructor')).toBeUndefined();
  });
});

describe('adding a file', () => {
  it('adds an empty file, unsaved, after the version’s files', () => {
    const added = withFile(draftOf(V3), 'automations/review-pr.yaml');
    expect(isChanged(added)).toBe(true);
    expect(isSaved(added, 'automations/review-pr.yaml')).toBe(false);
    expect(contentOf(added, 'automations/review-pr.yaml')).toBe('');
    expect(pathsOf(added)).toEqual([
      ...V3.files.map((file) => file.path),
      'automations/review-pr.yaml',
    ]);
  });

  it('keeps what is typed into it, even typed back to nothing', () => {
    const typed = withEdit(withFile(draftOf(V3), 'agents/sprocket.md'), 'agents/sprocket.md', 'hi');
    expect(contentOf(typed, 'agents/sprocket.md')).toBe('hi');
    const emptied = withEdit(typed, 'agents/sprocket.md', '');
    expect(pathsOf(emptied)).toContain('agents/sprocket.md');
  });

  it('is the same draft when a file is there already', () => {
    const draft = draftOf(V3);
    expect(withFile(draft, 'factory.yml')).toBe(draft);
  });

  it('is saved as part of the whole set, and is no change once saved', () => {
    const sent = withEdit(
      withFile(draftOf(V3), 'automations/review-pr.yaml'),
      'automations/review-pr.yaml',
      'on: pull_request\n',
    );
    expect(filesOf(sent)).toEqual([
      ...V3.files,
      { path: 'automations/review-pr.yaml', content: 'on: pull_request\n' },
    ]);
    const next = afterSave(sent, sent, { version: 4, files: filesOf(sent) });
    expect(isChanged(next)).toBe(false);
    expect(isSaved(next, 'automations/review-pr.yaml')).toBe(true);
  });

  it('is gone again once the changes are discarded', () => {
    const added = withFile(withFile(draftOf(V3), 'agents/a.md'), 'automations/b.yaml');
    const discarded = withoutEdits(added, [...added.edits.keys()]);
    expect(isChanged(discarded)).toBe(false);
    expect(filesOf(discarded)).toEqual(V3.files);
  });
});

describe('deleting a file', () => {
  it('takes a saved file out of the set, unsaved, until the changes are discarded', () => {
    const deleted = withoutFile(draftOf(V3), 'agents/reviewer.md');
    expect(isChanged(deleted)).toBe(true);
    expect(contentOf(deleted, 'agents/reviewer.md')).toBeUndefined();
    expect(pathsOf(deleted)).toEqual(['factory.yml', 'automations/triage.yaml']);
    expect(filesOf(withoutEdits(deleted, [...deleted.edits.keys()]))).toEqual(V3.files);
  });

  it('drops a deleted file’s edits with it, and Discard brings back the saved text', () => {
    const deleted = withoutFile(
      withEdit(draftOf(V3), 'agents/reviewer.md', 'mine'),
      'agents/reviewer.md',
    );
    expect([...deleted.edits]).toEqual([['agents/reviewer.md', null]]);
    expect(contentOf(withoutEdits(deleted, ['agents/reviewer.md']), 'agents/reviewer.md')).toBe(
      'reviewer v3',
    );
  });

  it('forgets a file never saved', () => {
    const added = withFile(draftOf(V3), 'agents/new.md');
    expect(isChanged(withoutFile(added, 'agents/new.md'))).toBe(false);
  });

  it('is the same draft for a file not there', () => {
    const draft = draftOf(V3);
    expect(withoutFile(draft, 'agents/nobody.md')).toBe(draft);
    const deleted = withoutFile(draft, 'factory.yml');
    expect(withoutFile(deleted, 'factory.yml')).toBe(deleted);
  });

  it('puts the file back as it was on Undo, edits and all', () => {
    const edited = withEdit(draftOf(V3), 'agents/reviewer.md', 'mine');
    const before = contentOf(edited, 'agents/reviewer.md') ?? '';
    const restored = withRestored(
      withoutFile(edited, 'agents/reviewer.md'),
      'agents/reviewer.md',
      before,
    );
    expect(restored.edits).toEqual(edited.edits);
    const added = withEdit(withFile(draftOf(V3), 'agents/new.md'), 'agents/new.md', 'typed');
    const back = withRestored(withoutFile(added, 'agents/new.md'), 'agents/new.md', 'typed');
    expect(contentOf(back, 'agents/new.md')).toBe('typed');
  });

  it('never puts back over a file added at the same path since', () => {
    const deleted = withoutFile(draftOf(V3), 'agents/reviewer.md');
    const again = withEdit(withFile(deleted, 'agents/reviewer.md'), 'agents/reviewer.md', 'new');
    expect(withRestored(again, 'agents/reviewer.md', 'reviewer v3')).toBe(again);
  });

  it('adds a deleted saved file back empty, and back to its text is no change', () => {
    const deleted = withoutFile(draftOf(V3), 'agents/reviewer.md');
    const empty = withFile(deleted, 'agents/reviewer.md');
    expect(contentOf(empty, 'agents/reviewer.md')).toBe('');
    expect(isChanged(withEdit(empty, 'agents/reviewer.md', 'reviewer v3'))).toBe(false);
  });

  it('is saved as the set without it', () => {
    const sent = withoutFile(draftOf(V3), 'automations/triage.yaml');
    const next = afterSave(sent, sent, { version: 4, files: filesOf(sent) });
    expect(isChanged(next)).toBe(false);
    expect(pathsOf(next)).toEqual(['factory.yml', 'agents/reviewer.md']);
  });
});

describe('broughtIn', () => {
  const V4 = {
    version: 4,
    files: [
      { path: 'factory.yml', content: 'version: 1\n' },
      { path: 'agents/reviewer.md', content: 'reviewer v4' },
      { path: 'automations/triage.yaml', content: 'triage v4' },
      { path: 'agents/new.md', content: 'new in v4' },
    ],
  };

  it('takes the newer text for every file the person did not touch', () => {
    const { draft, bothChanged, goneThere } = broughtIn(
      withEdit(draftOf(V3), 'factory.yml', 'version: 2\n'),
      V4,
    );
    expect(draft.baseVersion).toBe(4);
    expect(filesOf(draft)).toEqual([
      { path: 'factory.yml', content: 'version: 2\n' },
      { path: 'agents/reviewer.md', content: 'reviewer v4' },
      { path: 'automations/triage.yaml', content: 'triage v4' },
      { path: 'agents/new.md', content: 'new in v4' },
    ]);
    expect(bothChanged).toEqual([]);
    expect(goneThere).toEqual([]);
  });

  it('keeps the person’s text where both changed a file, and names it', () => {
    const { draft, bothChanged } = broughtIn(
      withEdit(draftOf(V3), 'agents/reviewer.md', 'mine'),
      V4,
    );
    expect(contentOf(draft, 'agents/reviewer.md')).toBe('mine');
    expect(bothChanged).toEqual(['agents/reviewer.md']);
  });

  it('drops an edit the newer version already holds', () => {
    const { draft, bothChanged } = broughtIn(
      withEdit(draftOf(V3), 'agents/reviewer.md', 'reviewer v4'),
      V4,
    );
    expect(isChanged(draft)).toBe(false);
    expect(bothChanged).toEqual([]);
  });

  it('keeps an edited file the newer version took away, so nothing typed is lost', () => {
    const V5 = { version: 5, files: [{ path: 'factory.yml', content: 'version: 1\n' }] };
    const { draft, goneThere } = broughtIn(
      withEdit(draftOf(V3), 'automations/triage.yaml', 'mine'),
      V5,
    );
    expect(goneThere).toEqual(['automations/triage.yaml']);
    expect(pathsOf(draft)).toEqual(['factory.yml', 'automations/triage.yaml']);
    expect(contentOf(draft, 'automations/triage.yaml')).toBe('mine');
  });

  it('keeps a file the person added, and names it only when the newer version added it too', () => {
    const added = withEdit(withFile(draftOf(V3), 'agents/mine.md'), 'agents/mine.md', 'mine');
    const quiet = broughtIn(added, V4);
    expect(contentOf(quiet.draft, 'agents/mine.md')).toBe('mine');
    expect(quiet.goneThere).toEqual([]);
    expect(quiet.bothChanged).toEqual([]);
    const both = broughtIn(
      withEdit(withFile(draftOf(V3), 'agents/new.md'), 'agents/new.md', 'mine'),
      V4,
    );
    expect(contentOf(both.draft, 'agents/new.md')).toBe('mine');
    expect(both.bothChanged).toEqual(['agents/new.md']);
  });

  it('keeps a file the person deleted deleted, and names it when the newer version changed it', () => {
    const deleted = withoutFile(withoutFile(draftOf(V3), 'agents/reviewer.md'), 'factory.yml');
    const { draft, deletedChanged } = broughtIn(deleted, V4);
    expect(pathsOf(draft)).toEqual(['automations/triage.yaml', 'agents/new.md']);
    expect(deletedChanged).toEqual(['agents/reviewer.md']);
  });

  it('has nothing left to delete when the newer version deleted it too', () => {
    const V5 = { version: 5, files: [{ path: 'factory.yml', content: 'version: 1\n' }] };
    const { draft, deletedChanged } = broughtIn(withoutFile(draftOf(V3), 'agents/reviewer.md'), V5);
    expect(isChanged(draft)).toBe(false);
    expect(deletedChanged).toEqual([]);
  });
});

describe('afterSave', () => {
  it('starts over the saved version, keeping only what was typed while it saved', () => {
    const sent = withEdit(draftOf(V3), 'factory.yml', 'version: 2\n');
    const current = withEdit(sent, 'agents/reviewer.md', 'typed meanwhile');
    const saved = {
      version: 4,
      files: [
        { path: 'factory.yml', content: 'version: 2\n' },
        { path: 'agents/reviewer.md', content: 'reviewer v3' },
        { path: 'automations/triage.yaml', content: 'triage v3' },
      ],
    };
    const next = afterSave(current, sent, saved);
    expect(next.baseVersion).toBe(4);
    expect([...next.edits]).toEqual([['agents/reviewer.md', 'typed meanwhile']]);
  });

  it('keeps a file typed back to its old text while it saved', () => {
    const sent = withEdit(draftOf(V3), 'factory.yml', 'version: 2\n');
    const current = withEdit(sent, 'factory.yml', 'version: 1\n');
    const saved = { version: 4, files: [{ path: 'factory.yml', content: 'version: 2\n' }] };
    expect([...afterSave(current, sent, saved).edits]).toEqual([['factory.yml', 'version: 1\n']]);
  });

  it('keeps a file added or deleted while it saved', () => {
    const sent = withEdit(draftOf(V3), 'factory.yml', 'version: 2\n');
    const current = withFile(withoutFile(sent, 'agents/reviewer.md'), 'agents/new.md');
    const saved = { version: 4, files: filesOf(sent) };
    const next = afterSave(current, sent, saved);
    expect([...next.edits]).toEqual([
      ['agents/reviewer.md', null],
      ['agents/new.md', ''],
    ]);
  });

  it('keeps a file sent new and deleted while it saved, deleted', () => {
    const sent = withFile(draftOf(V3), 'agents/new.md');
    const current = withoutFile(sent, 'agents/new.md');
    const next = afterSave(current, sent, { version: 4, files: filesOf(sent) });
    expect([...next.edits]).toEqual([['agents/new.md', null]]);
    expect(pathsOf(next)).not.toContain('agents/new.md');
  });
});
