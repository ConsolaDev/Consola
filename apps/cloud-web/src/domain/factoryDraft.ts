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
  return draft.removed.some((entry) => entry.label === label) && !restoreBlocker(draft, label);
}

/** The file in the tree at a path the entry `label` would take, which Restore waits on; or null. */
export function restoreBlocker(draft: FactoryDraft, label: string): string | null {
  const entry = draft.removed.find((candidate) => candidate.label === label);
  const live = new Set(pathsOf(draft));
  return entry?.files.find((file) => live.has(file.path))?.path ?? null;
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
  /** How many files a save touches, each once: one renamed and edited is one. */
  readonly files: number;
};

export function changeSummary(draft: FactoryDraft): ChangeSummary {
  const marks = [...fileMarks(draft).values()];
  const removed = draft.removed
    .flatMap((entry) => entry.files)
    .filter((file) => file.from !== null).length;
  return {
    added: marks.filter((mark) => mark.isNew).length,
    renamed: marks.filter((mark) => mark.renamedFrom !== null).length,
    changed: marks.filter((mark) => mark.changed).length,
    removed,
    files:
      marks.filter((mark) => mark.isNew || mark.renamedFrom !== null || mark.changed).length +
      removed,
  };
}

/**
 * What bringing a newer version into a draft came to: the draft over it, and every file where
 * what the person did meets a change of theirs, by where it is now, so the person can check it
 * before saving.
 */
export type BroughtIn = {
  /** The draft over the newer version. */
  draft: FactoryDraft;
  /**
   * Files both changed, a path both added with different text, and a path the person's rename
   * took that the newer version added (theirs waits under Removed): the person's text is kept.
   */
  bothChanged: string[];
  /** Files the person changed or renamed that the newer version removed: kept, so a save adds them back. */
  goneThere: string[];
  /**
   * Files the person removed that the newer version changed, or added inside a skill the person
   * removed: they stay removed, and Restore brings back the person's text.
   */
  removedChanged: string[];
  /**
   * Files the person only renamed (a skill's folder included) that the newer version changed, or
   * added inside a skill the person renamed: their text follows the new name.
   */
  followed: string[];
};

/** A path's skill folder (`skills/triage/`), or null for a path in no skill. */
function skillFolderOf(path: string): string | null {
  return /^skills\/[^/]+\//.exec(path)?.[0] ?? null;
}

/**
 * The draft moved onto `latest`, a version saved since it was made, so a save no longer undoes
 * it. One rule: what the person did stands, and every file where it meets a change of theirs is
 * named (`BroughtIn`).
 *
 * - A file the person did not touch takes their version, their adds and removals included.
 * - A file both changed keeps the person's text. One the person removed stays removed.
 * - A rename is followed as a rename: a file the person only renamed takes their text at its new
 *   name; one they renamed and edited keeps the person's text.
 * - A skill's folder renamed or removed takes the files their version adds inside it along.
 *
 * Every path the newer version holds stays accounted for exactly once, in the tree or under
 * Removed, so no file of theirs is dropped unseen; and no two files share a path.
 */
