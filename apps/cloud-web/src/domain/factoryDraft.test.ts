import { describe, expect, it } from 'vitest';
import {
  afterSave,
  broughtIn,
  canRestore,
  changeSummary,
  contentOf,
  discarded,
  draftOf,
  fileMarks,
  filesOf,
  hasWork,
  heldPaths,
  isChanged,
  pathMoves,
  pathsOf,
  removedPaths,
  restoreBlocker,
  withEdit,
  withFileAdded,
  withFiles,
  withRemoved,
  withRenamed,
  withRestored,
  withSkillRemoved,
  withSkillRenamed,
} from './factoryDraft';
import type { FactoryDraft } from './factoryDraft';

const V3 = {
  version: 3,
  files: [
    { path: 'factory.yml', content: 'version: 1\n' },
    { path: 'agents/reviewer.md', content: 'reviewer v3' },
    { path: 'automations/triage.yaml', content: 'triage v3' },
  ],
};

const TRIAGE_SKILL = '---\nname: triage\ndescription: Sorts issues.\n---\n\nSort them.\n';

/** A version with a skill of two files, as `skills/triage/`. */
const WITH_SKILL = {
  version: 3,
  files: [
    ...V3.files,
    { path: 'skills/triage/SKILL.md', content: TRIAGE_SKILL },
    { path: 'skills/triage/refs/queries.md', content: 'queries v3' },
  ],
};

const asMap = (draft: FactoryDraft) =>
  Object.fromEntries(filesOf(draft).map((file) => [file.path, file.content]));

describe('a draft', () => {
  it('starts with no edits over its version', () => {
    const draft = draftOf(V3);
    expect(draft.baseVersion).toBe(3);
    expect(isChanged(draft)).toBe(false);
    expect(hasWork(draft)).toBe(false);
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
    expect(fileMarks(edited).get('agents/reviewer.md')).toEqual({
      isNew: false,
      renamedFrom: null,
      changed: true,
    });
    const undone = withEdit(edited, 'agents/reviewer.md', 'reviewer v3');
    expect(isChanged(undone)).toBe(false);
    expect(fileMarks(undone).get('agents/reviewer.md')?.changed).toBe(false);
  });

  it('is the same draft when an edit changes nothing, or names no file', () => {
    const draft = draftOf(V3);
    expect(withEdit(draft, 'factory.yml', 'version: 1\n')).toBe(draft);
    const edited = withEdit(draft, 'factory.yml', 'x');
    expect(withEdit(edited, 'factory.yml', 'x')).toBe(edited);
    expect(withEdit(draft, 'agents/nobody.md', 'x')).toBe(draft);
  });

  it('keeps a file named like an object’s own property', () => {
    const draft = draftOf({ version: 1, files: [{ path: '__proto__', content: 'x' }] });
    expect(contentOf(draft, '__proto__')).toBe('x');
    expect(contentOf(draft, 'constructor')).toBeUndefined();
  });
});

describe('adding a file', () => {
  it('adds it as new, with its text, and counts as a change', () => {
    const draft = withFileAdded(draftOf(V3), 'agents/sprocket.md', 'hello');
    expect(pathsOf(draft)).toContain('agents/sprocket.md');
    expect(contentOf(draft, 'agents/sprocket.md')).toBe('hello');
    expect(isChanged(draft)).toBe(true);
    expect(fileMarks(draft).get('agents/sprocket.md')).toEqual({
      isNew: true,
      renamedFrom: null,
      changed: false,
    });
    expect(changeSummary(draft)).toEqual({
      added: 1,
      renamed: 0,
      changed: 0,
      removed: 0,
      files: 1,
    });
  });

  it('keeps an empty file', () => {
    const draft = withFileAdded(draftOf(WITH_SKILL), 'skills/triage/notes.md', '');
    expect(contentOf(draft, 'skills/triage/notes.md')).toBe('');
    expect(isChanged(draft)).toBe(true);
  });

  it('refuses a path the draft holds, live or waiting under Removed', () => {
    const draft = draftOf(V3);
    expect(withFileAdded(draft, 'agents/reviewer.md', 'x')).toBe(draft);
    const removed = withRemoved(draft, 'agents/reviewer.md');
    expect(withFileAdded(removed, 'agents/reviewer.md', 'x')).toBe(removed);
  });

  it('edits a new file like any other', () => {
    const added = withFileAdded(draftOf(V3), 'agents/sprocket.md', 'hello');
    const edited = withEdit(added, 'agents/sprocket.md', 'hello again');
    expect(contentOf(edited, 'agents/sprocket.md')).toBe('hello again');
    expect(fileMarks(edited).get('agents/sprocket.md')?.isNew).toBe(true);
  });
});

