import type { FactoryFile, FactoryVersion } from './factories';

/**
 * A person's edits to a factory's files, over the version they were made from. Nothing here adds,
 * renames or removes a file: the page is for reading a factory and fixing it in place, and a
 * factory is made elsewhere. The draft keeps an edit only while it differs from the version's
 * text, so undoing a change by hand leaves the file unchanged.
 *
 * Maps keep the files, so a path such as `__proto__` is a key like any other.
 */
export type FactoryDraft = {
  /** The version the edits were made from: what a save names as its base. */
  readonly baseVersion: number;
  /** That version's files, in its order: path to text. */
  readonly base: ReadonlyMap<string, string>;
  /** The edited files, path to text, each different from the base's. */
  readonly edits: ReadonlyMap<string, string>;
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

/** The draft keeping `path`'s edit though its base has no such file (a file a newer version took away). */
function withKeptEdit(draft: FactoryDraft, path: string, content: string): FactoryDraft {
  return { ...draft, edits: new Map(draft.edits).set(path, content) };
}

/** The draft with `paths`' edits dropped, each file back to the base's text. */
export function withoutEdits(draft: FactoryDraft, paths: Iterable<string>): FactoryDraft {
  const edits = new Map(draft.edits);
  for (const path of paths) edits.delete(path);
  return edits.size === draft.edits.size ? draft : { ...draft, edits };
}

/** A file's text as the person sees it: their edit, else the base's; undefined for no such file. */
export function contentOf(draft: FactoryDraft, path: string): string | undefined {
  return draft.edits.get(path) ?? draft.base.get(path);
}

/** Whether the person has changed anything. */
export function isChanged(draft: FactoryDraft): boolean {
  return draft.edits.size > 0;
}

/**
 * Every file of the draft as a save sends it: the base's files in their order, each with its
 * edit, then any edited file the base does not hold (one a newer version took away, kept so the
 * person's text is never lost; see `broughtIn`).
 */
export function filesOf(draft: FactoryDraft): FactoryFile[] {
  const files = [...draft.base].map(([path, content]) => ({
    path,
    content: draft.edits.get(path) ?? content,
  }));
  for (const [path, content] of draft.edits) {
    if (!draft.base.has(path)) files.push({ path, content });
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
};

/**
 * The draft moved onto `latest`, a version saved since it was made, so a save no longer undoes
 * it: every file the person did not touch takes the newer text, and every file they did keeps
 * theirs. A file both changed keeps the person's text and is named (`bothChanged`), as is one
 * the newer version took away (`goneThere`), so the person can check before saving. An edit the
 * newer version already holds is no edit any more.
 */
export function broughtIn(
  draft: FactoryDraft,
  latest: Pick<FactoryVersion, 'version' | 'files'>,
): BroughtIn {
  let next = draftOf(latest);
  const bothChanged: string[] = [];
  const goneThere: string[] = [];
  for (const [path, mine] of draft.edits) {
    const theirs = next.base.get(path);
    if (theirs === undefined) {
      goneThere.push(path);
      next = withKeptEdit(next, path, mine);
      continue;
    }
    if (theirs !== draft.base.get(path) && theirs !== mine) bothChanged.push(path);
    next = withEdit(next, path, mine);
  }
  return { draft: next, bothChanged, goneThere };
}

/**
 * The draft once `sent` is saved as `saved`: over the saved version, keeping only what the person
 * typed while the save was on its way (`current` against `sent`), so nothing typed meanwhile is
 * lost and nothing saved is shown as still changed.
 */
export function afterSave(
  current: FactoryDraft,
  sent: FactoryDraft,
  saved: Pick<FactoryVersion, 'version' | 'files'>,
): FactoryDraft {
  let next = draftOf(saved);
  for (const path of new Set([...current.edits.keys(), ...sent.edits.keys()])) {
    const now = contentOf(current, path);
    if (now !== undefined && now !== contentOf(sent, path)) next = withEdit(next, path, now);
  }
  return next;
}
