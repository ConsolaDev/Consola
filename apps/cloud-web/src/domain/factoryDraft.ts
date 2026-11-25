import type { FactoryFile, FactoryVersion } from './factories';

/**
 * A person's changes to a factory's files, over the version they were made from: files edited,
 * added, renamed and removed, all kept until Save sends the whole set as the next version.
 *
 * Every file the person sees is a `DraftFile`: its text, where it is now, and the saved path it
 * came from (none for a file made since). A rename moves a file and keeps its text; renaming it
 * back to its saved name leaves no change. A removed file leaves the tree for "Removed on save",
 * with the person's text, so Restore brings it back as it was; a skill is removed as one entry,
 * its folder. Whether anything changed is asked of the set a save would send, so undoing a change
 * by hand leaves nothing changed.
 *
 * A file's `id` stays with it through every change, so the page can follow a file that moved
 * (its tab, its editor) and a save can tell what changed while it was on its way. Maps keep the
 * files, so a path such as `__proto__` is a key like any other.
 */

/** One file as the person sees it. */
export type DraftFile = {
  /** The file's own, for as long as the draft lives. */
  readonly id: number;
  /** The path the version holds it at, or null for a file made since. */
  readonly from: string | null;
  /** Where it is now. */
  readonly path: string;
  readonly content: string;
};

/** What the person removed, waiting under "Removed on save": one file, or a whole skill. */
export type Removal = {
  /** A file's path, or a skill's folder with its slash (`skills/triage/`). */
  readonly label: string;
  /** The files it took, each with the person's text. */
  readonly files: readonly DraftFile[];
};

export type FactoryDraft = {
  /** The version the changes were made from: what a save names as its base. */
  readonly baseVersion: number;
  /** That version's files, in its order: path to text. */
  readonly base: ReadonlyMap<string, string>;
  /** The files in the tree: the version's in its order, then the ones made since. */
  readonly files: readonly DraftFile[];
  /** What waits under "Removed on save", in the order it was removed. */
  readonly removed: readonly Removal[];
  /** The id the next file made gets. */
  readonly nextId: number;
};

type Version = Pick<FactoryVersion, 'version' | 'files'>;

/** A draft with no changes, over `version`. */
export function draftOf(version: Version, firstId = 0): FactoryDraft {
  const files = version.files.map((file, at) => ({
    id: firstId + at,
    from: file.path,
    path: file.path,
    content: file.content,
  }));
  return {
    baseVersion: version.version,
    base: new Map(version.files.map((file) => [file.path, file.content])),
    files,
    removed: [],
    nextId: firstId + files.length,
  };
}

/** The draft with `path`'s text set to `content`; a path the tree does not hold is no edit. */
export function withEdit(draft: FactoryDraft, path: string, content: string): FactoryDraft {
  const at = draft.files.findIndex((file) => file.path === path);
  const file = draft.files[at];
  if (!file || file.content === content) return draft;
  return { ...draft, files: replaced(draft.files, at, { ...file, content }) };
}

/** A file's text as the person sees it; undefined for no file in the tree at `path`. */
export function contentOf(draft: FactoryDraft, path: string): string | undefined {
  return draft.files.find((file) => file.path === path)?.content;
}

/** Whether a save would send anything but the version's own files. */
export function isChanged(draft: FactoryDraft): boolean {
  if (draft.files.length !== draft.base.size) return true;
  return draft.files.some((file) => draft.base.get(file.path) !== file.content);
}

/** Whether the draft holds anything of the person's: a change, or a file under Removed. */
export function hasWork(draft: FactoryDraft): boolean {
  return isChanged(draft) || draft.removed.length > 0;
}

/** Every file of the draft as a save sends it. */
export function filesOf(draft: FactoryDraft): FactoryFile[] {
  return draft.files.map(({ path, content }) => ({ path, content }));
}

/** Every path in the tree, as `filesOf` lists them. */
export function pathsOf(draft: FactoryDraft): string[] {
  return draft.files.map((file) => file.path);
}

/** Every path waiting under "Removed on save". */
export function removedPaths(draft: FactoryDraft): string[] {
  return draft.removed.flatMap((entry) => entry.files.map((file) => file.path));
}

/** Every path the draft holds, in the tree or under Removed: none of them can be made again. */
export function heldPaths(draft: FactoryDraft): Set<string> {
  return new Set([...pathsOf(draft), ...removedPaths(draft)]);
}