describe('renaming a file', () => {
  it('moves its text, edits included, and marks it renamed', () => {
    const edited = withEdit(draftOf(V3), 'agents/reviewer.md', 'mine');
    const renamed = withRenamed(edited, 'agents/reviewer.md', 'agents/checker.md');
    expect(pathsOf(renamed)).toEqual([
      'factory.yml',
      'agents/checker.md',
      'automations/triage.yaml',
    ]);
    expect(contentOf(renamed, 'agents/checker.md')).toBe('mine');
    expect(contentOf(renamed, 'agents/reviewer.md')).toBeUndefined();
    expect(fileMarks(renamed).get('agents/checker.md')).toEqual({
      isNew: false,
      renamedFrom: 'agents/reviewer.md',
      changed: true,
    });
    expect(removedPaths(renamed)).toEqual([]);
    // One file renamed and edited is one file a save changes, whatever it says of it.
    expect(changeSummary(renamed)).toEqual({
      added: 0,
      renamed: 1,
      changed: 1,
      removed: 0,
      files: 1,
    });
  });

  it('counts a rename alone as a change, and renaming back as none', () => {
    const renamed = withRenamed(draftOf(V3), 'agents/reviewer.md', 'agents/checker.md');
    expect(isChanged(renamed)).toBe(true);
    const back = withRenamed(renamed, 'agents/checker.md', 'agents/reviewer.md');
    expect(isChanged(back)).toBe(false);
    expect(fileMarks(back).get('agents/reviewer.md')).toEqual({
      isNew: false,
      renamedFrom: null,
      changed: false,
    });
  });

  it('refuses a path another file holds, and does nothing for its own', () => {
    const draft = draftOf(V3);
    expect(withRenamed(draft, 'agents/reviewer.md', 'factory.yml')).toBe(draft);
    expect(withRenamed(draft, 'agents/reviewer.md', 'agents/reviewer.md')).toBe(draft);
    expect(withRenamed(draft, 'agents/nobody.md', 'agents/x.md')).toBe(draft);
  });

  it('says which paths moved, for the tabs and the editor', () => {
    const before = draftOf(V3);
    const after = withRenamed(before, 'agents/reviewer.md', 'agents/checker.md');
    expect([...pathMoves(before, after)]).toEqual([['agents/reviewer.md', 'agents/checker.md']]);
  });
});

