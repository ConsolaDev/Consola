import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendAutomationEntry,
  AUTOMATION_NAME_PATTERN,
  automationEntryText,
  isIgnoredFileName,
  LATER_FOLDERS,
  MAX_FACTORY_TEXT_BYTES,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  replaceAutomationEntry,
} from '@consola/factory-spec';
import type { FactoryFiles, SkillFileEntry } from '@consola/factory-spec';
import type { FactoryFolderHandle, FactoryFolderRead } from '../ports';

/** Workspace ids are generated tokens; anything else never reaches the filesystem as a path. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * One workspace's folder under `~/.consola/workspaces/<id>`: the home of its
 * factory (`factory.yml`, `automations/`, `agents/`, `skills/`, `environments/`) and of
 * slice 1's `runs/` and `checks/`. Under `~/.consola` with the worktrees rather
 * than in Consola's own state, so the files are text a person can keep with
 * their dotfiles. Keyed by id, not name, so renaming a workspace never orphans
 * them. `CONSOLA_FACTORY_DIR` replaces the `workspaces` folder — the seam tests use.
 */
export function workspaceDataDir(workspaceId: string): string {
  if (!WORKSPACE_ID.test(workspaceId))
    throw new Error(`Not a workspace id: ${JSON.stringify(workspaceId)}.`);
  const root = process.env.CONSOLA_FACTORY_DIR ?? path.join(os.homedir(), '.consola', 'workspaces');
  return path.join(root, workspaceId);
}

/** One workspace's `factory.yml`, in its data folder. */
export function workspaceFactoryPath(workspaceId: string): string {
  return path.join(workspaceDataDir(workspaceId), 'factory.yml');
}

const FACTORY_YML = 'factory.yml';
const AUTOMATION_FILE = /^(.+)\.yaml$/;
const AGENT_FILE = /^(.+)\.md$/;
/** `environments/<name>.yaml`, its name a name (slice 3-B): anything else there is a stray. */
const ENVIRONMENT_FILE = /^(.+)\.yaml$/;
const OVER = 'it is over 1 MB';
/** How much of a file one read takes: a small file is never given a buffer the size of the cap. */
const READ_CHUNK = 64 * 1024;
const NOT_A_FILE = 'it is not a regular file';
const DANGLING = 'its target is not there';

/** Why a file or folder whose real path leaves the folder's is not read, nor written through. */
const outsideWords = (relative: string) =>
  `\`${relative}\` links outside the factory folder; Consola reads only files inside it.`;

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `realpath`, or null where there is nothing to resolve: no such path, or a link whose target is gone. */
function realOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** `real` lies inside `realFolder` (and is not the folder itself). */
function isInside(realFolder: string, real: string): boolean {
  const relative = path.relative(realFolder, real);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Where `file` really is, and whether that is inside `realFolder`; null when it has no real path. */
function placeIn(realFolder: string, file: string): { real: string; inside: boolean } | null {
  const real = realOrNull(file);
  return real === null ? null : { real, inside: isInside(realFolder, real) };
}

/**
 * Where a path of a factory folder really is, every link resolved, and
 * whether that lies inside the folder's own real path: the one rule the
 * reader, its watch, its writes and Open share. A link that stays inside
 * the folder is fine; one that leaves it is never read (a folder can hold
 * other people's files, and a link could pull any of the person's into an
 * agent's prompt). Null when the path, or the folder, has no real path.
 * Throws as `realpath` does otherwise.
 */
export function locateInFolder(
  folderPath: string,
  file: string,
): { real: string; realFolder: string; inside: boolean } | null {
  const realFolder = realOrNull(folderPath);
  if (realFolder === null) return null;
  const place = placeIn(realFolder, file);
  return place && { ...place, realFolder };
}

/** A file's text, decoded as UTF-8 with a leading byte-order mark removed. */
function decode(bytes: Uint8Array): string {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The names in a folder that is there, dotfiles and leftovers left out, sorted; [] when it is not there. */
async function listNames(dir: string): Promise<fs.Dirent[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => !isIgnoredFileName(entry.name))
      .sort((a, b) => byName(a.name, b.name));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

type Bounded = { kind: 'bytes'; bytes: Uint8Array; over: boolean } | { kind: 'not-a-file' };

/**
 * The file at `file`, read no further than `limit + 1` bytes, so a large one
 * is never held: `over` says it holds more than `limit` (and `bytes` then
 * holds `limit + 1`). Opened without blocking, so a FIFO named like a file
 * never hangs the read; `noFollow` refuses a symlink. Throws as `open` does
 * (ENOENT when there is no file, or a link's target is gone).
 */
async function readBounded(file: string, limit: number, noFollow = false): Promise<Bounded> {
  const flags =
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (noFollow ? fs.constants.O_NOFOLLOW : 0);
  const handle = await fs.promises.open(file, flags);
  try {
    if (!(await handle.stat()).isFile()) return { kind: 'not-a-file' };
    const chunks: Buffer[] = [];
    let filled = 0;
    while (filled <= limit) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK, limit + 1 - filled));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, filled);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      filled += bytesRead;
    }
    return { kind: 'bytes', bytes: Buffer.concat(chunks, filled), over: filled > limit };
  } finally {
    await handle.close();
  }
}