/** The draft with a new file at `path`; a path it already holds is refused, the same draft. */
export function withFileAdded(draft: FactoryDraft, path: string, content: string): FactoryDraft {
  if (heldPaths(draft).has(path)) return draft;
  return {
    ...draft,
    files: [...draft.files, { id: draft.nextId, from: null, path, content }],
    nextId: draft.nextId + 1,
  };
}

/** The draft with the file at `path` moved to `to`, its text kept; a held `to` is refused. */
export function withRenamed(draft: FactoryDraft, path: string, to: string): FactoryDraft {
  if (path === to || heldPaths(draft).has(to)) return draft;
  const at = draft.files.findIndex((file) => file.path === path);
  const file = draft.files[at];
  if (!file) return draft;
  return { ...draft, files: replaced(draft.files, at, { ...file, path: to }) };
}

/** A skill's folder, with its slash. */
export const skillFolder = (skill: string) => `skills/${skill}/`;

/**
 * The draft with skill `skill` renamed `to`: its folder and every file in it move, and its
 * `SKILL.md`'s `name:` follows when it named the old folder, since the format requires the two to
 * match. Nothing else is rewritten. A skill the draft already holds at `to` is refused.
 */
export function withSkillRenamed(draft: FactoryDraft, skill: string, to: string): FactoryDraft {
  const from = skillFolder(skill);
  const target = skillFolder(to);
  if (skill === to || [...heldPaths(draft)].some((path) => path.startsWith(target))) return draft;
  if (!draft.files.some((file) => file.path.startsWith(from))) return draft;
  return {
    ...draft,
    files: draft.files.map((file) => {
      if (!file.path.startsWith(from)) return file;
      const path = target + file.path.slice(from.length);
      const content =
        path === `${target}SKILL.md` ? withSkillName(file.content, skill, to) : file.content;
      return { ...file, path, content };
    }),
  };
}

/**
 * A `SKILL.md`'s text with the `name:` of its front matter set to `to`, when it says `from`
 * (quoted or not); any other text is left as it is.
 */