describe('renaming a skill', () => {
  it('moves its folder and every file in it, and its SKILL.md’s name follows', () => {
    const renamed = withSkillRenamed(draftOf(WITH_SKILL), 'triage', 'sorting');
    expect(pathsOf(renamed)).toContain('skills/sorting/SKILL.md');
    expect(pathsOf(renamed)).toContain('skills/sorting/refs/queries.md');
    expect(pathsOf(renamed).some((path) => path.startsWith('skills/triage/'))).toBe(false);
    expect(contentOf(renamed, 'skills/sorting/SKILL.md')).toBe(
      '---\nname: sorting\ndescription: Sorts issues.\n---\n\nSort them.\n',
    );
    expect(contentOf(renamed, 'skills/sorting/refs/queries.md')).toBe('queries v3');
    expect(fileMarks(renamed).get('skills/sorting/refs/queries.md')?.renamedFrom).toBe(
      'skills/triage/refs/queries.md',
    );
  });

  it('keeps quotes around the name, and leaves a name line that named something else', () => {
    const quoted = {
      version: 1,
      files: [{ path: 'skills/triage/SKILL.md', content: '---\nname: "triage"\n---\nBody\n' }],
    };
    expect(
      contentOf(withSkillRenamed(draftOf(quoted), 'triage', 'sorting'), 'skills/sorting/SKILL.md'),
    ).toBe('---\nname: "sorting"\n---\nBody\n');
    const other = {
      version: 1,
      files: [{ path: 'skills/triage/SKILL.md', content: '---\nname: other\n---\nname: triage\n' }],
    };
    expect(
      contentOf(withSkillRenamed(draftOf(other), 'triage', 'sorting'), 'skills/sorting/SKILL.md'),
    ).toBe('---\nname: other\n---\nname: triage\n');
  });

  it('leaves no change once renamed back', () => {
    const renamed = withSkillRenamed(draftOf(WITH_SKILL), 'triage', 'sorting');
    expect(isChanged(withSkillRenamed(renamed, 'sorting', 'triage'))).toBe(false);
  });

  it('refuses a skill that is already there, live or removed', () => {
    const two = withFileAdded(draftOf(WITH_SKILL), 'skills/sorting/SKILL.md', 'x');
    expect(withSkillRenamed(two, 'triage', 'sorting')).toBe(two);
    const removed = withSkillRemoved(two, 'sorting');
    expect(withSkillRenamed(removed, 'triage', 'sorting')).toBe(removed);
  });

  it('says every path that moved', () => {
    const before = draftOf(WITH_SKILL);
    const after = withSkillRenamed(before, 'triage', 'sorting');
    expect(new Map(pathMoves(before, after))).toEqual(
      new Map([
        ['skills/triage/SKILL.md', 'skills/sorting/SKILL.md'],
        ['skills/triage/refs/queries.md', 'skills/sorting/refs/queries.md'],
      ]),
    );
  });
});

describe('removing a file', () => {
  it('lists it under Removed on save with the person’s text, and Restore brings it back', () => {
    const edited = withEdit(draftOf(V3), 'agents/reviewer.md', 'mine');
    const removed = withRemoved(edited, 'agents/reviewer.md');
    expect(pathsOf(removed)).toEqual(['factory.yml', 'automations/triage.yaml']);
    expect(removed.removed.map((entry) => entry.label)).toEqual(['agents/reviewer.md']);
    expect(removedPaths(removed)).toEqual(['agents/reviewer.md']);
    expect(heldPaths(removed).has('agents/reviewer.md')).toBe(true);
    expect(isChanged(removed)).toBe(true);
    expect(changeSummary(removed)).toEqual({
      added: 0,
      renamed: 0,
      changed: 0,
      removed: 1,
      files: 1,
    });

    expect(canRestore(removed, 'agents/reviewer.md')).toBe(true);
    const restored = withRestored(removed, 'agents/reviewer.md');
    expect(contentOf(restored, 'agents/reviewer.md')).toBe('mine');
    expect(restored.removed).toEqual([]);
    expect(isChanged(withRestored(withRemoved(draftOf(V3), 'factory.yml'), 'factory.yml'))).toBe(
      false,
    );
  });

  it('keeps a removed new file, which is no change: it was never saved', () => {
    const added = withFileAdded(draftOf(V3), 'agents/sprocket.md', 'hello');
    const removed = withRemoved(added, 'agents/sprocket.md');
    expect(isChanged(removed)).toBe(false);
    expect(hasWork(removed)).toBe(true);
    expect(removedPaths(removed)).toEqual(['agents/sprocket.md']);
    expect(changeSummary(removed).removed).toBe(0);
    expect(contentOf(withRestored(removed, 'agents/sprocket.md'), 'agents/sprocket.md')).toBe(
      'hello',
    );
  });

  it('removes a skill as one entry, and restores all of it', () => {
    const edited = withEdit(draftOf(WITH_SKILL), 'skills/triage/refs/queries.md', 'mine');
    const removed = withSkillRemoved(edited, 'triage');
    expect(pathsOf(removed).some((path) => path.startsWith('skills/'))).toBe(false);
    expect(removed.removed.map((entry) => entry.label)).toEqual(['skills/triage/']);
    expect(removedPaths(removed)).toEqual([
      'skills/triage/SKILL.md',
      'skills/triage/refs/queries.md',
    ]);
    const restored = withRestored(removed, 'skills/triage/');
    expect(contentOf(restored, 'skills/triage/refs/queries.md')).toBe('mine');
    expect(contentOf(restored, 'skills/triage/SKILL.md')).toBe(TRIAGE_SKILL);
  });

  it('cannot restore while a path it would take is a live file’s', () => {
    // Someone else's version brought a file in at the path: see broughtIn.
    const removed = withRemoved(draftOf(V3), 'agents/reviewer.md');
    const taken: FactoryDraft = {
      ...removed,
      files: [...removed.files, { id: 99, from: null, path: 'agents/reviewer.md', content: 'x' }],
    };
    expect(canRestore(taken, 'agents/reviewer.md')).toBe(false);
    expect(restoreBlocker(taken, 'agents/reviewer.md')).toBe('agents/reviewer.md');
    expect(restoreBlocker(removed, 'agents/reviewer.md')).toBeNull();
    expect(withRestored(taken, 'agents/reviewer.md')).toBe(taken);
    expect(canRestore(removed, 'agents/nothing.md')).toBe(false);
  });

  it('does nothing for a path it does not hold', () => {
    const draft = draftOf(V3);
    expect(withRemoved(draft, 'agents/nobody.md')).toBe(draft);
    expect(withSkillRemoved(draft, 'nobody')).toBe(draft);
  });
});

