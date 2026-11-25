import type { FactoryFile, FactoryVersion } from './factories';

/**
 * A person's changes to a factory's files, over the version they were made from: a file's new
 * text, a new file, or a file deleted. Nothing is renamed: a file is deleted and another added.
 * The draft keeps a change only while it differs from the version, so typing a file back to its
 * text leaves it unchanged, and deleting a file that was never saved forgets it.
 *
 * Maps keep the files, so a path such as `__proto__` is a key like any other.
 */
export type FactoryDraft = {
  /** The version the edits were made from: what a save names as its base. */
  readonly baseVersion: number;
  /** That version's files, in its order: path to text. */
  readonly base: ReadonlyMap<string, string>;
  /**
   * The changed files, path to text, each different from the base's: a path the base does not
   * hold is a new file. `null` is a file of the base deleted.
   */
  readonly edits: ReadonlyMap<string, string | null>;
};

/** A draft with no edits, over `version`. */
export function draftOf(version: Pick<FactoryVersion, 'version' | 'files'>): FactoryDraft {
  return {
    baseVersion: version.version,
    base: new Map(version.files.map((file) => [file.path, file.content])),
    edits: new Map(),
  };
}

/** The draft with `path`'s text set to `content`; an edit back to the base's text is no edit. */
export function withEdit(draft: FactoryDraft, path: string, content: string): FactoryDraft {
  const unchanged = draft.base.get(path) === content;
  if (unchanged ? !draft.edits.has(path) : draft.edits.get(path) === content) return draft;
  const edits = new Map(draft.edits);
  if (unchanged) edits.delete(path);
  else edits.set(path, content);
  return { ...draft, edits };
}

/**
 * The draft with a new, empty file at `path`, unsaved until a save sends it; the same draft when
 * the person already sees a file there. A file of the base they deleted comes back empty.
 */
export function withFile(draft: FactoryDraft, path: string): FactoryDraft {
  return contentOf(draft, path) === undefined ? withEdit(draft, path, '') : draft;
}

/**
 * The draft with `path` deleted, until a save: a file of the base is marked deleted (its edit
 * dropped), and a new file is forgotten. The same draft for a file the person does not see.
 */
export function withoutFile(draft: FactoryDraft, path: string): FactoryDraft {
  if (contentOf(draft, path) === undefined) return draft;
  const edits = new Map(draft.edits);
  if (draft.base.has(path)) edits.set(path, null);
  else edits.delete(path);
  return { ...draft, edits };
}

/**
 * The draft with a file deleted just now put back, its text as it was before (`content`): Undo.
 * The same draft when a file is there again, so nothing added since is lost.
 */
export function withRestored(draft: FactoryDraft, path: string, content: string): FactoryDraft {
  return contentOf(draft, path) === undefined ? withEdit(draft, path, content) : draft;
}

/** Whether the version the draft was made from holds `path`: false for a file added since. */
export function isSaved(draft: FactoryDraft, path: string): boolean {
  return draft.base.has(path);
}

/** The draft with `paths`' changes dropped: each file back to the base's text, deleted or not. */
export function withoutEdits(draft: FactoryDraft, paths: Iterable<string>): FactoryDraft {
  const edits = new Map(draft.edits);
  for (const path of paths) edits.delete(path);
  return edits.size === draft.edits.size ? draft : { ...draft, edits };
}

/**
 * A file's text as the person sees it: their edit, else the base's; undefined for no such file,
 * a deleted one included.
 */
export function contentOf(draft: FactoryDraft, path: string): string | undefined {
  const edit = draft.edits.get(path);
  if (edit === null) return undefined;
  return edit ?? draft.base.get(path);
}

/** Whether the person has changed anything. */
export function isChanged(draft: FactoryDraft): boolean {
  return draft.edits.size > 0;
}

/**
 * Every file of the draft as a save sends it: the base's files in their order, each with its
 * edit and the deleted ones left out, then every file the base does not hold, in the order they
 * were added (a new one, or one a newer version took away, kept so the person's text is never
 * lost; see `broughtIn`).
 */
export function filesOf(draft: FactoryDraft): FactoryFile[] {
  const files: FactoryFile[] = [];
  for (const [path, content] of draft.base) {
    const edit = draft.edits.get(path);
    if (edit !== null) files.push({ path, content: edit ?? content });
  }
  for (const [path, content] of draft.edits) {
    if (!draft.base.has(path) && content !== null) files.push({ path, content });
  }
  return files;
}

/** Every path of the draft, as `filesOf` lists them. */
export function pathsOf(draft: FactoryDraft): string[] {
  return filesOf(draft).map((file) => file.path);
}

/** What bringing a newer version into a draft came to. */
export type BroughtIn = {
  /** The draft over the newer version. */
  draft: FactoryDraft;
  /** Files the person and the newer version both changed: the person's text is kept. */
  bothChanged: string[];
  /** Files the person changed that the newer version no longer holds: kept, so a save adds them back. */
  goneThere: string[];
  /** Files the person deleted that the newer version changed: still deleted, so a save deletes them. */
  deletedChanged: string[];
};

/**
 * The draft moved onto `latest`, a version saved since it was made, so a save no longer undoes
 * it: every file the person did not touch takes the newer text, and every file they did keeps
 * theirs. A file both changed keeps the person's text and is named (`bothChanged`), as is one
 * the newer version took away (`goneThere`) and one the person deleted that it changed
 * (`deletedChanged`), so the person can check before saving. A file the person added stays added,
 * and is named only when the newer version added it too. An edit the newer version already holds
 * is no edit any more.
 */
export function broughtIn(
  draft: FactoryDraft,
  latest: Pick<FactoryVersion, 'version' | 'files'>,
): BroughtIn {
  let next = draftOf(latest);
  const bothChanged: string[] = [];
  const goneThere: string[] = [];
  const deletedChanged: string[] = [];
  for (const [path, mine] of draft.edits) {
    const theirs = next.base.get(path);
    const before = draft.base.get(path);
    if (mine === null) {
      if (theirs === undefined) continue;
      if (theirs !== before) deletedChanged.push(path);
      next = withoutFile(next, path);
      continue;
    }
    if (theirs === undefined) {
      if (before !== undefined) goneThere.push(path);
      next = { ...next, edits: new Map(next.edits).set(path, mine) };
      continue;
    }
    if (theirs !== before && theirs !== mine) bothChanged.push(path);
    next = withEdit(next, path, mine);
  }
  return { draft: next, bothChanged, goneThere, deletedChanged };
}

/**
 * The draft once `sent` is saved as `saved`: over the saved version, keeping only what the person
 * did while the save was on its way (`current` against `sent`: text typed, a file added or
 * deleted), so nothing done meanwhile is lost and nothing saved is shown as still changed.
 */
export function afterSave(
  current: FactoryDraft,
  sent: FactoryDraft,
  saved: Pick<FactoryVersion, 'version' | 'files'>,
): FactoryDraft {
  let next = draftOf(saved);
  for (const path of new Set([...current.edits.keys(), ...sent.edits.keys()])) {
    const now = contentOf(current, path);
    if (now === contentOf(sent, path)) continue;
    next = now === undefined ? withoutFile(next, path) : withEdit(next, path, now);
  }
  return next;
}