export function withSkillName(text: string, from: string, to: string): string {
  const lines = text.split('\n');
  if (lines[0]?.replace(/\r$/, '') !== '---') return text;
  for (let at = 1; at < lines.length; at++) {
    const raw = lines[at] ?? '';
    const line = raw.replace(/\r$/, '');
    if (line === '---') break;
    const named = /^name:([ \t]*)(["']?)([^"'#]*?)\2([ \t]*(?:#.*)?)$/.exec(line);
    if (!named) continue;
    if (named[3] !== from) return text;
    const quote = named[2] ?? '';
    const end = raw.endsWith('\r') ? '\r' : '';
    lines[at] = `name:${named[1]}${quote}${to}${quote}${named[4]}${end}`;
    return lines.join('\n');
  }
  return text;
}

/** The draft with the file at `path` under "Removed on save", its text kept. */
export function withRemoved(draft: FactoryDraft, path: string): FactoryDraft {
  const file = draft.files.find((candidate) => candidate.path === path);
  if (!file) return draft;
  return {
    ...draft,
    files: draft.files.filter((candidate) => candidate !== file),
    removed: [...draft.removed, { label: path, files: [file] }],
  };
}

/** The draft with skill `skill` under "Removed on save", its whole folder as one entry. */
export function withSkillRemoved(draft: FactoryDraft, skill: string): FactoryDraft {
  const folder = skillFolder(skill);
  const files = draft.files.filter((file) => file.path.startsWith(folder));
  if (files.length === 0) return draft;
  return {
    ...draft,
    files: draft.files.filter((file) => !file.path.startsWith(folder)),
    removed: [...draft.removed, { label: folder, files }],
  };
}

/**
 * Whether the entry `label` can come back: every path it would take is free in the tree. One a
 * newer version put a file at waits until that file is renamed or removed.
 */
export function canRestore(draft: FactoryDraft, label: string): boolean {
  const entry = draft.removed.find((candidate) => candidate.label === label);
  if (!entry) return false;
  const live = new Set(pathsOf(draft));
  return entry.files.every((file) => !live.has(file.path));
}

/** The draft with the entry `label` back in the tree, as it was removed, edits included. */
export function withRestored(draft: FactoryDraft, label: string): FactoryDraft {
  if (!canRestore(draft, label)) return draft;
  const at = draft.removed.findIndex((candidate) => candidate.label === label);
  const entry = draft.removed[at];
  if (!entry) return draft;
  return {
    ...draft,
    files: [...draft.files, ...entry.files],
    removed: draft.removed.filter((_, index) => index !== at),
  };
}

/**
 * The draft back at its version: new files gone, removed files back, renames undone. A saved
 * file keeps its id, so the page can follow a renamed one back to its name.
 */
export function discarded(draft: FactoryDraft): FactoryDraft {
  const ids = new Map<string, number>();
  for (const file of [...draft.files, ...draft.removed.flatMap((entry) => entry.files)]) {
    if (file.from !== null) ids.set(file.from, file.id);
  }
  let nextId = draft.nextId;
  const files = [...draft.base].map(([path, content]) => ({
    id: ids.get(path) ?? nextId++,
    from: path,
    path,
    content,
  }));
  return { ...draft, files, removed: [], nextId };
}

/** Where each file of `before` that is still in the tree moved to in `after`: old path to new. */
export function pathMoves(before: FactoryDraft, after: FactoryDraft): Map<string, string> {
  const was = new Map(before.files.map((file) => [file.id, file.path]));
  const moves = new Map<string, string>();
  for (const file of after.files) {
    const path = was.get(file.id);
    if (path !== undefined && path !== file.path) moves.set(path, file.path);
  }
  return moves;
}

/** What the tree says of a file: made since the version, renamed, its text changed. */
export type FileMark = {
  readonly isNew: boolean;
  /** The path the version holds it at, when that is not where it is now. */
  readonly renamedFrom: string | null;
  readonly changed: boolean;
};

/** Each file's mark, by path. */
export function fileMarks(draft: FactoryDraft): Map<string, FileMark> {
  return new Map(
    draft.files.map((file) => [
      file.path,
      {
        isNew: file.from === null,
        renamedFrom: file.from !== null && file.from !== file.path ? file.from : null,
        changed: file.from !== null && draft.base.get(file.from) !== file.content,
      },
    ]),
  );
}

/** How many files a save adds, renames, changes and removes. */
export type ChangeSummary = {
  readonly added: number;
  readonly renamed: number;
  readonly changed: number;
  readonly removed: number;
};

export function changeSummary(draft: FactoryDraft): ChangeSummary {
  const marks = [...fileMarks(draft).values()];
  return {
    added: marks.filter((mark) => mark.isNew).length,
    renamed: marks.filter((mark) => mark.renamedFrom !== null).length,
    changed: marks.filter((mark) => mark.changed).length,
    removed: draft.removed.flatMap((entry) => entry.files).filter((file) => file.from !== null)
      .length,
  };
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
export function broughtIn(draft: FactoryDraft, latest: Version): BroughtIn {
  let next = draftOf(latest, draft.nextId);
  const bothChanged: string[] = [];
  const goneThere: string[] = [];
  for (const file of draft.files) {
    if (file.from === null) {
      next = withFileAdded(next, file.path, file.content);
      continue;
    }
    if (file.content === draft.base.get(file.from)) continue;
    const theirs = next.base.get(file.from);
    if (theirs === undefined) {
      goneThere.push(file.path);
      next = withFileAdded(next, file.path, file.content);
      continue;
    }
    if (theirs !== draft.base.get(file.from) && theirs !== file.content)
      bothChanged.push(file.path);
    next = withEdit(next, file.path, file.content);
  }
  return { draft: next, bothChanged, goneThere };
}

/**
 * The draft once `sent` is saved as `saved`: over the saved version, keeping only what the person
 * did while the save was on its way (`current` against `sent`), so nothing done meanwhile is lost
 * and nothing saved is shown as still changed.
 */
export function afterSave(current: FactoryDraft, sent: FactoryDraft, saved: Version): FactoryDraft {
  let next = draftOf(saved, current.nextId);
  const wasSent = new Map(sent.files.map((file) => [file.id, file]));
  for (const file of current.files) {
    const before = wasSent.get(file.id);
    if (!before) next = withFileAdded(next, file.path, file.content);
    else if (file.content !== before.content) next = withEdit(next, before.path, file.content);
  }
  return next;
}

function replaced<T>(list: readonly T[], at: number, value: T): T[] {
  const copy = [...list];
  copy[at] = value;
  return copy;
}