describe('discarded', () => {
  it('returns to the saved version: new files go, removed files come back, renames undone', () => {
    let draft = draftOf(WITH_SKILL);
    draft = withFileAdded(draft, 'agents/sprocket.md', 'hello');
    draft = withRemoved(draft, 'factory.yml');
    draft = withRenamed(draft, 'agents/reviewer.md', 'agents/checker.md');
    draft = withSkillRenamed(draft, 'triage', 'sorting');
    draft = withEdit(draft, 'automations/triage.yaml', 'mine');
    const back = discarded(draft);
    expect(isChanged(back)).toBe(false);
    expect(back.removed).toEqual([]);
    expect(asMap(back)).toEqual(asMap(draftOf(WITH_SKILL)));
    expect(new Map(pathMoves(draft, back))).toEqual(
      new Map([
        ['agents/checker.md', 'agents/reviewer.md'],
        ['skills/sorting/SKILL.md', 'skills/triage/SKILL.md'],
        ['skills/sorting/refs/queries.md', 'skills/triage/refs/queries.md'],
      ]),
    );
  });
});

describe('withFiles (a template’s files, merged in)', () => {
  const TEAM = [
    { path: 'agents/foreman/agent.md', content: 'foreman' },
    { path: 'agents/reviewer.md', content: 'the template’s reviewer' },
    { path: 'factory.yml', content: 'version: 1\n' },
  ];

  it('adds the files the draft lacks and replaces those it holds, as unsaved changes', () => {
    const { draft, added, replaced, skipped } = withFiles(draftOf(V3), TEAM);
    expect(added).toEqual(['agents/foreman/agent.md']);
    expect(replaced).toEqual(['agents/reviewer.md']);
    expect(skipped).toEqual([]);
    expect(isChanged(draft)).toBe(true);
    expect(fileMarks(draft).get('agents/foreman/agent.md')?.isNew).toBe(true);
    expect(fileMarks(draft).get('agents/reviewer.md')?.changed).toBe(true);
    // The version's files keep their order; an added file follows them.
    expect(filesOf(draft)).toEqual([
      { path: 'factory.yml', content: 'version: 1\n' },
      { path: 'agents/reviewer.md', content: 'the template’s reviewer' },
      { path: 'automations/triage.yaml', content: 'triage v3' },
      { path: 'agents/foreman/agent.md', content: 'foreman' },
    ]);
  });

  it('counts a file already as the template has it as neither, and changes nothing for it', () => {
    const draft = draftOf(V3);
    const result = withFiles(draft, [{ path: 'factory.yml', content: 'version: 1\n' }]);
    expect(result).toEqual({ draft, added: [], replaced: [], skipped: [] });
  });

  it('replaces the person’s own unsaved edit of a file at the same path', () => {
    const edited = withEdit(draftOf(V3), 'agents/reviewer.md', 'mine');
    const { draft, replaced } = withFiles(edited, TEAM);
    expect(replaced).toEqual(['agents/reviewer.md']);
    expect(contentOf(draft, 'agents/reviewer.md')).toBe('the template’s reviewer');
  });

  it('leaves a path the person removed under Removed on save', () => {
    const removed = withRemoved(draftOf(V3), 'agents/reviewer.md');
    const { draft, added, replaced, skipped } = withFiles(removed, TEAM);
    expect(skipped).toEqual(['agents/reviewer.md']);
    expect(added).toEqual(['agents/foreman/agent.md']);
    expect(replaced).toEqual([]);
    expect(removedPaths(draft)).toEqual(['agents/reviewer.md']);
    expect(contentOf(draft, 'agents/reviewer.md')).toBeUndefined();
  });

  it('adds every file to a blank factory, and discarding drops them all', () => {
    const blank = draftOf({ version: 1, files: [] });
    const { draft, added, replaced } = withFiles(blank, TEAM);
    expect(added).toEqual(TEAM.map((file) => file.path));
    expect(replaced).toEqual([]);
    expect(pathsOf(draft)).toEqual(TEAM.map((file) => file.path));
    expect(filesOf(discarded(draft))).toEqual([]);
  });

  it('leaves what a save sends as every file, the added ones included', () => {
    const { draft } = withFiles(draftOf({ version: 1, files: [] }), TEAM);
    const saved = { version: 2, files: filesOf(draft) };
    expect(isChanged(afterSave(draft, draft, saved))).toBe(false);
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
    expect(asMap(draft)).toEqual({
      'factory.yml': 'version: 2\n',
      'agents/reviewer.md': 'reviewer v4',
      'automations/triage.yaml': 'triage v4',
      'agents/new.md': 'new in v4',
    });
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
    expect(fileMarks(draft).get('automations/triage.yaml')?.isNew).toBe(true);
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
    expect([...fileMarks(next)].filter(([, mark]) => mark.changed)).toEqual([
      ['agents/reviewer.md', { isNew: false, renamedFrom: null, changed: true }],
    ]);
    expect(contentOf(next, 'agents/reviewer.md')).toBe('typed meanwhile');
  });

  it('keeps a file typed back to its old text while it saved', () => {
    const sent = withEdit(draftOf(V3), 'factory.yml', 'version: 2\n');
    const current = withEdit(sent, 'factory.yml', 'version: 1\n');
    const next = afterSave(current, sent, { version: 4, files: filesOf(sent) });
    expect(contentOf(next, 'factory.yml')).toBe('version: 1\n');
    expect(isChanged(next)).toBe(true);
  });
});