/**
 * One line of the watch signature: a file's `[path, mtime, size, inode]`, a
 * folder's `[path, inode]` (its listing is in the signature entry by entry,
 * and its own mtime moves with every dotfile an editor writes beside a file),
 * or the path marked missing.
 */
function statLine(relative: string, stat: fs.Stats | null): string {
  if (!stat) return `${relative}\tmissing`;
  if (stat.isDirectory()) return `${relative}\tfolder\t${stat.ino}`;
  return `${relative}\t${stat.mtimeMs}\t${stat.size}\t${stat.ino}`;
}

/** `stat` (through links) or `lstat`, null where it throws: a link whose target is gone, a file deleted meanwhile. */
function statOrNull(file: string, follow: boolean): fs.Stats | null {
  try {
    return follow ? fs.statSync(file) : fs.lstatSync(file);
  } catch {
    return null;
  }
}

/** The names in a folder, dotfiles and leftovers left out, sorted; [] where it cannot be listed. */
function namesOrNone(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !isIgnoredFileName(name))
      .sort(byName);
  } catch {
    return [];
  }
}

/**
 * One workspace's factory folder: read, watched and written.
 *
 * It reads `factory.yml`, `automations/*`, `agents/*`, `skills/**` and
 * `environments/*` only:
 * dotfiles and what editors and the OS leave beside a file
 * (`isIgnoredFileName`), `runs/`, `checks/` and every other root entry are
 * not the factory's. `factory.yml` and the agent and automation files are read
 * through a symlink only while its real path stays inside the folder's
 * (`locateInFolder`); one that leaves it, or a folder of the four that
 * does, is `outside`, never read nor written through. An environment file is
 * read as an agent file is. Nothing inside
 * `skills/` is read through a link at all, so a skill can deliver nothing
 * from outside its folder.
 *
 * Watched by polling a signature rather than `fs.watch`: the folders and
 * files may not exist yet, and editors replace files atomically, both cases
 * event-based watching misses silently, which is the one failure a scheduler
 * cannot afford. The signature stats through links where the read follows
 * them, so an edit of a link's target inside the folder is seen; a link
 * that leaves it is one line of where it leads, so re-pointing it is seen
 * and an edit of what it leads to, which the read never reads, is not.
 */
