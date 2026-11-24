import { describe, expect, it } from 'vitest';
import {
  afterSave,
  broughtIn,
  contentOf,
  draftOf,
  filesOf,
  isChanged,
  pathsOf,
  withEdit,
  withoutEdits,
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
});