export function broughtIn(draft: FactoryDraft, latest: Version): BroughtIn {
  const old = draft.base;
  const theirs = new Map(latest.files.map((file) => [file.path, file.content]));
  const said = {
    bothChanged: [] as string[],
    goneThere: [] as string[],
    removedChanged: [] as string[],
    followed: [] as string[],
  };
  let nextId = draft.nextId;
  const made = (from: string, path: string, content: string): DraftFile => ({
    id: nextId++,
    from,
    path,
    content,
  });

  // The person's files in the tree, each set against what their version did with its saved path.
  const live: DraftFile[] = [];
  for (const file of draft.files) {
    if (file.from === null) {
      live.push(file);
      continue;
    }
    const saved = old.get(file.from);
    const there = theirs.get(file.from);
    const edited = file.content !== saved;
    if (file.path === file.from && !edited) {
      if (there !== undefined) live.push({ ...file, content: there });
    } else if (there === undefined) {
      live.push({ ...file, from: null });
      said.goneThere.push(file.path);
    } else if (there === saved) {
      live.push(file);
    } else if (edited) {
      live.push(file);
      if (file.content !== there) said.bothChanged.push(file.path);
    } else {
      live.push({ ...file, content: there });
      said.followed.push(file.path);
    }
  }

  // What waits under Removed stays there; a file both removed is now one never saved.
  const entries = draft.removed.map((entry) => ({
    label: entry.label,
    files: entry.files.map((file) => {
      if (file.from === null) return file;
      const there = theirs.get(file.from);
      if (there === undefined) return { ...file, from: null };
      if (there !== old.get(file.from)) said.removedChanged.push(file.path);
      return file;
    }),
  }));

  // Where each saved skill went: its folder renamed, or removed as one entry.
  const fates = new Map<string, { folder: string; entry: number | null }>();
  for (const path of old.keys()) {
    const folder = skillFolderOf(path);
    if (!folder || path !== `${folder}SKILL.md`) continue;
    const kept = draft.files.find((file) => file.from === path);
    const now = kept ? skillFolderOf(kept.path) : null;
    if (now && now !== folder) fates.set(folder, { folder: now, entry: null });
    if (kept) continue;
    const at = draft.removed.findIndex(
      (entry) => entry.label.endsWith('/') && entry.files.some((file) => file.from === path),
    );
    const removedAt = draft.removed[at]?.files.find((file) => file.from === path);
    const was = removedAt ? skillFolderOf(removedAt.path) : null;
    if (was) fates.set(folder, { folder: was, entry: at });
  }

  /** A file of theirs into the tree at `at`, unless a file of the person's is there. */
  const placeLive = (from: string, at: string, content: string) => {
    const here = live.findIndex((file) => file.path === at);
    const mine = live[here];
    if (mine) {
      if (mine.from === null) {
        live[here] = { ...mine, from };
        if (mine.content !== content) said.bothChanged.push(at);
      } else {
        entries.push({ label: at, files: [made(from, at, content)] });
        said.bothChanged.push(at);
      }
      return;
    }
    for (const entry of entries) {
      const k = entry.files.findIndex((file) => file.path === at);
      const removed = entry.files[k];
      if (!removed) continue;
      if (removed.from === null) {
        entry.files[k] = { ...removed, from };
        said.removedChanged.push(at);
      } else {
        live.push(made(from, at, content));
        said.bothChanged.push(at);
      }
      return;
    }
    live.push(made(from, at, content));
    if (at !== from) said.followed.push(at);
  };

  /** A file of theirs into a removed skill's entry, at `at`. */
  const join = (into: number, from: string, at: string, content: string) => {
    const entry = entries[into];
    if (!entry) return placeLive(from, at, content);
    const k = entry.files.findIndex((file) => file.path === at);
    const removed = entry.files[k];
    if (removed?.from === null) entry.files[k] = { ...removed, from };
    else if (removed) entries.push({ label: at, files: [made(from, at, content)] });
    else entry.files.push(made(from, at, content));
    said.removedChanged.push(at);
  };

  const claimed = new Set(
    [...draft.files, ...draft.removed.flatMap((entry) => entry.files)].map((file) => file.from),
  );
  for (const [path, content] of theirs) {
    if (old.has(path)) {
      // Every saved path is the person's to place, but for one no file names (never so).
      if (!claimed.has(path)) placeLive(path, path, content);
      continue;
    }
    const folder = skillFolderOf(path);
    const fate = folder ? fates.get(folder) : undefined;
    if (folder && fate) {
      const at = fate.folder + path.slice(folder.length);
      if (fate.entry === null) placeLive(path, at, content);
      else join(fate.entry, path, at, content);
      continue;
    }
    const into = entries.findIndex(
      (entry) => entry.label.endsWith('/') && path.startsWith(entry.label),
    );
    if (into !== -1) join(into, path, path, content);
    else placeLive(path, path, content);
  }

  return {
    draft: {
      baseVersion: latest.version,
      base: theirs,
      files: live,
      removed: entries.filter((entry) => entry.files.length > 0),
      nextId,
    },
    ...said,
  };
}

/**
 * The draft once `sent` is saved as `saved`: over the saved version, keeping what the person did
 * while the save was on its way (`current` against `sent`): edits, adds, renames, removals and
 * restores. Nothing saved shows as still changed, and what the save removed leaves Removed; a file
 * restored meanwhile is a new one, since the save took it away.
 */
export function afterSave(current: FactoryDraft, sent: FactoryDraft, saved: Version): FactoryDraft {
  const base = new Map(saved.files.map((file) => [file.path, file.content]));
  const sentAt = new Map(sent.files.map((file) => [file.id, file.path]));
  const sentAway = new Set(sent.removed.flatMap((entry) => entry.files.map((file) => file.id)));
  const fromSaved = (file: DraftFile): DraftFile => {
    const was = sentAt.get(file.id);
    return { ...file, from: was !== undefined && base.has(was) ? was : null };
  };
  const files = current.files.map(fromSaved);
  const removed = current.removed
    .map((entry) => ({
      label: entry.label,
      files: entry.files.filter((file) => !sentAway.has(file.id)).map(fromSaved),
    }))
    .filter((entry) => entry.files.length > 0);
  // A path the save stored that no file names (never so, as the cell stores what was sent).
  let nextId = current.nextId;
  const claimed = new Set(
    [...files, ...removed.flatMap((entry) => entry.files)].map((f) => f.from),
  );
  const taken = new Set(files.map((file) => file.path));
  for (const [path, content] of base) {
    if (!claimed.has(path) && !taken.has(path)) {
      files.push({ id: nextId++, from: path, path, content });
    }
  }
  return { baseVersion: saved.version, base, files, removed, nextId };
}

function replaced<T>(list: readonly T[], at: number, value: T): T[] {
  const copy = [...list];
  copy[at] = value;
  return copy;
}