export class FactoryFolder implements FactoryFolderHandle {
  public readonly filePath: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly folderPath: string,
    private readonly pollMs = 2000,
  ) {
    this.filePath = path.join(folderPath, FACTORY_YML);
  }

  public async read(): Promise<FactoryFolderRead> {
    const environments: Record<string, string> = {};
    const files: FactoryFiles = {
      factoryYml: null,
      automations: {},
      agents: {},
      skills: {},
      environments,
      stray: [],
      laterFolders: [],
      unread: [],
      outside: [],
    };
    // Every file is placed against the folder's own real path: a linked workspace folder is read whole.
    const realFolder = realOrNull(this.folderPath);
    if (realFolder === null) return { exists: false, files };
    const factoryYml = await this.readOne(FACTORY_YML, this.filePath, files, realFolder);
    files.factoryYml = factoryYml.text;
    await this.readTexts('automations', AUTOMATION_FILE, files.automations, files, realFolder);
    await this.readTexts('agents', AGENT_FILE, files.agents, files, realFolder);
    await this.readSkills(files, realFolder);
    await this.readTexts(
      'environments',
      ENVIRONMENT_FILE,
      environments,
      files,
      realFolder,
      (name) => AUTOMATION_NAME_PATTERN.test(name),
    );
    for (const folder of Object.keys(LATER_FOLDERS)) {
      if (statOrNull(path.join(this.folderPath, folder), true)?.isDirectory())
        files.laterFolders.push(folder);
    }
    files.stray.sort(byName);
    return { exists: factoryYml.exists, files };
  }

  /**
   * A text file through a link that stays inside the folder: its text, or
   * nothing when it is not there. A link whose target is not there is
   * unread, not gone: the link says the person still means it (a target
   * briefly missing must not remove an automation), and deleting the link is
   * what removes it. One whose real path leaves the folder is `outside`,
   * never read. Over `MAX_FACTORY_TEXT_BYTES`, not a regular file, or a read
   * that fails, it is unread, with the reason.
   */
  private async readOne(
    relative: string,
    file: string,
    files: FactoryFiles,
    realFolder: string,
  ): Promise<{ exists: boolean; text: string | null }> {
    let read: Bounded;
    try {
      const place = placeIn(realFolder, file);
      if (place === null) {
        if (!statOrNull(file, false)?.isSymbolicLink()) return { exists: false, text: null };
        files.unread.push({ path: relative, reason: DANGLING });
        return { exists: true, text: null };
      }
      if (!place.inside) {
        files.outside.push(relative);
        return { exists: true, text: null };
      }
      // The real path, never the link: a link re-pointed after the check is not followed.
      read = await readBounded(place.real, MAX_FACTORY_TEXT_BYTES, true);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { exists: false, text: null };
      files.unread.push({ path: relative, reason: describe(error) });
      return { exists: true, text: null };
    }
    if (read.kind === 'not-a-file') {
      files.unread.push({ path: relative, reason: NOT_A_FILE });
      return { exists: true, text: null };
    }
    if (read.over) {
      files.unread.push({ path: relative, reason: OVER });
      return { exists: true, text: null };
    }
    return { exists: true, text: decode(read.bytes) };
  }

  /**
   * `automations/<name>.yaml`, `agents/<name>.md` or `environments/<name>.yaml`,
   * by name; anything else in the folder, or a name `named` refuses, is a stray.
   */
  private async readTexts(
    folder: 'automations' | 'agents' | 'environments',
    pattern: RegExp,
    into: Record<string, string>,
    files: FactoryFiles,
    realFolder: string,
    named: (name: string) => boolean = () => true,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      if (this.folderLeaves(folder, files, realFolder)) return;
      entries = await listNames(path.join(this.folderPath, folder));
    } catch (error) {
      files.unread.push({ path: `${folder}/`, reason: describe(error) });
      return;
    }
    for (const entry of entries) {
      const relative = `${folder}/${entry.name}`;
      const name = pattern.exec(entry.name)?.[1];
      if (name === undefined || !named(name)) {
        files.stray.push(relative);
        continue;
      }
      const read = await this.readOne(
        relative,
        path.join(this.folderPath, relative),
        files,
        realFolder,
      );
      if (read.text !== null) into[name] = read.text;
    }
  }

  /** One of the four folders links outside: it is `outside`, and not listed. Throws as `realpath` does. */
  private folderLeaves(folder: string, files: FactoryFiles, realFolder: string): boolean {
    const place = placeIn(realFolder, path.join(this.folderPath, folder));
    if (place === null || place.inside) return false;
    files.outside.push(`${folder}/`);
    return true;
  }

  /** Each folder in `skills/` is a skill, walked without following a link; anything else there is a stray. */
  private async readSkills(files: FactoryFiles, realFolder: string): Promise<void> {
    const root = path.join(this.folderPath, 'skills');
    let entries: fs.Dirent[];
    try {
      if (this.folderLeaves('skills', files, realFolder)) return;
      entries = await listNames(root);
    } catch (error) {
      files.unread.push({ path: 'skills/', reason: describe(error) });
      return;
    }
    for (const entry of entries) {
      // A Dirent is the entry itself, never a link's target: a linked folder is no skill folder.
      if (!entry.isDirectory()) {
        files.stray.push(`skills/${entry.name}`);
        continue;
      }
      const skill: SkillFileEntry[] = [];
      const budget = { bytes: MAX_SKILL_BYTES + 1 };
      // A skill whose folder cannot be listed is unread, not a skill with no files.
      if (await this.walkSkill(entry.name, '', skill, budget, files))
        files.skills[entry.name] = skill;
    }
  }

  /**
   * One folder of a skill, depth-first and sorted, by `lstat`: a regular
   * file's bytes, a symlink or anything else as what it is, never read. It
   * stops past `MAX_SKILL_FILES` entries or `MAX_SKILL_BYTES`, so the
   * validator sees "over" without this holding more. False when this folder
   * could not be listed (it is then unread).
   */
  private async walkSkill(
    skillName: string,
    inside: string,
    skill: SkillFileEntry[],
    budget: { bytes: number },
    files: FactoryFiles,
  ): Promise<boolean> {
    const full = (relative: string) =>
      path.join(this.folderPath, 'skills', skillName, ...relative.split('/'));
    let names: string[];
    try {
      names = (await fs.promises.readdir(full(inside)))
        .filter((name) => !isIgnoredFileName(name))
        .sort(byName);
    } catch (error) {
      files.unread.push({
        path: `skills/${skillName}/${inside === '' ? '' : `${inside}/`}`,
        reason: describe(error),
      });
      return false;
    }
    for (const name of names) {
      if (skill.length > MAX_SKILL_FILES || budget.bytes <= 0) break;
      const relative = inside === '' ? name : `${inside}/${name}`;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(full(relative));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        files.unread.push({ path: `skills/${skillName}/${relative}`, reason: describe(error) });
        continue;
      }
      if (stat.isDirectory()) {
        await this.walkSkill(skillName, relative, skill, budget, files);
      } else if (stat.isSymbolicLink()) {
        skill.push({ path: relative, kind: 'symlink' });
      } else if (!stat.isFile()) {
        skill.push({ path: relative, kind: 'special' });
      } else {
        try {
          // No further than the skill's budget: past it, one byte more says "over".
          const read = await readBounded(full(relative), budget.bytes - 1, true);
          if (read.kind === 'not-a-file') {
            skill.push({ path: relative, kind: 'special' });
            continue;
          }
          budget.bytes -= read.bytes.length;
          skill.push({ path: relative, bytes: new Uint8Array(read.bytes) });
        } catch (error) {
          const code = errorCode(error);
          if (code === 'ENOENT') continue;
          // A file replaced by a link between the listing and the read.
          if (code === 'ELOOP') skill.push({ path: relative, kind: 'symlink' });
          else
            files.unread.push({ path: `skills/${skillName}/${relative}`, reason: describe(error) });
        }
      }
    }
    return true;
  }

  /**
   * What the poll compares: `factory.yml`, the four folders and each entry of
   * `automations/`, `agents/` and `environments/` by `stat` (through links), each entry under
   * `skills/` by `lstat` (a link there is refused anyway), bounded as the
   * read is, and which later folders exist. A path whose stat fails counts as
   * missing. Never throws.
   */
  private signature(): string {
    let realFolder: string | null = null;
    try {
      realFolder = realOrNull(this.folderPath);
    } catch {
      // Unresolvable now: every line below reads as the stats give it.
    }
    // A path that links outside is one line: where it leads. Its target is never read, so an
    // edit of it changes nothing; re-pointing the link does.
    const outsideLine = (relative: string, file: string): string | null => {
      if (realFolder === null) return null;
      try {
        const place = placeIn(realFolder, file);
        return place && !place.inside ? `${relative}\toutside\t${place.real}` : null;
      } catch {
        return null;
      }
    };
    const line = (relative: string, file: string) =>
      outsideLine(relative, file) ?? statLine(relative, statOrNull(file, true));
    const lines: string[] = [line(FACTORY_YML, this.filePath)];
    for (const folder of ['automations', 'agents', 'environments']) {
      const dir = path.join(this.folderPath, folder);
      const leaves = outsideLine(`${folder}/`, dir);
      lines.push(leaves ?? statLine(`${folder}/`, statOrNull(dir, true)));
      if (leaves !== null) continue;
      for (const name of namesOrNone(dir))
        lines.push(line(`${folder}/${name}`, path.join(dir, name)));
    }
    const skills = path.join(this.folderPath, 'skills');
    const skillsLeave = outsideLine('skills/', skills);
    lines.push(skillsLeave ?? statLine('skills/', statOrNull(skills, true)));
    for (const name of skillsLeave === null ? namesOrNone(skills) : []) {
      const stat = statOrNull(path.join(skills, name), false);
      lines.push(statLine(`skills/${name}`, stat));
      if (stat?.isDirectory()) this.skillLines(path.join(skills, name), `skills/${name}`, lines);
    }
    for (const folder of Object.keys(LATER_FOLDERS)) {
      if (statOrNull(path.join(this.folderPath, folder), true)?.isDirectory())
        lines.push(`later\t${folder}`);
    }
    return lines.join('\n');
  }

  private skillLines(dir: string, relative: string, lines: string[], count = { entries: 0 }): void {
    for (const name of namesOrNone(dir)) {
      if (count.entries > MAX_SKILL_FILES) return;
      count.entries += 1;
      const stat = statOrNull(path.join(dir, name), false);
      lines.push(statLine(`${relative}/${name}`, stat));
      if (stat?.isDirectory())
        this.skillLines(path.join(dir, name), `${relative}/${name}`, lines, count);
    }
  }

  public watch(onChange: () => void): void {
    if (this.timer) return;
    let last = this.signature();
    this.timer = setInterval(() => {
      const next = this.signature();
      if (next === last) return;
      last = next;
      onChange();
    }, this.pollMs);
    this.timer.unref?.();
  }

  public unwatch(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Create `factory.yml` from `template` if missing; returns its path. */
  public async ensureExists(template: string): Promise<string> {
    await fs.promises.mkdir(this.folderPath, { recursive: true });
    try {
      await fs.promises.writeFile(this.filePath, template, { flag: 'wx' });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    return this.filePath;
  }

  /** `factory.yml` as written, or null when there is none yet. Refused when it links outside the folder. */
  public async readText(): Promise<string | null> {
    const real = this.realInside(FACTORY_YML, this.filePath);
    if (real === null) return null;
    try {
      return await fs.promises.readFile(real, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * `automations/<name>.yaml` as written (a leading byte-order mark removed),
   * or null when there is none. Refused when it links outside the folder.
   */
  public async readAutomationFile(name: string): Promise<string | null> {
    const file = this.automationFile(name);
    const real = this.realInside(`automations/${name}.yaml`, file);
    if (real === null) return null;
    try {
      return decode(await fs.promises.readFile(real));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * `file`'s real path when it lies inside the folder; null when it has none
   * (not there yet). Throws, in the reader's words, when it links outside.
   */
  private realInside(relative: string, file: string): string | null {
    const place = locateInFolder(this.folderPath, file);
    if (place === null) return null;
    if (!place.inside) throw new Error(outsideWords(relative));
    return place.real;
  }

  /** Where an entry of that name is written now, read now: `factory.yml` first, then its own file. */
  public async whereIs(name: string): Promise<'factory.yml' | 'file' | null> {
    const text = await this.readText();
    if (text !== null && automationEntryText(text, name) !== null) return 'factory.yml';
    const file = statOrNull(this.automationFile(name), true);
    return file?.isFile() ? 'file' : null;
  }

  /**
   * Add one automation at the end of `factory.yml`'s list, leaving every other
   * entry and comment as the person wrote it.
   */
  public async appendAutomation(entryYaml: string): Promise<void> {
    await this.rewrite(this.filePath, (text) => appendAutomationEntry(text, entryYaml));
  }

  /** Swap the automation called `name` in `factory.yml` for `entryYaml`, every byte outside it kept. */
  public async replaceAutomation(name: string, entryYaml: string): Promise<void> {
    await this.rewrite(this.filePath, (text) => replaceAutomationEntry(text, name, entryYaml));
  }

  /**
   * `automations/<name>.yaml`, written whole: created with its folder, or
   * replaced through a link that stays inside the folder. One that links
   * outside is refused, and nothing is written.
   */
  public async writeAutomationFile(name: string, text: string): Promise<void> {
    const file = this.automationFile(name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const target = this.realInside(`automations/${name}.yaml`, file) ?? file;
    await this.replaceWhole(target, text);
  }

  /** The absolute path of one of the folder's own files; null for any other path. */
  public pathOf(relative: string): string | null {
    const named = (name: string | undefined) =>
      name !== undefined && AUTOMATION_NAME_PATTERN.test(name);
    const own =
      relative === FACTORY_YML ||
      named(/^automations\/([^/]+)\.yaml$/.exec(relative)?.[1]) ||
      named(/^agents\/([^/]+)\.md$/.exec(relative)?.[1]) ||
      named(/^skills\/([^/]+)\/SKILL\.md$/.exec(relative)?.[1]) ||
      named(/^environments\/([^/]+)\.yaml$/.exec(relative)?.[1]);
    return own ? path.join(this.folderPath, relative) : null;
  }

  private automationFile(name: string): string {
    if (!AUTOMATION_NAME_PATTERN.test(name))
      throw new Error(`Not an automation name: ${JSON.stringify(name)}.`);
    return path.join(this.folderPath, 'automations', `${name}.yaml`);
  }

  /**
   * `factory.yml` edited whole, through a symlink that stays inside the
   * folder (it stays a link); one that links outside is refused. An edit
   * that throws leaves the file as it was.
   */
  private async rewrite(file: string, edit: (text: string) => string): Promise<void> {
    const target = this.realInside(FACTORY_YML, file) ?? (await fs.promises.realpath(file));
    await this.replaceWhole(target, edit(await fs.promises.readFile(target, 'utf8')));
  }

  /**
   * Written through a temporary file beside it, then renamed over it, so a
   * read never sees half of it. The temporary file is a dotfile, which the
   * read and the watch leave out.
   */
  private async replaceWhole(target: string, text: string): Promise<void> {
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.tmp`,
    );
    await fs.promises.writeFile(temporary, text);
    await fs.promises.rename(temporary, target);
  }
}