describe('broughtIn, over adds, renames and removals', () => {
  /** Their version: `edits` set new text (or null removes the file); `added` adds files. */
  const theirs = (
    from: { files: ReadonlyArray<{ path: string; content: string }> },
    edits: Record<string, string | null> = {},
    added: Record<string, string> = {},
  ) => ({
    version: 4,
    files: [
      ...from.files
        .filter((file) => edits[file.path] !== null)
        .map((file) => ({ path: file.path, content: edits[file.path] ?? file.content })),
      ...Object.entries(added).map(([path, content]) => ({ path, content })),
    ],
  });

  it('takes their removal and their new files where the person did nothing', () => {
    const { draft } = broughtIn(
      draftOf(V3),
      theirs(V3, { 'agents/reviewer.md': null }, { 'agents/sprocket.md': 'theirs' }),
    );
    expect(asMap(draft)).toEqual({
      'factory.yml': 'version: 1\n',
      'automations/triage.yaml': 'triage v3',
      'agents/sprocket.md': 'theirs',
    });
    expect(isChanged(draft)).toBe(false);
  });

  it('keeps the person’s new file at a path both added, naming it when the texts differ', () => {
    const mine = withFileAdded(
      withFileAdded(draftOf(V3), 'agents/sprocket.md', 'mine'),
      'agents/cog.md',
      'same',
    );
    const result = broughtIn(
      mine,
      theirs(V3, {}, { 'agents/sprocket.md': 'theirs', 'agents/cog.md': 'same' }),
    );
    expect(contentOf(result.draft, 'agents/sprocket.md')).toBe('mine');
    expect(contentOf(result.draft, 'agents/cog.md')).toBe('same');
    expect(fileMarks(result.draft).get('agents/sprocket.md')).toEqual({
      isNew: false,
      renamedFrom: null,
      changed: true,
    });
    expect(result.bothChanged).toEqual(['agents/sprocket.md']);
    expect(pathsOf(result.draft).filter((path) => path === 'agents/sprocket.md')).toHaveLength(1);
  });

  it('keeps a file the person removed and they changed removed, named, with the person’s text', () => {
    const mine = withRemoved(
      withEdit(draftOf(V3), 'agents/reviewer.md', 'mine'),
      'agents/reviewer.md',
    );
    const result = broughtIn(mine, theirs(V3, { 'agents/reviewer.md': 'theirs' }));
    expect(pathsOf(result.draft)).not.toContain('agents/reviewer.md');
    expect(removedPaths(result.draft)).toEqual(['agents/reviewer.md']);
    expect(result.removedChanged).toEqual(['agents/reviewer.md']);
    expect(isChanged(result.draft)).toBe(true);
    const restored = withRestored(result.draft, 'agents/reviewer.md');
    expect(contentOf(restored, 'agents/reviewer.md')).toBe('mine');
    expect(fileMarks(restored).get('agents/reviewer.md')?.changed).toBe(true);
  });

  it('keeps a file the person removed and they did not change removed, unnamed', () => {
    const result = broughtIn(
      withRemoved(draftOf(V3), 'agents/reviewer.md'),
      theirs(V3, { 'factory.yml': 'version: 1\n# theirs\n' }),
    );
    expect(removedPaths(result.draft)).toEqual(['agents/reviewer.md']);
    expect(result.removedChanged).toEqual([]);
    expect(isChanged(result.draft)).toBe(true);
  });

  it('has nothing to do for a file both removed: it stays listed, and is no change', () => {
    const result = broughtIn(
      withRemoved(draftOf(V3), 'agents/reviewer.md'),
      theirs(V3, { 'agents/reviewer.md': null }),
    );
    expect(isChanged(result.draft)).toBe(false);
    expect(removedPaths(result.draft)).toEqual(['agents/reviewer.md']);
    expect(changeSummary(result.draft).removed).toBe(0);
    expect(result.removedChanged).toEqual([]);
    expect(result.bothChanged).toEqual([]);
  });

  it('follows a rename: their change moves to the new name when the person only renamed it', () => {
    const renamed = withRenamed(draftOf(V3), 'agents/reviewer.md', 'agents/checker.md');
    const result = broughtIn(renamed, theirs(V3, { 'agents/reviewer.md': 'theirs' }));
    expect(asMap(result.draft)).toEqual({
      'factory.yml': 'version: 1\n',
      'agents/checker.md': 'theirs',
      'automations/triage.yaml': 'triage v3',
    });
    expect(fileMarks(result.draft).get('agents/checker.md')).toEqual({
      isNew: false,
      renamedFrom: 'agents/reviewer.md',
      changed: false,
    });
    expect(result.followed).toEqual(['agents/checker.md']);
    expect(result.bothChanged).toEqual([]);
  });

  it('keeps the person’s text at the new name when they renamed and edited it, and names it', () => {
    const mine = withRenamed(
      withEdit(draftOf(V3), 'agents/reviewer.md', 'mine'),
      'agents/reviewer.md',
      'agents/checker.md',
    );
    const result = broughtIn(mine, theirs(V3, { 'agents/reviewer.md': 'theirs' }));
    expect(contentOf(result.draft, 'agents/checker.md')).toBe('mine');
    expect(result.bothChanged).toEqual(['agents/checker.md']);
  });

  it('keeps a renamed file they removed, as the person’s new file, and names it', () => {
    const renamed = withRenamed(draftOf(V3), 'agents/reviewer.md', 'agents/checker.md');
    const result = broughtIn(renamed, theirs(V3, { 'agents/reviewer.md': null }));
    expect(contentOf(result.draft, 'agents/checker.md')).toBe('reviewer v3');
    expect(fileMarks(result.draft).get('agents/checker.md')?.isNew).toBe(true);
    expect(result.goneThere).toEqual(['agents/checker.md']);
  });

  it('moves a file they added or changed inside a skill the person renamed, and names it', () => {
    const renamed = withSkillRenamed(draftOf(WITH_SKILL), 'triage', 'sorting');
    const result = broughtIn(
      renamed,
      theirs(
        WITH_SKILL,
        { 'skills/triage/refs/queries.md': 'queries v4' },
        { 'skills/triage/refs/labels.md': 'labels' },
      ),
    );
    expect(asMap(result.draft)).toMatchObject({
      'skills/sorting/SKILL.md':
        '---\nname: sorting\ndescription: Sorts issues.\n---\n\nSort them.\n',
      'skills/sorting/refs/queries.md': 'queries v4',
      'skills/sorting/refs/labels.md': 'labels',
    });
    expect(pathsOf(result.draft).some((path) => path.startsWith('skills/triage/'))).toBe(false);
    expect(result.followed).toEqual([
      'skills/sorting/refs/queries.md',
      'skills/sorting/refs/labels.md',
    ]);
  });

  it('keeps a file they added inside a skill the person removed out, with the skill, named', () => {
    const removed = withSkillRemoved(draftOf(WITH_SKILL), 'triage');
    const result = broughtIn(
      removed,
      theirs(WITH_SKILL, {}, { 'skills/triage/refs/labels.md': 'labels' }),
    );
    expect(pathsOf(result.draft).some((path) => path.startsWith('skills/'))).toBe(false);
    expect(result.draft.removed.map((entry) => entry.label)).toEqual(['skills/triage/']);
    expect(removedPaths(result.draft)).toContain('skills/triage/refs/labels.md');
    expect(result.removedChanged).toEqual(['skills/triage/refs/labels.md']);
    const restored = withRestored(result.draft, 'skills/triage/');
    expect(contentOf(restored, 'skills/triage/refs/labels.md')).toBe('labels');
    expect(contentOf(restored, 'skills/triage/SKILL.md')).toBe(TRIAGE_SKILL);
    expect(isChanged(restored)).toBe(false);
  });

  it('keeps the person’s rename where they added a file at its new name, theirs under Removed', () => {
    const renamed = withRenamed(draftOf(V3), 'agents/reviewer.md', 'agents/checker.md');
    const result = broughtIn(renamed, theirs(V3, {}, { 'agents/checker.md': 'theirs' }));
    expect(contentOf(result.draft, 'agents/checker.md')).toBe('reviewer v3');
    expect(removedPaths(result.draft)).toEqual(['agents/checker.md']);
    expect(canRestore(result.draft, 'agents/checker.md')).toBe(false);
    expect(result.bothChanged).toEqual(['agents/checker.md']);
    expect(pathsOf(result.draft).filter((path) => path === 'agents/checker.md')).toHaveLength(1);
  });

  it('keeps a new file the person removed removed when they added one at its path', () => {
    const mine = withRemoved(withFileAdded(draftOf(V3), 'agents/cog.md', 'mine'), 'agents/cog.md');
    const result = broughtIn(mine, theirs(V3, {}, { 'agents/cog.md': 'theirs' }));
    expect(pathsOf(result.draft)).not.toContain('agents/cog.md');
    expect(removedPaths(result.draft)).toEqual(['agents/cog.md']);
    expect(result.removedChanged).toEqual(['agents/cog.md']);
    expect(contentOf(withRestored(result.draft, 'agents/cog.md'), 'agents/cog.md')).toBe('mine');
  });

  it('never leaves two files at one path, and keeps every saved file accounted for', () => {
    let mine = draftOf(WITH_SKILL);
    mine = withRenamed(mine, 'agents/reviewer.md', 'agents/checker.md');
    mine = withFileAdded(mine, 'agents/reviewer.md', 'a new reviewer');
    mine = withSkillRenamed(mine, 'triage', 'sorting');
    const { draft } = broughtIn(
      mine,
      theirs(
        WITH_SKILL,
        { 'agents/reviewer.md': 'theirs' },
        { 'agents/checker.md': 'x', 'skills/triage/notes.md': 'y' },
      ),
    );
    const paths = pathsOf(draft);
    expect(new Set(paths).size).toBe(paths.length);
    const from = [...draft.files, ...draft.removed.flatMap((entry) => entry.files)]
      .map((file) => file.from)
      .filter((path) => path !== null);
    expect(new Set(from).size).toBe(from.length);
    expect(new Set(from)).toEqual(new Set(draft.base.keys()));
  });
});

describe('afterSave, over adds, renames and removals', () => {
  const saving = (sent: FactoryDraft) => ({ version: 4, files: filesOf(sent) });

  it('empties Removed of what the save removed, and shows nothing it saved as changed', () => {
    let sent = draftOf(WITH_SKILL);
    sent = withRemoved(sent, 'agents/reviewer.md');
    sent = withSkillRenamed(sent, 'triage', 'sorting');
    sent = withFileAdded(sent, 'agents/sprocket.md', 'hello');
    sent = withRemoved(withFileAdded(sent, 'agents/cog.md', 'gone'), 'agents/cog.md');
    const next = afterSave(sent, sent, saving(sent));
    expect(next.baseVersion).toBe(4);
    expect(hasWork(next)).toBe(false);
    expect(next.removed).toEqual([]);
    expect([...fileMarks(next).values()].every((mark) => !mark.isNew && !mark.changed)).toBe(true);
    expect([...fileMarks(next).values()].every((mark) => mark.renamedFrom === null)).toBe(true);
  });

  it('keeps an add, a rename, a removal and a restore made while it saved', () => {
    let sent = draftOf(V3);
    sent = withRemoved(sent, 'factory.yml');
    sent = withEdit(sent, 'agents/reviewer.md', 'sent');
    let current = withFileAdded(sent, 'agents/sprocket.md', 'typed meanwhile');
    current = withRenamed(current, 'agents/reviewer.md', 'agents/checker.md');
    current = withRemoved(current, 'automations/triage.yaml');
    current = withRestored(current, 'factory.yml');
    const next = afterSave(current, sent, saving(sent));
    expect(asMap(next)).toEqual({
      'agents/checker.md': 'sent',
      'agents/sprocket.md': 'typed meanwhile',
      'factory.yml': 'version: 1\n',
    });
    const marks = fileMarks(next);
    expect(marks.get('agents/checker.md')).toEqual({
      isNew: false,
      renamedFrom: 'agents/reviewer.md',
      changed: false,
    });
    expect(marks.get('agents/sprocket.md')?.isNew).toBe(true);
    // The save removed factory.yml; brought back meanwhile, it is a new file now.
    expect(marks.get('factory.yml')?.isNew).toBe(true);
    expect(next.removed.map((entry) => entry.label)).toEqual(['automations/triage.yaml']);
    expect(changeSummary(next).removed).toBe(1);
  });
});
